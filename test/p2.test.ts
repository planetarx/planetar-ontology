/*
 * p2.test.ts — identity resolution, merge, and provenance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/store.ts";
import { Registry } from "../src/registry/registry.ts";
import { Resolver } from "../src/resolve/resolve.ts";
import { uuid7, uuidToString } from "../src/codec/zmesg.ts";

const ts = (): bigint => BigInt(Date.now()) * 1_000_000n;
const oid = (): string => uuidToString(uuid7());

function setup() {
  const store = new Store(":memory:");
  const registry = Registry.load();
  return { store, resolver: new Resolver(store, registry) };
}

test("first observation of a vessel creates a new canonical entity", () => {
  const { store, resolver } = setup();
  const r = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, name: "MV Northern Light", length_m: 184 },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );
  assert.equal(r.action, "new");
  assert.equal(store.count("entity"), 1);

  const ent = store.getEntity(r.entityId);
  assert.ok(ent);
  assert.equal(ent.type, "planetar:Vessel");
  assert.equal(ent.body.mmsi, 316001234);
  assert.equal(ent.name, "MV Northern Light");
  assert.equal(ent.provenance.mmsi.src, "src:planetar-ais@2.1.0");
  store.close();
});

test("a second observation with the same MMSI merges into the same entity", () => {
  const { store, resolver } = setup();
  const a = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, name: "MV Northern Light" },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );
  const b = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, sog: 12.3 },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );
  assert.equal(b.action, "merge");
  assert.equal(b.entityId, a.entityId);
  assert.equal(store.count("entity"), 1);

  const ent = store.getEntity(a.entityId);
  assert.ok(ent);
  assert.equal(ent.body.sog, 12.3); // new field folded in
  assert.equal(ent.body.name, "MV Northern Light"); // prior field retained
  store.close();
});

test("higher-confidence claim wins and records a discrepancy", () => {
  const { store, resolver } = setup();
  const a = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, length_m: 180 },
    oid(), "src:planetar-sat@1.4.0", ts(), 0.6,
  );
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, length_m: 184 },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );
  const ent = store.getEntity(a.entityId);
  assert.ok(ent);
  assert.equal(ent.body.length_m, 184); // higher-confidence value chosen
  assert.equal(ent.provenance.length_m.src, "src:planetar-ais@2.1.0");
  assert.equal(store.count("discrepancy"), 1);
  store.close();
});

test("lower-confidence conflicting claim loses but still records a discrepancy", () => {
  const { store, resolver } = setup();
  const a = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, length_m: 184 },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, length_m: 150 },
    oid(), "src:planetar-sat@1.4.0", ts(), 0.6,
  );
  const ent = store.getEntity(a.entityId);
  assert.ok(ent);
  assert.equal(ent.body.length_m, 184); // original, higher-confidence value retained
  assert.equal(store.count("discrepancy"), 1);
  store.close();
});

test("distinct MMSIs produce distinct entities", () => {
  const { store, resolver } = setup();
  resolver.resolve("planetar:Vessel", { type: "planetar:Vessel", mmsi: 1 }, oid(), "s", ts(), 1.0);
  resolver.resolve("planetar:Vessel", { type: "planetar:Vessel", mmsi: 2 }, oid(), "s", ts(), 1.0);
  assert.equal(store.count("entity"), 2);
  store.close();
});

test("matching across identifiers — a later IMO claim unifies the entity", () => {
  const { store, resolver } = setup();
  // first sighting: MMSI + IMO
  const a = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, imo: 9123456 },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );
  // later sighting carries only the IMO — still resolves to the same entity
  const b = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", imo: 9123456, name: "MV Northern Light" },
    oid(), "src:planetar-sat@1.4.0", ts(), 0.9,
  );
  assert.equal(b.action, "merge");
  assert.equal(b.entityId, a.entityId);
  assert.equal(store.count("entity"), 1);
  store.close();
});
