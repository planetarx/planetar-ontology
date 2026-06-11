/*
 * p1.test.ts — synthetic tests for P1. No broker required.
 *
 * Proves the P1 deliverable: an envelope decodes, classifies, and persists to
 * the SQLite object store, end to end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeEnvelope,
  decodeEnvelope,
  frame,
  uuid7,
  uuidToString,
  ZMESG_MAGIC,
} from "../src/codec/zmesg.ts";
import { Registry } from "../src/registry/registry.ts";
import { Store } from "../src/store/store.ts";

test("zmesg codec round-trips an envelope", () => {
  const payload = Buffer.from(
    JSON.stringify({ type: "planetar:Vessel", mmsi: 316001234, name: "MV Northern Light" }),
  );
  const raw = encodeEnvelope({
    topic: "entity.vessel.316001234",
    source: "src:planetar-ais@2.1.0",
    schemaName: "planetar:Vessel@1.3.0",
    payload,
  });
  assert.equal(raw.readUInt32LE(0), ZMESG_MAGIC);

  const d = decodeEnvelope(raw);
  assert.equal(d.version, 1);
  assert.equal(d.topic, "entity.vessel.316001234");
  assert.equal(d.source, "src:planetar-ais@2.1.0");
  assert.equal(d.schemaName, "planetar:Vessel@1.3.0");
  assert.deepEqual(JSON.parse(d.payload.toString()), {
    type: "planetar:Vessel",
    mmsi: 316001234,
    name: "MV Northern Light",
  });
});

test("uuid7 produces a valid v7 UUID string", () => {
  const s = uuidToString(uuid7());
  assert.match(s, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("frame prefixes a big-endian length", () => {
  const env = encodeEnvelope({
    topic: "t",
    source: "s",
    schemaName: "x",
    payload: Buffer.from("hi"),
  });
  const f = frame(env);
  assert.equal(f.readUInt32BE(0), env.length);
  assert.deepEqual(f.subarray(4), env);
});

test("decodeEnvelope rejects a bad magic", () => {
  assert.throws(() => decodeEnvelope(Buffer.alloc(80)), /bad magic/);
});

test("registry classifies AIS and detection envelopes as observations", () => {
  const reg = Registry.load();

  const vessel = reg.classify("entity.vessel.316001234", { type: "planetar:Vessel" });
  assert.equal(vessel.kind, "observation");
  assert.equal(vessel.type, "planetar:Vessel");

  // classify by topic prefix when the body declares no type
  const eo = reg.classify("eo.detection.cam1", { confidence: 0.8 });
  assert.equal(eo.kind, "observation");
  assert.equal(eo.type, "planetar:Detection");

  const action = reg.classify("action.confirm", { type: "planetar:ConfirmDarkVessel" });
  assert.equal(action.kind, "action");

  const unknown = reg.classify("weather.victoria", { temp: 11 });
  assert.equal(unknown.kind, "unknown");
});

test("end-to-end: envelope decodes, classifies, and persists to the store", () => {
  const store = new Store(":memory:");
  const reg = Registry.load();

  const payload = Buffer.from(
    JSON.stringify({
      type: "planetar:Vessel",
      mmsi: 316001234,
      name: "MV Test",
      confidence: 0.91,
    }),
  );
  const raw = encodeEnvelope({
    topic: "entity.vessel.316001234",
    source: "src:planetar-ais@2.1.0",
    schemaName: "planetar:Vessel@1.3.0",
    payload,
  });

  const env = decodeEnvelope(raw);
  const body = JSON.parse(env.payload.toString()) as Record<string, unknown>;
  const cls = reg.classify(env.topic, body);

  const record = {
    id: env.id,
    entityId: null,
    type: cls.type,
    source: env.source,
    topic: env.topic,
    tsNs: env.createdAtNs,
    confidence: 0.91,
    body,
  };
  store.insertObservation(record);
  assert.equal(store.count("observation"), 1);

  // idempotent: replaying the same envelope id does not duplicate
  store.insertObservation(record);
  assert.equal(store.count("observation"), 1);

  // a second, distinct envelope adds a row
  store.insertObservation({ ...record, id: uuidToString(uuid7()) });
  assert.equal(store.count("observation"), 2);

  store.close();
});
