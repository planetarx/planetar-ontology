/*
 * publish.ts — publish synthetic vessel envelopes to planetar-broker.
 *
 * For live testing of the ingest path without the real AIS feed. Connects to
 * the broker PUB port (default 127.0.0.1:12001) and writes framed envelopes.
 */

import net from "node:net";
import { encodeEnvelope, frame } from "../src/codec/zmesg.ts";

const host = process.env.PLANETAR_BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.PLANETAR_PUB_PORT ?? 12001);

const vessels = [
  { mmsi: 316001234, name: "MV Northern Light", lat: 48.42, lon: -123.37, sog: 12.3, cog: 271 },
  { mmsi: 316005678, name: "MV Salish Sea", lat: 48.40, lon: -123.41, sog: 8.1, cog: 95 },
  { mmsi: 316009999, name: "FV Cape Flattery", lat: 48.38, lon: -123.45, sog: 4.5, cog: 180 },
];

const sock = net.connect(port, host, () => {
  for (const v of vessels) {
    const payload = Buffer.from(
      JSON.stringify({ type: "planetar:Vessel", confidence: 1.0, ...v }),
    );
    const env = encodeEnvelope({
      topic: `entity.vessel.${v.mmsi}`,
      source: "src:planetar-ais@2.1.0",
      schemaName: "planetar:Vessel@1.3.0",
      payload,
    });
    sock.write(frame(env));
  }
  console.log(`published ${vessels.length} synthetic vessel envelopes to ${host}:${port}`);
  sock.end();
});

sock.on("error", (e: Error) => {
  console.error(`publish failed: ${e.message} (is planetar-broker running?)`);
  process.exit(1);
});
