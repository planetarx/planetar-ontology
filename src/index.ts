/*
 * index.ts — planetar-ontology entrypoint.
 *
 * Pipeline: broker subscribe → decode → classify → resolve → persist.
 * P1 = decode/classify/persist; P2 adds resolve/merge/provenance — an
 * observation of a canonical type is folded into a canonical entity before the
 * observation row is written (with entity_id set).
 */

import { connectBroker } from "./ingest/broker.ts";
import { decodeEnvelope } from "./codec/zmesg.ts";
import { Registry } from "./registry/registry.ts";
import { Store } from "./store/store.ts";
import { Resolver } from "./resolve/resolve.ts";
import { DarkVesselMatcher, applyReacquisition } from "./resolve/kinematics.ts";
import { ActionExecutor } from "./actions/executor.ts";
import { createApiServer } from "./api/server.ts";
import { EntityPublisher, SELF_SOURCE, connectProducer } from "./publish/publisher.ts";

const dbPath = process.env.PLANETAR_ONTOLOGY_DB ?? "planetar-ontology.db";
const host = process.env.PLANETAR_BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.PLANETAR_BROKER_PORT ?? 12002);
const pubPort = Number(process.env.PLANETAR_BROKER_PUB_PORT ?? 12001);
const apiPort = Number(process.env.PLANETAR_API_PORT ?? 4000);
const topics = (process.env.PLANETAR_TOPICS ?? "**").split(/\s+/).filter(Boolean);
const traceMax = Number(process.env.PLANETAR_TRACE_MAX ?? 200_000);
const obsMax = Number(process.env.PLANETAR_OBS_MAX ?? 500_000);
const discMax = Number(process.env.PLANETAR_DISCREPANCY_MAX ?? 100_000);
const publishEnabled = (process.env.PLANETAR_PUBLISH ?? "1") !== "0";

const store = new Store(dbPath);
const registry = Registry.load();
const resolver = new Resolver(store, registry);
const matcher = new DarkVesselMatcher(store);
const executor = new ActionExecutor(store, registry);

// P7 — entity mutations go back onto the bus (entity.<kind>.updated).
const producer = publishEnabled
  ? connectProducer({ host, port: pubPort, onStatus: (m) => console.error(`[publish] ${m}`) })
  : null;
const entityPub = producer ? new EntityPublisher(producer) : null;
const publishEntity = (entityId: string, action: string, causationId: string): void => {
  if (!entityPub) return;
  const ent = store.getEntity(entityId);
  if (!ent) return;
  entityPub.publishEntityUpdated(ent, action, causationId);
  stats.published++;
};

const api = createApiServer(store, registry, {
  onAction: (type, params) => {
    const out = executor.execute(type, params);
    const target = (out.body as { target?: unknown }).target;
    // a successful action changed the entity — push it to the live feed
    if (out.status === 200 && typeof target === "string") {
      api.notifyEntity(target);
      publishEntity(target, `action:${type}`, ""); // API-initiated: no bus-side cause
    }
    return out;
  },
});
api.listen(apiPort, () => console.error(`[api] listening on http://127.0.0.1:${apiPort}`));

const stats = {
  observation: 0, action: 0, event: 0, unknown: 0, errors: 0,
  merged: 0, created: 0, reacquired: 0, indexed: 0, published: 0,
};

const conn = connectBroker({
  host,
  port,
  topics,
  onStatus: (m) => console.error(`[broker] ${m}`),
  onEnvelope: (raw) => {
    let env;
    try {
      env = decodeEnvelope(raw);
    } catch (e) {
      stats.errors++;
      console.error(`[decode] ${(e as Error).message}`);
      return;
    }

    // Trace index — every envelope, classified or not (flow-trace §4.1).
    store.insertEnvelope({
      id: env.id,
      topic: env.topic,
      source: env.source,
      schemaName: env.schemaName || null,
      correlationId: env.correlationId || null,
      causationId: env.causationId || null,
      createdNs: env.createdAtNs,
      storedNs: env.storedAtNs,
      publishedNs: env.publishedAtNs,
    });
    if (++stats.indexed % 2000 === 0) {
      store.pruneEnvelopes(traceMax);
      store.pruneObservations(obsMax);
      store.pruneDiscrepancies(discMax);
    }

    // Our own entity.*.updated envelopes come back via SUB ** — they are
    // trace-indexed above (the trace should show that hop) but must never
    // re-enter classify/resolve, or the ontology feeds on its own output.
    if (env.source === SELF_SOURCE) return;

    let body: Record<string, unknown> | null = null;
    if (env.payload.length) {
      try {
        body = JSON.parse(env.payload.toString("utf8")) as Record<string, unknown>;
      } catch {
        body = null; // non-JSON payload — classify by topic alone
      }
    }

    const cls = registry.classify(env.topic, body);
    stats[cls.kind]++;
    if (cls.kind !== "observation") return;

    const confidence =
      body && typeof body.confidence === "number" ? body.confidence : null;

    let entityId: string | null = null;
    if (body && resolver.isCanonical(cls.type)) {
      // P2 — fold an identified observation into a canonical entity
      const r = resolver.resolve(
        cls.type, body, env.id, env.source, env.createdAtNs, confidence,
      );
      entityId = r.entityId;
      if (r.action === "merge") stats.merged++;
      else stats.created++;
      api.notifyEntity(entityId);
      publishEntity(entityId, r.action === "merge" ? "merged" : "created", env.id);
    } else if (body && cls.type === "planetar:Detection") {
      // P5 — a no-MMSI detection: try to re-identify a dark vessel by kinematics
      const lat = typeof body.lat === "number" ? body.lat : null;
      const lon = typeof body.lon === "number" ? body.lon : null;
      const hasIdentifier = body.mmsi != null;
      if (lat !== null && lon !== null && !hasIdentifier) {
        const det = {
          obsId: env.id, lat, lon, tsNs: env.createdAtNs, sensor: env.source,
        };
        const m = matcher.match(det);
        if (m) {
          entityId = m.vesselId;
          applyReacquisition(store, m, det);
          api.notifyEntity(m.vesselId);
          publishEntity(m.vesselId, "reacquired", env.id);
          stats.reacquired++;
        }
      }
    }

    store.insertObservation({
      id: env.id,
      entityId,
      type: cls.type,
      source: env.source,
      topic: env.topic,
      tsNs: env.createdAtNs,
      confidence,
      body: body ?? { _raw: env.payload.toString("base64") },
    });
  },
});

const ticker = setInterval(() => {
  console.error(
    `[ontology] obs=${stats.observation} (merged=${stats.merged} new=${stats.created} ` +
      `reacquired=${stats.reacquired}) act=${stats.action} evt=${stats.event} ` +
      `unknown=${stats.unknown} errors=${stats.errors} published=${stats.published} ` +
      `· entities=${store.count("entity")} ` +
      `observations=${store.count("observation")} links=${store.count("link")} ` +
      `discrepancies=${store.count("discrepancy")}`,
  );
}, 5000);

const shutdown = (): void => {
  clearInterval(ticker);
  conn.close();
  producer?.close();
  api.close();
  store.close();
  console.error("[ontology] stopped");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.error(
  `planetar-ontology — db=${dbPath} registry=v${registry.version} ` +
    `broker=${host}:${port} topics=[${topics.join(" ")}]`,
);
