/*
 * demo-reid.ts — deterministic multi-sensor dark-vessel re-identification demo.
 *
 * The CH13 / DIANA flagship story, made reproducible:
 *   1. A vessel sends its last AIS fix, then goes dark (transponder off).
 *   2. 40 min later a satellite SAR detection with NO MMSI appears where the
 *      vessel would have drifted — the ontology dead-reckons every known track
 *      and re-identifies it (link #1).
 *   3. 20 min after that an electro-optical (EO) detection re-acquires the same
 *      hull again (link #2) — cross-sensor re-ID on one canonical entity.
 *
 * Publishes onto planetar-broker PUB (:12001). Run the ontology against the same
 * broker (SUB :12002, API :4000), then inspect:
 *   curl -s localhost:4000/objects/planetar:Vessel
 *   curl -s localhost:4000/objects/planetar:Vessel/<id>/links/reacquisition
 *
 * Timestamps are set explicitly so the scenario is the same every run (no
 * real-world waiting). For a clean slate, point the ontology at a throwaway DB:
 *   PLANETAR_ONTOLOGY_DB=/tmp/demo-reid.db npm start
 */

import net from "node:net";
import { encodeEnvelope, frame } from "../src/codec/zmesg.ts";
import { projectPosition } from "../src/resolve/kinematics.ts";

const host = process.env.PLANETAR_BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.PLANETAR_PUB_PORT ?? 12001);

const MIN_MS = 60_000;
const nowMs = Date.now();
const nsOf = (ms: number): bigint => BigInt(Math.trunc(ms)) * 1_000_000n;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The dark vessel: last AIS fix 60 min ago, then dark.
// Course 045° (NE into open Georgia Strait) keeps the drifted detections well
// clear of the live Victoria fleet, so the re-ID match is unambiguous.
const vessel = { mmsi: 316007777, name: "MV Shadow Runner", lat: 48.62, lon: -123.18, cog: 45, sog: 11.5 };
const t0 = nowMs - 60 * MIN_MS; // last AIS fix
const t1 = nowMs - 20 * MIN_MS; // SAR pass
const t2 = nowMs; //               EO pass

// Dead-reckon where it drifts to — identical math to the matcher, so the
// detections land exactly on the projected track (high-confidence re-ID).
const p1 = projectPosition(vessel.lat, vessel.lon, vessel.cog, vessel.sog, (t1 - t0) / 3_600_000);
const p2 = projectPosition(p1.lat, p1.lon, vessel.cog, vessel.sog, (t2 - t1) / 3_600_000);

const scenarioId = `demo-reid-${vessel.mmsi}`;

function send(
  sock: net.Socket,
  o: { topic: string; source: string; schemaName: string; createdAtNs: bigint; body: Record<string, unknown> },
): void {
  const env = encodeEnvelope({
    topic: o.topic,
    source: o.source,
    schemaName: o.schemaName,
    correlationId: scenarioId,
    createdAtNs: o.createdAtNs,
    payload: Buffer.from(JSON.stringify(o.body)),
  });
  sock.write(frame(env));
}

const sock = net.connect(port, host, async () => {
  send(sock, {
    topic: `entity.vessel.${vessel.mmsi}`,
    source: "src:planetar-ais@2.1.0",
    schemaName: "planetar:Vessel@1.3.0",
    createdAtNs: nsOf(t0),
    body: { type: "planetar:Vessel", confidence: 1.0, ...vessel },
  });
  console.log(`[demo] AIS fix  t-60m  ${vessel.name} (MMSI ${vessel.mmsi}) @ ${vessel.lat.toFixed(3)},${vessel.lon.toFixed(3)} → goes dark`);
  await wait(1000);

  send(sock, {
    topic: "sar.chip",
    source: "src:planetar-sat@1.0.0",
    schemaName: "planetar:Detection@1.0.0",
    createdAtNs: nsOf(t1),
    body: { type: "planetar:Detection", confidence: 0.82, lat: p1.lat, lon: p1.lon },
  });
  console.log(`[demo] SAR hit  t-20m  no-MMSI detection @ ${p1.lat.toFixed(3)},${p1.lon.toFixed(3)} → expect re-ID #1`);
  await wait(1000);

  send(sock, {
    topic: "eo.detection",
    source: "src:planetar-eo@1.0.0",
    schemaName: "planetar:Detection@1.0.0",
    createdAtNs: nsOf(t2),
    body: { type: "planetar:Detection", confidence: 0.74, lat: p2.lat, lon: p2.lon },
  });
  console.log(`[demo] EO hit   now    no-MMSI detection @ ${p2.lat.toFixed(3)},${p2.lon.toFixed(3)} → expect re-ID #2`);
  await wait(800);

  console.log(`\n[demo] published. Verify the fused entity + cross-sensor re-ID links:`);
  console.log(`  curl -s localhost:4000/objects/planetar:Vessel | jq '.objects[] | select(.body.mmsi==${vessel.mmsi})'`);
  sock.end();
});

sock.on("error", (e: Error) => {
  console.error(`[demo] publish failed: ${e.message} (is the broker on ${host}:${port}?)`);
  process.exit(1);
});
