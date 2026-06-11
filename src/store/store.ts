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
