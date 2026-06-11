/*
 * p3.test.ts — the Object API: REST endpoints and the WebSocket live feed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/store.ts";
import { Registry } from "../src/registry/registry.ts";
import { Resolver } from "../src/resolve/resolve.ts";
import { createApiServer } from "../src/api/server.ts";
import type { ApiServer } from "../src/api/server.ts";
import { uuid7, uuidToString } from "../src/codec/zmesg.ts";

const ts = (): bigint => BigInt(Date.now()) * 1_000_000n;
const oid = (): string => uuidToString(uuid7());

interface Ctx {
  base: string;
  api: ApiServer;
  store: Store;
  vesselId: string;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const store = new Store(":memory:");
  const registry = Registry.load();
  const resolver = new Resolver(store, registry);

  const v1 = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, name: "MV Northern Light", length_m: 184 },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316005678, name: "MV Salish Sea" },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  );

  const api = createApiServer(store, registry);
  await new Promise<void>((resolve) => api.listen(0, resolve));
  const port = (api.server.address() as AddressInfo).port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, api, store, vesselId: v1.entityId });
  } finally {
    api.close();
    store.close();
  }
}

test("GET /health reports counts", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, "ok");
    assert.equal(j.entities, 2);
  });
});

test("GET /schema serves the registry", async () => {
  await withServer(async ({ base }) => {
    const j = await (await fetch(`${base}/schema`)).json();
    assert.equal(j.version, "0.1.0");
    assert.ok(j.objectTypes["planetar:Vessel"]);
    assert.deepEqual(j.objectTypes["planetar:Vessel"].identifierFields, ["mmsi", "imo", "callsign"]);
  });
});

test("GET /objects/:type lists entities and filters by a body field", async () => {
  await withServer(async ({ base }) => {
    const all = await (await fetch(`${base}/objects/planetar:Vessel`)).json();
    assert.equal(all.count, 2);

    const filtered = await (
      await fetch(`${base}/objects/planetar:Vessel?mmsi=316001234`)
    ).json();
    assert.equal(filtered.count, 1);
    assert.equal(filtered.objects[0].name, "MV Northern Light");
  });
});

test("GET /objects/:type/:id returns one entity with provenance", async () => {
  await withServer(async ({ base, vesselId }) => {
    const r = await fetch(`${base}/objects/planetar:Vessel/${vesselId}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.id, vesselId);
    assert.equal(j.body.mmsi, 316001234);
    assert.equal(j.provenance.length_m.src, "src:planetar-ais@2.1.0");
  });
});

test("unknown type and unknown id both 404", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/objects/planetar:Nope`)).status, 404);
    assert.equal((await fetch(`${base}/objects/planetar:Vessel/no-such-id`)).status, 404);
  });
});

test("GET .../links/:linkType returns an (empty) link list", async () => {
  await withServer(async ({ base, vesselId }) => {
    const j = await (
      await fetch(`${base}/objects/planetar:Vessel/${vesselId}/links/sighting`)
    ).json();
    assert.equal(j.count, 0);
    assert.deepEqual(j.links, []);
  });
});

test("POST /actions is 501 until the executor is wired (P4)", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/actions/planetar:ConfirmDarkVessel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 501);
  });
});

test("WebSocket /subscribe pushes a hello then live entity changes", async () => {
  await withServer(async ({ base, api, vesselId }) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/subscribe`);
    const got: Record<string, unknown>[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 3000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as Record<string, unknown>;
        got.push(m);
        if (m.event === "hello") api.notifyEntity(vesselId);
        if (m.event === "entity") {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("ws error"));
      };
    });
    ws.close();

    assert.equal(got[0].event, "hello");
    const change = got.find((m) => m.event === "entity") as
      | { entity: { id: string } }
      | undefined;
    assert.ok(change);
    assert.equal(change.entity.id, vesselId);
  });
});
