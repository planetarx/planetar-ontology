/*
 * p4.test.ts — the Kinetic layer: Action Type validation, preconditions,
 * effects, and the core:Event audit trail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/store.ts";
import { Registry } from "../src/registry/registry.ts";
import { Resolver } from "../src/resolve/resolve.ts";
import { ActionExecutor } from "../src/actions/executor.ts";
import { uuid7, uuidToString } from "../src/codec/zmesg.ts";

const ts = (): bigint => BigInt(Date.now()) * 1_000_000n;
const oid = (): string => uuidToString(uuid7());

function setup() {
  const store = new Store(":memory:");
  const registry = Registry.load();
  return {
    store,
    resolver: new Resolver(store, registry),
    executor: new ActionExecutor(store, registry),
  };
}

function makeVessel(resolver: Resolver, fields: Record<string, unknown>): string {
  return resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", ...fields },
    oid(), "src:planetar-ais@2.1.0", ts(), 1.0,
  ).entityId;
}

test("ConfirmDarkVessel on a dark-suspected vessel succeeds and is audited", () => {
  const { store, resolver, executor } = setup();
  const id = makeVessel(resolver, { mmsi: 316001234, status: "dark-suspected" });

  const out = executor.execute("planetar:ConfirmDarkVessel", {
    candidate_id: id,
    analyst_id: "analyst-7",
    rationale: "SAR contact, no AIS for 40 min",
  });
  assert.equal(out.status, 200);

  const ent = store.getEntity(id);
  assert.ok(ent);
  assert.equal(ent.body.status, "dark-confirmed");
  assert.equal(ent.body.confirmation_rationale, "SAR contact, no AIS for 40 min");
  // the mutation's provenance points at the action, not a sensor source
  assert.equal(ent.provenance.status.src, "action:planetar:ConfirmDarkVessel");
  assert.equal(store.count("event"), 1);
  store.close();
});

test("ConfirmDarkVessel fails its precondition on an active vessel", () => {
  const { store, resolver, executor } = setup();
  const id = makeVessel(resolver, { mmsi: 1, status: "active" });

  const out = executor.execute("planetar:ConfirmDarkVessel", {
    candidate_id: id,
    analyst_id: "a",
    rationale: "x",
  });
  assert.equal(out.status, 409);

  const ent = store.getEntity(id);
  assert.ok(ent);
  assert.equal(ent.body.status, "active"); // unchanged
  assert.equal(store.count("event"), 0); // a rejected action is not audited
  store.close();
});

test("a missing required parameter is rejected", () => {
  const { resolver, executor } = setup();
  const id = makeVessel(resolver, { mmsi: 2, status: "dark-suspected" });
  const out = executor.execute("planetar:ConfirmDarkVessel", {
    candidate_id: id,
    analyst_id: "a", // rationale missing
  });
  assert.equal(out.status, 400);
});

test("an unknown action type is 404", () => {
  const { executor } = setup();
  assert.equal(executor.execute("planetar:Nope", {}).status, 404);
});

test("an unknown target entity is 404", () => {
  const { executor } = setup();
  const out = executor.execute("planetar:ConfirmDarkVessel", {
    candidate_id: "no-such-id",
    analyst_id: "a",
    rationale: "x",
  });
  assert.equal(out.status, 404);
});

test("AnnotateEntity attaches a note and records the acting principal", () => {
  const { store, resolver, executor } = setup();
  const id = makeVessel(resolver, { mmsi: 3 });

  const out = executor.execute("planetar:AnnotateEntity", {
    entity_id: id,
    actor: "analyst-2",
    note: "matches last week's loiterer",
  });
  assert.equal(out.status, 200);

  const ent = store.getEntity(id);
  assert.ok(ent);
  assert.equal(ent.body.analyst_note, "matches last week's loiterer");

  const ev = store.db
    .prepare("SELECT actor, action_type, type FROM event")
    .get() as { actor: string; action_type: string; type: string };
  assert.equal(ev.actor, "analyst-2");
  assert.equal(ev.action_type, "planetar:AnnotateEntity");
  assert.equal(ev.type, "analyst.annotation");
  store.close();
});
