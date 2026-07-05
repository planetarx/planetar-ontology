/*
 * p7-publish.test.ts — the ontology as a bus producer: entity mutations
 * published as entity.<kind>.updated envelopes (ARCH-planetar-flow-trace.md).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEnvelope, uuid7, uuidToString } from "../src/codec/zmesg.ts";
import {
  ENTITY_UPDATED_SCHEMA,
  EntityPublisher,
  SELF_SOURCE,
  entityUpdatedTopic,
} from "../src/publish/publisher.ts";
import type { FrameSink } from "../src/publish/publisher.ts";
import type { EntityRecord } from "../src/store/store.ts";

class CaptureSink implements FrameSink {
  frames: Buffer[] = [];
  send(frameBytes: Buffer): void {
    this.frames.push(frameBytes);
  }
  close(): void {}
}

function vessel(): EntityRecord {
  return {
    id: uuidToString(uuid7()),
    type: "planetar:Vessel",
    schemaVersion: "planetar:Vessel@1.0.0",
    name: "MV Northern Light",
    createdNs: 1_700_000_000_000_000_000n,
    updatedNs: 1_700_000_001_000_000_000n,
    body: { mmsi: 316001234, status: "dark-suspected", lat: 48.4, lon: -123.3 },
    provenance: {},
  };
}

test("topic derivation: planetar:<Kind> → entity.<kind>.updated", () => {
  assert.equal(entityUpdatedTopic("planetar:Vessel"), "entity.vessel.updated");
  assert.equal(entityUpdatedTopic("planetar:Track"), "entity.track.updated");
});

test("publishEntityUpdated emits a well-formed, causation-linked envelope", () => {
  const sink = new CaptureSink();
  const pub = new EntityPublisher(sink);
  const ent = vessel();
  const causeId = uuidToString(uuid7());

  const envId = pub.publishEntityUpdated(ent, "merged", causeId);

  assert.equal(sink.frames.length, 1);
  const raw = sink.frames[0];
  // broker framing: 4-byte BE length prefix, then the envelope
  assert.equal(raw.readUInt32BE(0), raw.length - 4);
  const env = decodeEnvelope(raw.subarray(4));

  assert.equal(env.id, envId);
  assert.equal(env.topic, "entity.vessel.updated");
  assert.equal(env.source, SELF_SOURCE);
  assert.equal(env.schemaName, ENTITY_UPDATED_SCHEMA);
  assert.equal(env.correlationId, ent.id); // correlation follows the entity
  assert.equal(env.causationId, causeId); // causation = the triggering observation

  const body = JSON.parse(env.payload.toString("utf8"));
  assert.equal(body.id, ent.id);
  assert.equal(body.type, "planetar:Vessel");
  assert.equal(body.name, "MV Northern Light");
  assert.equal(body.action, "merged");
  assert.equal(body.updated_ns, ent.updatedNs.toString());
  assert.equal(body.body.mmsi, 316001234);
});

test("API-initiated actions publish with an empty causation (no bus-side cause)", () => {
  const sink = new CaptureSink();
  const pub = new EntityPublisher(sink);
  pub.publishEntityUpdated(vessel(), "action:planetar:ConfirmDarkVessel", "");
  const env = decodeEnvelope(sink.frames[0].subarray(4));
  assert.equal(env.causationId, "");
  const body = JSON.parse(env.payload.toString("utf8"));
  assert.equal(body.action, "action:planetar:ConfirmDarkVessel");
});
