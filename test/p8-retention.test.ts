/*
 * p8-retention.test.ts — merge semantics that don't freeze or bloat:
 * newest-wins tie-break, discrepancies only across sources, and bounded
 * observation/discrepancy retention.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/store.ts";
import { Registry } from "../src/registry/registry.ts";
import { Resolver } from "../src/resolve/resolve.ts";
import { uuid7, uuidToString } from "../src/codec/zmesg.ts";

const oid = (): string => uuidToString(uuid7());

let clock = 1_700_000_000_000_000_000n;
const nextNs = (): bigint => (clock += 1_000_000_000n);

function setup(): { store: Store; resolver: Resolver } {
  const store = new Store(":memory:");
  return { store, resolver: new Resolver(store, Registry.load()) };
}

test("same source, same confidence: newer value supersedes, no discrepancy", () => {
  const { store, resolver } = setup();
  const a = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, lat: 48.40, sog: 11.0 },
    oid(), "planetar-ais", nextNs(), 0.5,
  );
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, lat: 48.41, sog: 11.5 },
    oid(), "planetar-ais", nextNs(), 0.5,
  );
  const ent = store.getEntity(a.entityId)!;
  assert.equal(ent.body.lat, 48.41); // the live feed moves its entity
  assert.equal(ent.body.sog, 11.5);
  assert.equal(store.count("discrepancy"), 0); // supersession is not a conflict
  store.close();
});

test("stale same-source replay does not roll an entity backwards", () => {
  const { store, resolver } = setup();
  const t1 = nextNs();
  const t2 = nextNs();
  const a = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, lat: 48.41 },
    oid(), "planetar-ais", t2, 0.5,
  );
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, lat: 48.40 },
    oid(), "planetar-ais", t1, 0.5, // older than what the entity holds
  );
  assert.equal(store.getEntity(a.entityId)!.body.lat, 48.41);
  store.close();
});

test("cross-source disagreement still records a discrepancy", () => {
  const { store, resolver } = setup();
  const a = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, length_m: 180 },
    oid(), "planetar-ais", nextNs(), 0.5,
  );
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, length_m: 184 },
    oid(), "planetar-sat", nextNs(), 0.5,
  );
  assert.equal(store.count("discrepancy"), 1);
  assert.equal(store.getEntity(a.entityId)!.body.length_m, 184); // equal conf, newer wins
  store.close();
});

test("observation prune keeps the newest N plus provenance-referenced rows", () => {
  const { store, resolver } = setup();
  // the entity's fields point at this first observation
  const protectedObs = oid();
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, name: "MV Northern Light" },
    protectedObs, "planetar-ais", nextNs(), 0.5,
  );
  store.insertObservation({
    id: protectedObs, entityId: null, type: "planetar:Vessel",
    source: "planetar-ais", topic: "vessel.ais.position",
    tsNs: nextNs(), confidence: 0.5, body: {},
  });
  const unprotected: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = oid();
    unprotected.push(id);
    store.insertObservation({
      id, entityId: null, type: "planetar:Detection",
      source: "planetar-sat", topic: "sar.chip",
      tsNs: nextNs(), confidence: 0.8, body: { i },
    });
  }

  store.pruneObservations(5);
  // protected row survives even though it is the oldest
  assert.ok(store.getObservation(protectedObs));
  // newest 5 unprotected survive, the rest are gone
  assert.equal(store.getObservation(unprotected[0]), null);
  assert.ok(store.getObservation(unprotected[19]));
  assert.equal(store.count("observation"), 6);
  store.close();
});

test("discrepancy prune keeps the newest N by insertion order", () => {
  const { store, resolver } = setup();
  const mk = (len: number, src: string): void => {
    resolver.resolve(
      "planetar:Vessel",
      { type: "planetar:Vessel", mmsi: 316001234, length_m: len },
      oid(), src, nextNs(), 0.5,
    );
  };
  mk(100, "src-a");
  for (let i = 1; i <= 10; i++) mk(100 + i, i % 2 ? "src-b" : "src-a");
  assert.equal(store.count("discrepancy"), 10);
  store.pruneDiscrepancies(3);
  assert.equal(store.count("discrepancy"), 3);
  store.close();
});
