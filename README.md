# planetar-ontology

The **Ontology Service** — layer 4 (the entity graph) of the planetar CH13
reference architecture. It turns the canonical data model
(`~/data/vaults/docs/ARCH-canonical-data-model.md`) from a *schema spec* into a
*running operational ontology*: it ingests observations off the bus, resolves
them into canonical entities, holds the typed object graph, and serves it.

Design doc: `~/data/vaults/docs/ARCH-planetar-ontology.md`.

## Status

All six build phases are complete — 37 tests pass (`npm test`); P1–P5 are
verified live against the running planetar-broker.

| Phase | Scope | State |
|---|---|---|
| **P1** | zmesg codec · registry · SQLite store · broker ingest | **done** |
| **P2** | identity resolution · merge · provenance | **done** |
| **P3** | Object API — REST + WebSocket live feed | **done** |
| **P4** | Action Type executor (Kinetic layer) | **done** |
| **P5** | dark-vessel re-ID kinematic match rule | **done** |
| **P6** | envelope trace index + `GET /trace/:id` lineage API | **done** |

P6 (design: `ARCH-planetar-flow-trace.md`) indexes the metadata of **every**
envelope seen on the bus — classified or not — into a bounded `envelope` table
(`PLANETAR_TRACE_MAX`, default 200 000 rows), and serves causal lineage
(`causationId` ancestors/descendants, `correlationId` siblings, and the entity
fields the envelope's observation set) to the planetar-ui Flow tab.

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
`PLANETAR_TOPICS` (default `**`), `PLANETAR_BROKER_HOST` / `PLANETAR_BROKER_PORT`.

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
