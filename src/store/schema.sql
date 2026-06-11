-- planetar-ontology object store
-- Tables map onto the core:* types of ARCH-canonical-data-model.md §5.1.
-- See ARCH-planetar-ontology.md §5.
--
-- ns timestamps are stored as INTEGER (SQLite INTEGER is 64-bit signed;
-- nanoseconds-since-epoch overflow is not a concern until year ~2262).

-- Resolved canonical identities (core:CanonicalEntity).
CREATE TABLE IF NOT EXISTS entity (
  id             TEXT PRIMARY KEY,        -- UUIDv7
  type           TEXT NOT NULL,           -- e.g. planetar:Vessel
  schema_version TEXT NOT NULL,
  name           TEXT,
  created_ns     INTEGER,
  updated_ns     INTEGER,
  body           TEXT NOT NULL,           -- JSON: merged canonical fields
  provenance     TEXT NOT NULL            -- JSON: per-field {obs,src,conf,ts}
);

-- One source's claim about an entity at a time (core:Observation). Immutable.
-- `type` and `topic` are denormalised from the canonical model for query/debug;
-- the canonical model carries them on the envelope.
CREATE TABLE IF NOT EXISTS observation (
  id         TEXT PRIMARY KEY,            -- envelope id (UUIDv7)
  entity_id  TEXT REFERENCES entity(id),  -- NULL until resolved (P2)
  type       TEXT NOT NULL,               -- canonical type claimed
  source     TEXT NOT NULL,               -- src:<name>@<semver>
  topic      TEXT,
  ts_ns      INTEGER NOT NULL,
  confidence REAL,
  body       TEXT NOT NULL                -- JSON entity body
);
CREATE INDEX IF NOT EXISTS observation_entity ON observation(entity_id);
CREATE INDEX IF NOT EXISTS observation_type   ON observation(type);

-- Identifier-claim index — drives identity resolution (core:Identifier).
CREATE TABLE IF NOT EXISTS identifier (
  entity_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- mmsi | imo | callsign | ...
  value      TEXT NOT NULL,
  source     TEXT,
  confidence REAL,
  PRIMARY KEY (kind, value, entity_id)
);

-- Typed relationships between entities (core:Link).
CREATE TABLE IF NOT EXISTS link (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  body       TEXT,
  created_ns INTEGER
);
CREATE INDEX IF NOT EXISTS link_from ON link(from_id);
CREATE INDEX IF NOT EXISTS link_to   ON link(to_id);

-- Append-only log; Action Types write here (core:Event).
CREATE TABLE IF NOT EXISTS event (
  id          TEXT PRIMARY KEY,
  ts_ns       INTEGER,
  type        TEXT,
  actor       TEXT,
  action_type TEXT,
  target_id   TEXT,
  body        TEXT
);

-- Structured, documented conflicts (core:Discrepancy, §9.3).
CREATE TABLE IF NOT EXISTS discrepancy (
  id        TEXT PRIMARY KEY,
  entity_id TEXT,
  field     TEXT,
  competing TEXT,
  chosen    TEXT,
  policy    TEXT,
  note      TEXT
);
