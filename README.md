# planetar-ontology

The **Ontology Service** — layer 4 (the entity graph) of the planetar CH13
reference architecture. It turns the canonical data model
(`~/data/vaults/docs/ARCH-canonical-data-model.md`) from a *schema spec* into a
*running operational ontology*: it ingests observations off the bus, resolves
them into canonical entities, holds the typed object graph, and serves it.

Design doc: `~/data/vaults/docs/ARCH-planetar-ontology.md`.

## Status

All seven build phases are complete — 40 tests pass (`npm test`); P1–P5 and
P7 are verified live against the running planetar-broker.

| Phase | Scope | State |
|---|---|---|
| **P1** | zmesg codec · registry · SQLite store · broker ingest | **done** |
| **P2** | identity resolution · merge · provenance | **done** |
| **P3** | Object API — REST + WebSocket live feed | **done** |
| **P4** | Action Type executor (Kinetic layer) | **done** |
| **P5** | dark-vessel re-ID kinematic match rule | **done** |
| **P6** | envelope trace index + `GET /trace/:id` lineage API | **done** |
| **P7** | bus producer — `entity.<kind>.updated` published per mutation | **done** |

P6 (design: `ARCH-planetar-flow-trace.md`) indexes the metadata of **every**
envelope seen on the bus — classified or not — into a bounded `envelope` table
(`PLANETAR_TRACE_MAX`, default 200 000 rows), and serves causal lineage
(`causationId` ancestors/descendants, `correlationId` siblings, and the entity
fields the envelope's observation set) to the planetar-ui Flow tab.

P7 closes the loop: every entity mutation (create / merge / reacquisition /
Action Type) is published back onto the bus as an `entity.<kind>.updated`
envelope — `causation_id` = the observation envelope that triggered it,
`correlation_id` = the entity id — so traces run *through* the graph and any
consumer can react to entity changes without knowing this API exists. The
ingest loop skips (but still trace-indexes) envelopes whose source is
`planetar-ontology`, so the service never feeds on its own output. Disable
with `PLANETAR_PUBLISH=0`; producer port `PLANETAR_BROKER_PUB_PORT` (12001).

## API

```
GET  /health                                 entity/observation counts
GET  /schema                                  compiled registry
GET  /objects/:type[?field=value&limit&offset] list / search entities
GET  /objects/:type/:id                        one entity, with provenance
GET  /objects/:type/:id/links/:linkType        follow links
GET  /trace/:id                                causal lineage of one envelope
POST /actions/:actionType                      execute an Action Type
WS   /subscribe                                live entity-change feed
```

## Run

No dependencies, no build step — Node ≥ 22.18 runs the TypeScript directly and
`node:sqlite` is built in.

```sh
npm start                 # connect to planetar-broker :12002, ingest to SQLite
npm test                  # synthetic tests — no broker required
npm run publish-synth     # publish synthetic vessel envelopes to the broker :12001
```

Env: `PLANETAR_ONTOLOGY_DB` (default `planetar-ontology.db`),
`PLANETAR_TOPICS` (default `**`), `PLANETAR_BROKER_HOST` / `PLANETAR_BROKER_PORT`,
`PLANETAR_BROKER_PUB_PORT` (12001), `PLANETAR_PUBLISH` (`0` disables P7).

**Retention** (pruned every 2 000 ingested envelopes, oldest-first):
`PLANETAR_TRACE_MAX` envelopes (200 000) · `PLANETAR_OBS_MAX` observations
(500 000 — rows referenced by entity field-provenance are never pruned) ·
`PLANETAR_DISCREPANCY_MAX` discrepancies (100 000). Merge semantics keep the
tables honest too: same-confidence updates supersede (newest wins) without
recording a discrepancy — discrepancies are reserved for *cross-source*
disagreements.

## Layout

```
registry/types.json    bootstrap registry (object-type defs)
src/codec/zmesg.ts      zmesg envelope decode/encode + TCP framing
src/registry/           registry loader + envelope classifier
src/store/              node:sqlite object store (schema.sql + store.ts)
src/ingest/broker.ts    broker TCP subscriber + frame reader
src/index.ts            P1 wiring: ingest → classify → persist
tools/publish.ts        synthetic envelope publisher (for live testing)
```

## Licensing

Licensed under **AGPL-3.0** (see [`LICENSE`](LICENSE)). **Commercial licenses**
(for use without AGPL obligations) are available — contact `sness@sness.net`.
