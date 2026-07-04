/*
 * p6-trace.test.ts — the envelope trace index and GET /trace/:id
 * (ARCH-planetar-flow-trace.md §4).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/store.ts";
import type { EnvelopeRecord } from "../src/store/store.ts";
import { Registry } from "../src/registry/registry.ts";
import { Resolver } from "../src/resolve/resolve.ts";
import { createApiServer } from "../src/api/server.ts";
import type { ApiServer } from "../src/api/server.ts";
import { uuid7, uuidToString } from "../src/codec/zmesg.ts";

const oid = (): string => uuidToString(uuid7());

let clock = 1_700_000_000_000_000_000n;
const nextNs = (): bigint => (clock += 1_000_000n);

function env(over: Partial<EnvelopeRecord> = {}): EnvelopeRecord {
  const created = over.createdNs ?? nextNs();
  return {
    id: oid(),
    topic: "eo.frame",
    source: "planetar-eo",
    schemaName: "planetar.eo.frame.v1",
    correlationId: null,
    causationId: null,
    createdNs: created,
    storedNs: created + 5_000n,
    publishedNs: created + 9_000n,
    ...over,
  };
}

interface Ctx {
  base: string;
  api: ApiServer;
  store: Store;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const store = new Store(":memory:");
  const registry = Registry.load();
  const api = createApiServer(store, registry);
  await new Promise<void>((resolve) => api.listen(0, resolve));
  const port = (api.server.address() as AddressInfo).port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, api, store });
  } finally {
    api.close();
    store.close();
  }
}

test("envelope index: insert is idempotent, prune keeps the newest N", () => {
  const store = new Store(":memory:");
  try {
    const first = env();
    store.insertEnvelope(first);
    store.insertEnvelope(first); // replay — must not throw or duplicate
    assert.equal(store.count("envelope"), 1);

    const rest: EnvelopeRecord[] = [];
    for (let i = 0; i < 29; i++) {
      const e = env();
      rest.push(e);
      store.insertEnvelope(e);
    }
    assert.equal(store.count("envelope"), 30);

    store.pruneEnvelopes(10);
    assert.equal(store.count("envelope"), 10);
    assert.equal(store.getEnvelope(first.id), null); // oldest gone
    assert.ok(store.getEnvelope(rest[rest.length - 1].id)); // newest kept
  } finally {
    store.close();
  }
});

test("GET /trace/:id walks ancestors and descendants", async () => {
  await withServer(async ({ base, store }) => {
    const frame = env({ topic: "eo.frame" });
    const detection = env({
      topic: "eo.detection",
      schemaName: "planetar.eo.detection.v1",
      causationId: frame.id,
    });
    const chat = env({
      topic: "chat.pac.eo-chips",
      schemaName: "chat.v1.Message",
      causationId: detection.id,
    });
    for (const e of [frame, detection, chat]) store.insertEnvelope(e);

    const mid = await (await fetch(`${base}/trace/${detection.id}`)).json();
    assert.equal(mid.envelope.id, detection.id);
    assert.equal(mid.envelope.createdNs, detection.createdNs.toString());
    assert.deepEqual(mid.ancestors.map((a: { id: string }) => a.id), [frame.id]);
    assert.deepEqual(mid.descendants.map((d: { id: string }) => d.id), [chat.id]);
    assert.equal(mid.missingAncestorId, null);

    const root = await (await fetch(`${base}/trace/${frame.id}`)).json();
    assert.equal(root.ancestors.length, 0);
    assert.deepEqual(
      root.descendants.map((d: { id: string }) => d.id).sort(),
      [detection.id, chat.id].sort(),
    );
  });
});

test("GET /trace/:id reports a chain that leaves retention", async () => {
  await withServer(async ({ base, store }) => {
    const evictedId = oid(); // never inserted — pruned long ago
    const child = env({ causationId: evictedId });
    store.insertEnvelope(child);

    const j = await (await fetch(`${base}/trace/${child.id}`)).json();
    assert.equal(j.ancestors.length, 0);
    assert.equal(j.missingAncestorId, evictedId);
  });
});

test("GET /trace/:id survives a causation cycle", async () => {
  await withServer(async ({ base, store }) => {
    const a = env();
    const b = env({ causationId: a.id });
    a.causationId = b.id; // corrupt input: A ← B ← A
    store.insertEnvelope(a);
    store.insertEnvelope(b);

    const j = await (await fetch(`${base}/trace/${a.id}`)).json();
    assert.deepEqual(j.ancestors.map((x: { id: string }) => x.id), [b.id]);
  });
});

test("GET /trace/:id lists correlated envelopes outside the causal chain", async () => {
  await withServer(async ({ base, store }) => {
    const detect = env({ topic: "acoustic.detect", correlationId: "clip-42" });
    const classify = env({
      topic: "acoustic.classify",
      correlationId: "clip-42",
      causationId: detect.id,
    });
    const psd = env({ topic: "acoustic.psd", correlationId: "clip-42" }); // no causation set
    for (const e of [detect, classify, psd]) store.insertEnvelope(e);

    const j = await (await fetch(`${base}/trace/${classify.id}`)).json();
    // detect is an ancestor, so only the psd row is "correlated"
    assert.deepEqual(j.correlated.map((c: { id: string }) => c.id), [psd.id]);
  });
});

test("GET /trace/:id links an observation to the entity fields it set", async () => {
  await withServer(async ({ base, store }) => {
    const registry = Registry.load();
    const resolver = new Resolver(store, registry);

    const obsEnv = env({
      topic: "vessel.ais.position",
      source: "planetar-ais",
      schemaName: "vessel.ais.Position.v1",
    });
    store.insertEnvelope(obsEnv);
    const r = resolver.resolve(
      "planetar:Vessel",
      { type: "planetar:Vessel", mmsi: 316001234, name: "MV Northern Light", sog: 12.4 },
      obsEnv.id, "src:planetar-ais@2.1.0", obsEnv.createdNs, 1.0,
    );
    store.insertObservation({
      id: obsEnv.id,
      entityId: r.entityId,
      type: "planetar:Vessel",
      source: "planetar-ais",
      topic: obsEnv.topic,
      tsNs: obsEnv.createdNs,
      confidence: 1.0,
      body: { mmsi: 316001234 },
    });

    const j = await (await fetch(`${base}/trace/${obsEnv.id}`)).json();
    assert.equal(j.entity.id, r.entityId);
    assert.equal(j.entity.type, "planetar:Vessel");
    assert.ok(j.entity.fields.includes("mmsi"));
    assert.ok(j.entity.fields.includes("sog"));
  });
});

test("GET /trace/:id of an unknown id is an empty trace, not an error", async () => {
  await withServer(async ({ base }) => {
    const j = await (await fetch(`${base}/trace/${oid()}`)).json();
    assert.equal(j.envelope, null);
    assert.equal(j.entity, null);
    assert.deepEqual(j.ancestors, []);
    assert.deepEqual(j.descendants, []);
    assert.deepEqual(j.correlated, []);
  });
});
