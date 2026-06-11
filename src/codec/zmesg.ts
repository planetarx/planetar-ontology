/*
 * zmesg.ts — TypeScript codec for the zmesg envelope wire format.
 *
 * Mirrors zmesg.h (~/github/sness23/zmesg/zmesg.h). The envelope is a fixed
 * 66-byte little-endian header followed by five variable-length strings and a
 * payload. On the TCP bus each envelope is prefixed with a 4-byte BIG-endian
 * total-length frame — see memory `reference_broker_framing`: the envelope is
 * LE, the frame prefix is network byte order.
 *
 *   off  size  field
 *   ---  ----  -----
 *   0    4     magic (0x5A4D5347 "ZMSG")
 *   4    1     version
 *   5    1     flags
 *   6    2     header_len
 *   8    16    id (UUIDv7, raw)
 *   24   8     created_at_ns
 *   32   8     stored_at_ns
 *   40   8     published_at_ns
 *   48   2     topic_len
 *   50   2     source_len
 *   52   2     schema_name_len
 *   54   2     correlation_id_len
 *   56   2     causation_id_len
 *   58   4     schema_version
 *   62   4     payload_len
 *   66   ...   topic, source, schema_name, correlation_id, causation_id, payload
 */

import { randomFillSync } from "node:crypto";

export const ZMESG_MAGIC = 0x5a4d5347;
export const ZMESG_VERSION = 1;
export const ZMESG_FIXED_HDR = 66;

export interface ZmesgEnvelope {
  version: number;
  flags: number;
  id: string; // UUIDv7, canonical string form
  createdAtNs: bigint;
  storedAtNs: bigint;
  publishedAtNs: bigint;
  topic: string;
  source: string;
  schemaName: string;
  correlationId: string;
  causationId: string;
  schemaVersion: number;
  payload: Buffer;
}

export interface ZmesgInput {
  id?: Buffer; // 16 raw bytes; a fresh UUIDv7 is generated if omitted
  createdAtNs?: bigint;
  topic: string;
  source: string;
  schemaName: string;
  correlationId?: string;
  causationId?: string;
  schemaVersion?: number;
  payload: Buffer;
}

/** Format 16 raw bytes as a canonical UUID string. */
export function uuidToString(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Generate a UUIDv7 (time-ordered) as 16 raw bytes. */
export function uuid7(): Buffer {
  const b = Buffer.alloc(16);
  randomFillSync(b);
  const ms = BigInt(Date.now());
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  return b;
}

/** Decode one zmesg envelope (no frame prefix) from a buffer. */
export function decodeEnvelope(buf: Buffer): ZmesgEnvelope {
  if (buf.length < ZMESG_FIXED_HDR) {
    throw new Error(`zmesg: short envelope (${buf.length} < ${ZMESG_FIXED_HDR})`);
  }
  const magic = buf.readUInt32LE(0);
  if (magic !== ZMESG_MAGIC) {
    throw new Error(`zmesg: bad magic 0x${magic.toString(16)}`);
  }
  const version = buf.readUInt8(4);
  const flags = buf.readUInt8(5);
  const headerLen = buf.readUInt16LE(6);
  const id = uuidToString(buf.subarray(8, 24));
  const createdAtNs = buf.readBigUInt64LE(24);
  const storedAtNs = buf.readBigUInt64LE(32);
  const publishedAtNs = buf.readBigUInt64LE(40);
  const topicLen = buf.readUInt16LE(48);
  const sourceLen = buf.readUInt16LE(50);
  const schemaNameLen = buf.readUInt16LE(52);
  const corrLen = buf.readUInt16LE(54);
  const causLen = buf.readUInt16LE(56);
  const schemaVersion = buf.readUInt32LE(58);
  const payloadLen = buf.readUInt32LE(62);

  let off = ZMESG_FIXED_HDR;
  const take = (n: number): string => {
    const s = buf.toString("utf8", off, off + n);
    off += n;
    return s;
  };
  const topic = take(topicLen);
  const source = take(sourceLen);
  const schemaName = take(schemaNameLen);
  const correlationId = take(corrLen);
  const causationId = take(causLen);

  if (headerLen !== off) {
    throw new Error(`zmesg: header_len mismatch (${headerLen} != ${off})`);
  }
  if (off + payloadLen > buf.length) {
    throw new Error(`zmesg: payload overrun (${off + payloadLen} > ${buf.length})`);
  }
  const payload = buf.subarray(off, off + payloadLen);

  return {
    version, flags, id, createdAtNs, storedAtNs, publishedAtNs,
    topic, source, schemaName, correlationId, causationId, schemaVersion, payload,
  };
}

/** Encode a zmesg envelope (no frame prefix). */
export function encodeEnvelope(input: ZmesgInput): Buffer {
  const topic = Buffer.from(input.topic, "utf8");
  const source = Buffer.from(input.source, "utf8");
  const schemaName = Buffer.from(input.schemaName, "utf8");
  const corr = Buffer.from(input.correlationId ?? "", "utf8");
  const caus = Buffer.from(input.causationId ?? "", "utf8");
  const payload = input.payload;
  const id = input.id ?? uuid7();
  if (id.length !== 16) throw new Error("zmesg: id must be 16 bytes");

  const headerLen =
    ZMESG_FIXED_HDR + topic.length + source.length + schemaName.length + corr.length + caus.length;
  const buf = Buffer.alloc(headerLen + payload.length);

  const nowNs = BigInt(Date.now()) * 1_000_000n;
  buf.writeUInt32LE(ZMESG_MAGIC, 0);
  buf.writeUInt8(ZMESG_VERSION, 4);
  buf.writeUInt8(0, 5);
  buf.writeUInt16LE(headerLen, 6);
  id.copy(buf, 8);
  buf.writeBigUInt64LE(input.createdAtNs ?? nowNs, 24);
  buf.writeBigUInt64LE(0n, 32);
  buf.writeBigUInt64LE(nowNs, 40);
  buf.writeUInt16LE(topic.length, 48);
  buf.writeUInt16LE(source.length, 50);
  buf.writeUInt16LE(schemaName.length, 52);
  buf.writeUInt16LE(corr.length, 54);
  buf.writeUInt16LE(caus.length, 56);
  buf.writeUInt32LE(input.schemaVersion ?? 1, 58);
  buf.writeUInt32LE(payload.length, 62);

  let off = ZMESG_FIXED_HDR;
  for (const part of [topic, source, schemaName, corr, caus, payload]) {
    part.copy(buf, off);
    off += part.length;
  }
  return buf;
}

/** Wrap an envelope in the broker's 4-byte big-endian length frame. */
export function frame(env: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(env.length, 0);
  return Buffer.concat([prefix, env]);
}
