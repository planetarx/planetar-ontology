/*
 * store.ts — the object store (Semantic layer), backed by node:sqlite.
 *
 * Tables map onto the core:* types of ARCH-canonical-data-model.md §5.1.
 * P1 writes `observation`; P2 adds `entity`/`identifier`/`discrepancy`;
 * P3 reads entities + links for the Object API; P4 writes `event`; P5 `link`.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StatementSync } from "node:sqlite";

export interface ObservationRecord {
  id: string;
  entityId: string | null;
  type: string;
  source: string;
  topic: string | null;
  tsNs: bigint;
  confidence: number | null;
  body: unknown;
}

/**
 * Metadata-only trace-index row — one per envelope seen on the bus, whether or
 * not it classified (ARCH-planetar-flow-trace.md §4.1). No payload: the WAL is
 * the payload store.
 */
export interface EnvelopeRecord {
  id: string;
  topic: string;
  source: string;
  schemaName: string | null;
  correlationId: string | null;
  causationId: string | null;
  createdNs: bigint;
  storedNs: bigint | null;
  publishedNs: bigint | null;
}

/** Where one field's current value came from (ARCH-canonical-data-model.md §9.1). */
export interface FieldProvenance {
  obs: string; // observation id
  src: string; // src:<name>@<semver>
  conf: number;
  ts: string; // ns timestamp, as a string
}

export interface EntityRecord {
  id: string;
  type: string;
  schemaVersion: string;
  name: string | null;
  createdNs: bigint;
  updatedNs: bigint;
  body: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
}

export interface DiscrepancyRecord {
  id: string;
  entityId: string;
  field: string;
  competing: unknown;
  chosen: unknown;
  policy: string;
  note: string;
}

export interface LinkRecord {
  id: string;
  type: string;
  fromId: string;
  toId: string;
  body: unknown;
  createdNs: bigint;
}

export interface EventRecord {
  id: string;
  tsNs: bigint;
  type: string;
  actor: string;
  actionType: string;
  targetId: string;
  body: unknown;
}

const COUNTABLE = new Set([
  "entity", "observation", "identifier", "link", "event", "discrepancy",
  "envelope",
]);

function rowToEntity(row: Record<string, unknown>): EntityRecord {
  return {
    id: row.id as string,
    type: row.type as string,
    schemaVersion: row.schema_version as string,
    name: (row.name as string) ?? null,
    createdNs: row.created_ns as bigint,
    updatedNs: row.updated_ns as bigint,
    body: JSON.parse(row.body as string) as Record<string, unknown>,
    provenance: JSON.parse(row.provenance as string) as Record<string, FieldProvenance>,
  };
}

function rowToEnvelope(row: Record<string, unknown>): EnvelopeRecord {
  return {
    id: row.id as string,
    topic: row.topic as string,
    source: row.source as string,
    schemaName: (row.schema_name as string) ?? null,
    correlationId: (row.correlation_id as string) ?? null,
    causationId: (row.causation_id as string) ?? null,
    createdNs: row.created_ns as bigint,
    storedNs: (row.stored_ns as bigint) ?? null,
    publishedNs: (row.published_ns as bigint) ?? null,
  };
}

function rowToLink(row: Record<string, unknown>): LinkRecord {
  return {
    id: row.id as string,
    type: row.type as string,
    fromId: row.from_id as string,
    toId: row.to_id as string,
    body: row.body ? JSON.parse(row.body as string) : null,
    createdNs: row.created_ns as bigint,
  };
}

export class Store {
  readonly db: DatabaseSync;
  #insObs: StatementSync;
  #getObs: StatementSync;
  #insEnvelope: StatementSync;
  #getEnvelope: StatementSync;
  #envByCausation: StatementSync;
  #envByCorrelation: StatementSync;
  #pruneEnvelopes: StatementSync;
  #insEntity: StatementSync;
  #updEntity: StatementSync;
  #getEntity: StatementSync;
  #listEntities: StatementSync;
  #insIdent: StatementSync;
  #findIdent: StatementSync;
  #insDiscrepancy: StatementSync;
  #insLink: StatementSync;
  #linksFrom: StatementSync;
  #insEvent: StatementSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
    this.db.exec(schema);

    this.#insObs = this.db.prepare(
      `INSERT OR IGNORE INTO observation
         (id, entity_id, type, source, topic, ts_ns, confidence, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#getObs = this.db.prepare(`SELECT * FROM observation WHERE id = ?`);
    this.#getObs.setReadBigInts(true);

    this.#insEnvelope = this.db.prepare(
      `INSERT OR IGNORE INTO envelope
         (id, topic, source, schema_name, correlation_id, causation_id,
          created_ns, stored_ns, published_ns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#getEnvelope = this.db.prepare(`SELECT * FROM envelope WHERE id = ?`);
    this.#envByCausation = this.db.prepare(
      `SELECT * FROM envelope WHERE causation_id = ? ORDER BY created_ns LIMIT ?`,
    );
    this.#envByCorrelation = this.db.prepare(
      `SELECT * FROM envelope WHERE correlation_id = ? ORDER BY created_ns LIMIT ?`,
    );
    // keep the newest N by created_ns; LIMIT -1 OFFSET n = "everything past n"
    this.#pruneEnvelopes = this.db.prepare(
      `DELETE FROM envelope WHERE id IN
         (SELECT id FROM envelope ORDER BY created_ns DESC LIMIT -1 OFFSET ?)`,
    );
    this.#getEnvelope.setReadBigInts(true);
    this.#envByCausation.setReadBigInts(true);
    this.#envByCorrelation.setReadBigInts(true);

    this.#insEntity = this.db.prepare(
      `INSERT INTO entity
         (id, type, schema_version, name, created_ns, updated_ns, body, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#updEntity = this.db.prepare(
      `UPDATE entity SET name = ?, updated_ns = ?, body = ?, provenance = ? WHERE id = ?`,
    );
    this.#getEntity = this.db.prepare(`SELECT * FROM entity WHERE id = ?`);
    this.#listEntities = this.db.prepare(
      `SELECT * FROM entity WHERE type = ? ORDER BY updated_ns DESC LIMIT ? OFFSET ?`,
    );
    // ns timestamps exceed 2^53 — read entity integer columns as BigInt.
    this.#getEntity.setReadBigInts(true);
    this.#listEntities.setReadBigInts(true);

    this.#insIdent = this.db.prepare(
      `INSERT OR IGNORE INTO identifier (entity_id, kind, value, source, confidence)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.#findIdent = this.db.prepare(
      `SELECT entity_id FROM identifier WHERE kind = ? AND value = ?`,
    );
    this.#insDiscrepancy = this.db.prepare(
      `INSERT INTO discrepancy (id, entity_id, field, competing, chosen, policy, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#insLink = this.db.prepare(
      `INSERT OR IGNORE INTO link (id, type, from_id, to_id, body, created_ns)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.#linksFrom = this.db.prepare(`SELECT * FROM link WHERE from_id = ?`);
    this.#linksFrom.setReadBigInts(true);
    this.#insEvent = this.db.prepare(
      `INSERT INTO event (id, ts_ns, type, actor, action_type, target_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Persist one observation. Idempotent on the envelope id (safe on replay). */
  insertObservation(o: ObservationRecord): void {
    this.#insObs.run(
      o.id, o.entityId, o.type, o.source, o.topic, o.tsNs, o.confidence,
      JSON.stringify(o.body),
    );
  }

  /** One observation row by envelope id (trace → entity linkage). */
  getObservation(id: string): ObservationRecord | null {
    const row = this.#getObs.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      entityId: (row.entity_id as string) ?? null,
      type: row.type as string,
      source: row.source as string,
      topic: (row.topic as string) ?? null,
      tsNs: row.ts_ns as bigint,
      confidence: (row.confidence as number) ?? null,
      body: JSON.parse(row.body as string),
    };
  }

  /** Index one envelope's metadata. Idempotent on the envelope id. */
  insertEnvelope(e: EnvelopeRecord): void {
    this.#insEnvelope.run(
      e.id, e.topic, e.source, e.schemaName, e.correlationId, e.causationId,
      e.createdNs, e.storedNs, e.publishedNs,
    );
  }

  getEnvelope(id: string): EnvelopeRecord | null {
    const row = this.#getEnvelope.get(id) as Record<string, unknown> | undefined;
    return row ? rowToEnvelope(row) : null;
  }

  /** Direct causal children of an envelope (causation_id = id). */
  envelopesCausedBy(id: string, limit = 100): EnvelopeRecord[] {
    return (this.#envByCausation.all(id, limit) as Record<string, unknown>[]).map(
      rowToEnvelope,
    );
  }

  envelopesByCorrelation(correlationId: string, limit = 100): EnvelopeRecord[] {
    return (this.#envByCorrelation.all(correlationId, limit) as Record<string, unknown>[]).map(
      rowToEnvelope,
    );
  }

  /** Drop everything but the newest `max` envelope rows. */
  pruneEnvelopes(max: number): void {
    this.#pruneEnvelopes.run(max);
  }

  insertEntity(e: EntityRecord): void {
    this.#insEntity.run(
      e.id, e.type, e.schemaVersion, e.name, e.createdNs, e.updatedNs,
      JSON.stringify(e.body), JSON.stringify(e.provenance),
    );
  }

  updateEntity(e: EntityRecord): void {
    this.#updEntity.run(
      e.name, e.updatedNs, JSON.stringify(e.body), JSON.stringify(e.provenance), e.id,
    );
  }

  getEntity(id: string): EntityRecord | null {
    const row = this.#getEntity.get(id) as Record<string, unknown> | undefined;
    return row ? rowToEntity(row) : null;
  }

  listEntities(type: string, limit = 100, offset = 0): EntityRecord[] {
    return (this.#listEntities.all(type, limit, offset) as Record<string, unknown>[]).map(
      rowToEntity,
    );
  }

  /** Entity ids that have claimed a given identifier (drives resolution). */
  findEntityIdsByIdentifier(kind: string, value: string): string[] {
    return (this.#findIdent.all(kind, value) as { entity_id: string }[]).map(
      (r) => r.entity_id,
    );
  }

  insertIdentifier(
    entityId: string, kind: string, value: string,
    source: string | null, confidence: number | null,
  ): void {
    this.#insIdent.run(entityId, kind, value, source, confidence);
  }

  insertDiscrepancy(d: DiscrepancyRecord): void {
    this.#insDiscrepancy.run(
      d.id, d.entityId, d.field,
      JSON.stringify(d.competing), JSON.stringify(d.chosen), d.policy, d.note,
    );
  }

  insertLink(l: LinkRecord): void {
    this.#insLink.run(
      l.id, l.type, l.fromId, l.toId,
      l.body == null ? null : JSON.stringify(l.body), l.createdNs,
    );
  }

  /** Links originating at an entity, optionally filtered to one link type. */
  linksFrom(fromId: string, type?: string): LinkRecord[] {
    const links = (this.#linksFrom.all(fromId) as Record<string, unknown>[]).map(rowToLink);
    return type ? links.filter((l) => l.type === type) : links;
  }

  insertEvent(e: EventRecord): void {
    this.#insEvent.run(
      e.id, e.tsNs, e.type, e.actor, e.actionType, e.targetId, JSON.stringify(e.body),
    );
  }

  /** Row count for a table — for tests and the periodic status line. */
  count(table: string): number {
    if (!COUNTABLE.has(table)) throw new Error(`store: unknown table ${table}`);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
