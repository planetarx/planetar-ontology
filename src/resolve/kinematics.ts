/*
 * kinematics.ts — dark-vessel re-identification (P5).
 *
 * The flagship CH13 demo, as a registered match rule rather than bespoke code
 * (ARCH-planetar-ontology.md §7). A vessel goes AIS-dark; later a SAR/EO
 * detection with no MMSI appears. This dead-reckons every known vessel's track
 * forward from its last-known kinematic state and scores proximity to the
 * detection. A strong match links the detection to the vessel as a
 * re-acquisition across the AIS gap — the same generic resolver, one more tier.
 */

import { uuid7, uuidToString } from "../codec/zmesg.ts";
import type { Store } from "../store/store.ts";

const NS_PER_HOUR = 3_600_000_000_000;

export interface DetectionInput {
  obsId: string;
  lat: number;
  lon: number;
  tsNs: bigint;
  sensor: string;
}

export interface ReacquisitionMatch {
  vesselId: string;
  score: number;
  predictedDistanceNm: number;
  gapMinutes: number;
}

/** Dead-reckon a position forward along a constant course (knots, degrees). */
export function projectPosition(
  lat: number,
  lon: number,
  cogDeg: number,
  sogKnots: number,
  elapsedHours: number,
): { lat: number; lon: number } {
  const distNm = sogKnots * elapsedHours;
  const brg = (cogDeg * Math.PI) / 180;
  const dLat = (distNm * Math.cos(brg)) / 60;
  const dLon = (distNm * Math.sin(brg)) / (60 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

/** Distance in nautical miles (equirectangular — accurate enough at POC scale). */
export function distanceNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const meanLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const x = (lon2 - lon1) * Math.cos(meanLat);
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y) * 60;
}

export class DarkVesselMatcher {
  #store: Store;
  #radiusNm: number;

  constructor(store: Store, radiusNm = 1.5) {
    this.#store = store;
    this.#radiusNm = radiusNm;
  }

  /** Score a no-identifier detection against every known vessel's projected track. */
  match(d: DetectionInput): ReacquisitionMatch | null {
    let best: ReacquisitionMatch | null = null;
    for (const v of this.#store.listEntities("planetar:Vessel", 1000, 0)) {
      const lat = num(v.body.lat);
      const lon = num(v.body.lon);
      if (lat === null || lon === null) continue;

      const elapsedHours = Number(d.tsNs - v.updatedNs) / NS_PER_HOUR;
      if (elapsedHours < 0) continue; // detection precedes the last fix

      const pred = projectPosition(lat, lon, num(v.body.cog) ?? 0, num(v.body.sog) ?? 0, elapsedHours);
      const dist = distanceNm(pred.lat, pred.lon, d.lat, d.lon);
      if (dist > this.#radiusNm) continue;

      const score = 0.5 + 0.4 * (1 - dist / this.#radiusNm); // 0.5 .. 0.9
      if (!best || score > best.score) {
        best = {
          vesselId: v.id,
          score,
          predictedDistanceNm: dist,
          gapMinutes: elapsedHours * 60,
        };
      }
    }
    return best;
  }
}

/**
 * Apply a re-acquisition: record a `reacquisition` link from the vessel to the
 * detection and advance the vessel's track to the detection's fix.
 */
export function applyReacquisition(
  store: Store,
  match: ReacquisitionMatch,
  d: DetectionInput,
): string {
  const linkId = uuidToString(uuid7());
  store.insertLink({
    id: linkId,
    type: "reacquisition",
    fromId: match.vesselId,
    toId: d.obsId,
    body: {
      sensor: d.sensor,
      score: round(match.score),
      predicted_distance_nm: round(match.predictedDistanceNm),
      gap_minutes: round(match.gapMinutes),
    },
    createdNs: d.tsNs,
  });

  const v = store.getEntity(match.vesselId);
  if (v) {
    const prov = { obs: d.obsId, src: d.sensor, conf: match.score, ts: d.tsNs.toString() };
    v.body.lat = d.lat;
    v.body.lon = d.lon;
    v.body.status = "reacquired";
    v.provenance.lat = prov;
    v.provenance.lon = prov;
    v.provenance.status = prov;
    v.updatedNs = d.tsNs;
    store.updateEntity(v);
  }
  return linkId;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
