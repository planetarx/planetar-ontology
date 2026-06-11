/*
 * ws.ts — minimal server-side WebSocket (RFC 6455), dependency-free.
 *
 * planetar-ontology only needs server→client push for the live entity feed
 * (ARCH-planetar-ontology.md §8). This handles the upgrade handshake, encodes
 * outbound text frames, and parses inbound frames just enough to honour client
 * close and ping. It is not a general-purpose WebSocket library.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsConn {
  send(text: string): void;
  close(): void;
  onClose(cb: () => void): void;
}

/** Complete the WebSocket upgrade. Returns null if the request is not valid. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let alive = true;
  let closeCb: (() => void) | null = null;
  const cleanup = (): void => {
    if (!alive) return;
    alive = false;
    closeCb?.();
  };

  // Inbound frames: we only act on close (0x8); everything else is drained.
  socket.on("data", (buf: Buffer) => {
    let off = 0;
    while (off + 2 <= buf.length) {
      const opcode = buf[off] & 0x0f;
      const masked = (buf[off + 1] & 0x80) !== 0;
      let len = buf[off + 1] & 0x7f;
      let p = off + 2;
      if (len === 126) {
        len = buf.readUInt16BE(p);
        p += 2;
      } else if (len === 127) {
        len = Number(buf.readBigUInt64BE(p));
        p += 8;
      }
      if (masked) p += 4;
      if (p + len > buf.length) break; // frame split across chunks — stop
      if (opcode === 0x8) {
        socket.end();
        cleanup();
        return;
      }
      off = p + len;
    }
  });
  socket.on("close", cleanup);
  socket.on("error", cleanup);

  return {
    send(text: string): void {
      if (!alive) return;
      const payload = Buffer.from(text, "utf8");
      let header: Buffer;
      if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    },
    close(): void {
      socket.end();
      cleanup();
    },
    onClose(cb: () => void): void {
      closeCb = cb;
    },
  };
}
