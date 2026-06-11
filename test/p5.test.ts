/*
 * p5.test.ts — dark-vessel re-identification: kinematic projection, matching,
 * and the re-acquisition link.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/store.ts";
import { Registry } from "../src/registry/registry.ts";
import { Resolver } from "../src/resolve/resolve.ts";
import {
  projectPosition,
  distanceNm,
  DarkVesselMatcher,
  applyReacquisition,
} from "../src/resolve/kinematics.ts";
import { uuid7, uuidToString } from "../src/codec/zmesg.ts";

const oid = (): string => uuidToString(uuid7());
const NS_PER_HOUR = 3_600_000_000_000;

test("projectPosition dead-reckons along a course", () => {
  // due east (cog 90°) at 12 kn for 30 min → ~6 nm east, latitude unchanged
  const p = projectPosition(48.4, -123.4, 90, 12, 0.5);
  assert.ok(Math.abs(p.lat - 48.4) < 1e-9);
  assert.ok(p.lon > -123.4); // moved east
  assert.ok(distanceNm(48.4, -123.4, p.lat, p.lon) > 5.9);
  assert.ok(distanceNm(48.4, -123.4, p.lat, p.lon) < 6.1);
});

function setup() {
  const store = new Store(":memory:");
  const registry = Registry.load();
  return { store, resolver: new Resolver(store, registry) };
}

test("a no-MMSI detection re-identifies a vessel along its projected track", () => {
  const { store, resolver } = setup();
  const t0 = BigInt(Date.now()) * 1_000_000n;

  // a vessel last seen on AIS at t0, steaming east at 12 kn
  const vid = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, name: "MV Northern Light",
      lat: 48.4, lon: -123.4, cog: 90, sog: 12 },
    oid(), "src:planetar-ais@2.1.0", t0, 1.0,
  ).entityId;

  // 30 minutes later — AIS-dark — a SAR detection appears where the track predicts
  const gapHours = 0.5;
  const proj = projectPosition(48.4, -123.4, 90, 12, gapHours);
  const detTs = t0 + BigInt(Math.round(gapHours * NS_PER_HOUR));

  const matcher = new DarkVesselMatcher(store);
  const m = matcher.match({
    obsId: oid(), lat: proj.lat, lon: proj.lon, tsNs: detTs, sensor: "src:planetar-sat@1.4.0",
  });
  assert.ok(m, "expected a kinematic match");
  assert.equal(m.vesselId, vid);
  assert.ok(m.score > 0.85, `score ${m.score}`);
  assert.ok(m.predictedDistanceNm < 0.1);
  assert.ok(Math.abs(m.gapMinutes - 30) < 1);
  store.close();
});

test("a detection far off every projected track does not match", () => {
  const { store, resolver } = setup();
  const t0 = BigInt(Date.now()) * 1_000_000n;
  resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 1, lat: 48.4, lon: -123.4, cog: 90, sog: 12 },
    oid(), "src:planetar-ais@2.1.0", t0, 1.0,
  );
  const matcher = new DarkVesselMatcher(store);
  const m = matcher.match({
    obsId: oid(), lat: 49.6, lon: -124.8, tsNs: t0 + BigInt(NS_PER_HOUR / 2), sensor: "x",
  });
  assert.equal(m, null);
  store.close();
});

test("applyReacquisition links the detection and advances the vessel's track", () => {
  const { store, resolver } = setup();
  const t0 = BigInt(Date.now()) * 1_000_000n;
  const vid = resolver.resolve(
    "planetar:Vessel",
    { type: "planetar:Vessel", mmsi: 316001234, lat: 48.4, lon: -123.4, cog: 90, sog: 12 },
    oid(), "src:planetar-ais@2.1.0", t0, 1.0,
  ).entityId;

  const proj = projectPosition(48.4, -123.4, 90, 12, 0.5);
  const detTs = t0 + BigInt(Math.round(0.5 * NS_PER_HOUR));
  const obsId = oid();
  const det = { obsId, lat: proj.lat, lon: proj.lon, tsNs: detTs, sensor: "src:planetar-sat@1.4.0" };

  const matcher = new DarkVesselMatcher(store);
  const m = matcher.match(det);
  assert.ok(m);
  applyReacquisition(store, m, det);

  // a reacquisition link now connects the vessel to the detection observation
  assert.equal(store.count("link"), 1);
  const links = store.linksFrom(vid, "reacquisition");
  assert.equal(links.length, 1);
  assert.equal(links[0].toId, obsId);
  assert.equal((links[0].body as { sensor: string }).sensor, "src:planetar-sat@1.4.0");

  // the vessel's track has advanced to the detection fix and is flagged
  const v = store.getEntity(vid);
  assert.ok(v);
  assert.equal(v.body.status, "reacquired");
  assert.ok(Math.abs((v.body.lat as number) - proj.lat) < 1e-9);
  assert.equal(v.provenance.lat.src, "src:planetar-sat@1.4.0");
  store.close();
});
