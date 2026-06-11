/*
 * resolve.ts — generic identity resolution + merge + provenance.
 *
 * Folds an incoming observation into a canonical entity: finds candidates via
 * the identifier index, scores them, and either merges into the best match
 * (exact-identifier band) or creates a new entity. Merging applies
 * highest-confidence-wins per field and records a core:Discrepancy whenever
 * sources disagree.
 *
 * Generic per ARCH-canonical-data-model.md §5.2: each canonical type declares
 * its identifier fields in the registry; this one engine serves them all.
 * P2 implements the exact-identifier tier only; a fuzzy-name tier and the
 * kinematic tier (P5) plug into the same scoring map.
 */

import { uuid7, uuidToString } from "../codec/zmesg.ts";
import type { Registry } from "../registry/registry.ts";
import type { Store, EntityRecord, FieldProvenance } from "../store/store.ts";

/** Suggested-action bands from doibio's identity-resolution.ts (§5.2). */
export type ResolveAction = "merge" | "link" | "review" | "new";

export interface ResolveResult {
  entityId: string;
  action: ResolveAction;
  score: number;
}

interface IdClaim {
  kind: string;
  value: string;
}
interface Claim {
  value: unknown;
  prov: FieldProvenance;
}

// Envelope/meta keys that are not entity body fields.
const META_FIELDS = new Set(["type", "confidence", "_provenance"]);

export class Resolver {
  #store: Store;
  #registry: Registry;

  constructor(store: Store, registry: Registry) {
    this.#store = store;
    this.#registry = registry;
  }

  /** True for types that resolve into a canonical entity (vs. a raw observation). */
  isCanonical(type: string): boolean {
    return this.#registry.objectTypes.get(type)?.extends === "core:CanonicalEntity";
  }

  resolve(
    type: string,
    body: Record<string, unknown>,
    obsId: string,
    source: string,
    tsNs: bigint,
    confidence: number | null,
  ): ResolveResult {
    const def = this.#registry.objectTypes.get(type);
    const conf = confidence ?? 0.5;

    // 1. collect identifier claims present in the body
    const claims: IdClaim[] = [];
    for (const f of def?.identifierFields ?? []) {
      const v = body[f];
      if (v !== undefined && v !== null && v !== "") {
        claims.push({ kind: f, value: String(v) });
      }
    }

    // 2. score candidate entities — exact-identifier match → 1.0
    const scores = new Map<string, number>();
    for (const c of claims) {
      for (const eid of this.#store.findEntityIdsByIdentifier(c.kind, c.value)) {
        scores.set(eid, Math.max(scores.get(eid) ?? 0, 1.0));
      }
    }
    let best: { id: string; score: number } | null = null;
    for (const [id, s] of scores) {
      if (!best || s > best.score) best = { id, score: s };
    }

    // 3. decide (suggested-action bands, §5.2)
    if (best && best.score >= 0.95) {
      this.#merge(best.id, body, obsId, source, tsNs, conf);
      this.#recordIdentifiers(best.id, claims, source, conf);
      return { entityId: best.id, action: "merge", score: best.score };
    }
    // P2 has no fuzzy tier yet, so anything short of an exact match is new.
    const id = this.#createEntity(type, body, obsId, source, tsNs, conf, claims);
    return { entityId: id, action: "new", score: best?.score ?? 0 };
  }

  #createEntity(
    type: string,
    body: Record<string, unknown>,
    obsId: string,
    source: string,
    tsNs: bigint,
    conf: number,
    claims: IdClaim[],
  ): string {
    const id = uuidToString(uuid7());
    const ts = tsNs.toString();
    const entBody: Record<string, unknown> = {};
    const prov: Record<string, FieldProvenance> = {};
    for (const [k, v] of Object.entries(body)) {
      if (META_FIELDS.has(k)) continue;
      entBody[k] = v;
      prov[k] = { obs: obsId, src: source, conf, ts };
    }
    this.#store.insertEntity({
      id,
      type,
      schemaVersion: `${type}@1.0.0`,
      name: typeof body.name === "string" ? body.name : null,
      createdNs: tsNs,
      updatedNs: tsNs,
      body: entBody,
      provenance: prov,
    });
    this.#recordIdentifiers(id, claims, source, conf);
    return id;
  }

  /** Fold an observation's fields into an existing entity (highest-conf-wins). */
  #merge(
    entityId: string,
    body: Record<string, unknown>,
    obsId: string,
    source: string,
    tsNs: bigint,
    conf: number,
  ): void {
    const ent = this.#store.getEntity(entityId);
    if (!ent) return;
    const ts = tsNs.toString();
    const incomingProv: FieldProvenance = { obs: obsId, src: source, conf, ts };

    for (const [k, v] of Object.entries(body)) {
      if (META_FIELDS.has(k)) continue;
      const prior = ent.provenance[k];
      if (!prior) {
        ent.body[k] = v;
        ent.provenance[k] = incomingProv;
        continue;
      }
      const conflict = !valuesEqual(ent.body[k], v);
      const incomingWins = conf > prior.conf;
      if (conflict) {
        const winner: Claim = incomingWins
          ? { value: v, prov: incomingProv }
          : { value: ent.body[k], prov: prior };
        const loser: Claim = incomingWins
          ? { value: ent.body[k], prov: prior }
          : { value: v, prov: incomingProv };
        this.#recordDiscrepancy(entityId, k, winner, loser);
      }
      if (incomingWins) {
        ent.body[k] = v;
        ent.provenance[k] = incomingProv;
      }
    }
    if (typeof body.name === "string") ent.name = body.name;
    ent.updatedNs = tsNs;
    this.#store.updateEntity(ent);
  }

  #recordIdentifiers(
    entityId: string, claims: IdClaim[], source: string, conf: number,
  ): void {
    for (const c of claims) {
      this.#store.insertIdentifier(entityId, c.kind, c.value, source, conf);
    }
  }

  #recordDiscrepancy(
    entityId: string, field: string, winner: Claim, loser: Claim,
  ): void {
    this.#store.insertDiscrepancy({
      id: uuidToString(uuid7()),
      entityId,
      field,
      competing: [
        { value: winner.value, ...winner.prov },
        { value: loser.value, ...loser.prov },
      ],
      chosen: { value: winner.value, conf: winner.prov.conf, src: winner.prov.src },
      policy: "highest-confidence-wins",
      note: `field '${field}': ${winner.prov.src} (conf ${winner.prov.conf}) ` +
        `chosen over ${loser.prov.src} (conf ${loser.prov.conf})`,
    });
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
