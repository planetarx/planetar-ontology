/*
 * broker.ts — planetar-broker TCP subscriber + frame reader.
 *
 * Connects to the broker SUB port (default 127.0.0.1:12002), sends a one-line
 * `SUB <topic>...` handshake, and reads the broker's `OK\n` / `ERR ...\n`
 * reply line. After `OK`, subsequent bytes are `[4-byte BE length][zmesg
 * envelope]` frames. Reconnects with exponential backoff. The hot path stays
 * in C; this is a warm-path consumer (ARCH-planetar-ontology.md §2).
 */

import net from "node:net";

export interface BrokerOptions {
  host?: string;
  port?: number;
  topics?: string[];
  onEnvelope: (envelope: Buffer) => void;
  onStatus?: (message: string) => void;
}

export interface BrokerConnection {
  close: () => void;
}

export function connectBroker(opts: BrokerOptions): BrokerConnection {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 12002;
  const topics = opts.topics && opts.topics.length ? opts.topics : ["**"];
  const status = (m: string) => opts.onStatus?.(m);

  let sock: net.Socket | null = null;
  let closed = false;
  let backoff = 250;

  const connect = (): void => {
    if (closed) return;
    let buf = Buffer.alloc(0);
    let subscribed = false; // false until the broker's OK\n line is consumed

    sock = net.connect(port, host, () => {
      backoff = 250;
      status(`connected ${host}:${port}`);
      sock!.write(`SUB ${topics.join(" ")}\n`);
    });

    sock.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      // Handshake: the broker replies one line — "OK\n" or "ERR <reason>\n" —
      // before any frames. Consume it before switching to frame parsing.
      if (!subscribed) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return; // reply line not yet complete
        const line = buf.toString("utf8", 0, nl).trimEnd();
        buf = buf.subarray(nl + 1);
        if (line !== "OK") {
          status(`SUB rejected: ${line}`);
          sock!.destroy();
          return;
        }
        subscribed = true;
        status(`subscribed [${topics.join(" ")}]`);
      }

      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const env = buf.subarray(4, 4 + len);
        try {
          opts.onEnvelope(env);
        } catch (e) {
          status(`onEnvelope threw: ${(e as Error).message}`);
        }
        buf = buf.subarray(4 + len);
      }
    });

    sock.on("error", (e: Error) => status(`socket error: ${e.message}`));

    sock.on("close", () => {
      if (closed) return;
      status(`disconnected, retry in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    });
  };

  connect();
  return {
    close: () => {
      closed = true;
      sock?.destroy();
    },
  };
}
