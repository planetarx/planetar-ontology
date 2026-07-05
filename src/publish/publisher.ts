/*
 * publisher.ts — P7: the ontology becomes a bus PRODUCER
 * (ARCH-planetar-flow-trace.md §9 "Future", now built).
 *
 * Every entity mutation (create / merge / kinematic reacquisition / Action
 * Type) is published back onto the bus as an `entity.<kind>.updated`
 * envelope whose `causation_id` is the observation envelope that triggered
 * it and whose `correlation_id` is the entity id. That makes layer 4 a
 * first-class participant: traces run *through* the graph (AIS ping →
 * merge → dark-vessel confirmation), and any consumer can react to entity
 * changes without knowing the ontology's API exists.
 *
 * The ingest loop must skip envelopes whose source is SELF_SOURCE (they are
 * still trace-indexed) — see index.ts — or the ontology would ingest its
 * own output forever.
 */

import net from "node:net";
import { encodeEnvelope, frame, uuidToString } from "../codec/zmesg.ts";
import type { EntityRecord } from "../store/store.ts";

export const SELF_SOURCE = "planetar-ontology";
export const ENTITY_UPDATED_SCHEMA = "planetar.entity.updated";

/** Where publish frames go — the TCP producer in prod, a capture in tests. */
export interface FrameSink {
  send(frameBytes: Buffer): void;
  close(): void;
}

export interface ProducerOptions {
  host?: string;
  port?: number;
  onStatus?: (message: string) => void;
}

/**
 * TCP client to the broker PUB port (default 12001). No handshake — the
 * broker takes `[4-byte BE length][zmesg envelope]` frames as soon as the
 * socket opens (same contract planetar-ais speaks). Frames sent while
 * disconnected are dropped, not queued: entity state is re-derivable from
 * the WAL, and a stale queue replayed after reconnect would be worse.
 */
export function connectProducer(opts: ProducerOptions = {}): FrameSink {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 12001;
  const status = (m: string) => opts.onStatus?.(m);

  let sock: net.Socket | null = null;
  let ready = false;
  let closed = false;
  let backoff = 250;

  const connect = (): void => {
    if (closed) return;
    sock = net.connect(port, host, () => {
      backoff = 250;
      ready = true;
      status(`producer connected ${host}:${port}`);
    });
    sock.on("error", (e: Error) => status(`producer error: ${e.message}`));
    sock.on("close", () => {
      ready = false;
      if (closed) return;
      status(`producer disconnected, retry in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    });
  };

  connect();
  return {
    send: (frameBytes) => {
      if (ready && sock) sock.write(frameBytes);
    },
    close: () => {
      closed = true;
      sock?.destroy();
    },
  };
}

/** `planetar:Vessel` → `entity.vessel.updated` (etc). */
export function entityUpdatedTopic(entityType: string): string {
  const kind = (entityType.split(":")[1] ?? entityType).toLowerCase();
  return `entity.${kind}.updated`;
}

export class EntityPublisher {
  #sink: FrameSink;

  constructor(sink: FrameSink) {
    this.#sink = sink;
  }

  /**
   * Publish one entity mutation. `action` is what happened ("created" |
   * "merged" | "reacquired" | "action:<ActionType>"); `causationId` is the
   * envelope id of the observation that triggered it ('' for API-initiated
   * actions, which have no bus-side cause). Returns the envelope id.
   */
  publishEntityUpdated(entity: EntityRecord, action: string, causationId: string): string {
    const payload = Buffer.from(
      JSON.stringify({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        action,
        updated_ns: entity.updatedNs.toString(),
        body: entity.body,
      }),
      "utf8",
    );
    const envBytes = encodeEnvelope({
      topic: entityUpdatedTopic(entity.type),
      source: SELF_SOURCE,
      schemaName: ENTITY_UPDATED_SCHEMA,
      schemaVersion: 1,
      correlationId: entity.id,
      causationId,
      payload,
    });
    this.#sink.send(frame(envBytes));
    // envelope id lives in bytes 8..24 of the fixed header (after magic,
    // version, flags, header_len) — decode just that for the return value
    return uuidToString(envBytes.subarray(8, 24));
  }
}
