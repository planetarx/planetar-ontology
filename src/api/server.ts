/*
 * server.ts — the Object API (the OSDK-equivalent surface).
 *
 * REST over node:http + a WebSocket live feed (ARCH-planetar-ontology.md §8):
 *   GET  /health
 *   GET  /schema                                  compiled registry
 *   GET  /objects/:type                           list/search entities
 *   GET  /objects/:type/:id                       one entity, with provenance
 *   GET  /objects/:type/:id/links/:linkType       follow links
 *   POST /actions/:actionType                     execute an Action Type (P4)
 *   WS   /subscribe                               live entity-change feed
 *
 * Dependency-free: node:http for REST, the hand-rolled ws.ts for the feed.
 */

import http from "node:http";
import { acceptWebSocket } from "./ws.ts";
import type { WsConn } from "./ws.ts";
import type { Store, EntityRecord } from "../store/store.ts";
import type { Registry } from "../registry/registry.ts";

/** Result of executing an Action Type (supplied by P4's executor). */
export interface ActionOutcome {
  status: number;
  body: unknown;
}
export type ActionHandler = (
  actionType: string,
  params: Record<string, unknown>,
) => Promise<ActionOutcome> | ActionOutcome;

export interface ApiServerOptions {
  /** Optional Action Type executor — wired in P4; absent → POST /actions is 501. */
  onAction?: ActionHandler;
}

export interface ApiServer {
  server: http.Server;
  listen(port: number, cb?: () => void): void;
  close(cb?: () => void): void;
  /** Push an entity-change event to every WebSocket subscriber. */
  notifyEntity(entityId: string): void;
  wsClientCount(): number;
}

function serializeEntity(e: EntityRecord): Record<string, unknown> {
  return {
    id: e.id,
    type: e.type,
    schemaVersion: e.schemaVersion,
    name: e.name,
    createdNs: e.createdNs.toString(),
    updatedNs: e.updatedNs.toString(),
    body: e.body,
    provenance: e.provenance,
  };
}

export function createApiServer(
  store: Store,
  registry: Registry,
  opts: ApiServerOptions = {},
): ApiServer {
  const wsClients = new Set<WsConn>();

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(json);
  };

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      send(res, 400, { error: "bad url" });
      return;
    }
    const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    try {
      // GET /health
      if (seg.length <= 1 && (seg[0] === "health" || seg.length === 0)) {
        send(res, 200, {
          status: "ok",
          entities: store.count("entity"),
          observations: store.count("observation"),
        });
        return;
      }

      // GET /schema
      if (seg.length === 1 && seg[0] === "schema" && method === "GET") {
        send(res, 200, {
          version: registry.version,
          objectTypes: Object.fromEntries(registry.objectTypes),
        });
        return;
      }

      // POST /actions/:actionType
      if (seg.length === 2 && seg[0] === "actions" && method === "POST") {
        if (!opts.onAction) {
          send(res, 501, { error: "action executor not configured (P4)" });
          return;
        }
        readJsonBody(req, (err, params) => {
          if (err) {
            send(res, 400, { error: `bad request body: ${err.message}` });
            return;
          }
          Promise.resolve(opts.onAction!(seg[1], params))
            .then((out) => send(res, out.status, out.body))
            .catch((e: Error) => send(res, 500, { error: e.message }));
        });
        return;
      }

      // /objects/...
      if (seg[0] === "objects" && method === "GET") {
        const type = seg[1];
        if (!type || !registry.objectTypes.has(type)) {
          send(res, 404, { error: `unknown object type: ${type ?? "(none)"}` });
          return;
        }

        // GET /objects/:type
        if (seg.length === 2) {
          const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
          const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1e9);
          let entities = store.listEntities(type, limit, offset);
          // any non-reserved query param is a body-field equality filter
          for (const [k, v] of url.searchParams) {
            if (k === "limit" || k === "offset") continue;
            entities = entities.filter((e) => String(e.body[k] ?? "") === v);
          }
          send(res, 200, { type, count: entities.length, objects: entities.map(serializeEntity) });
          return;
        }

        const id = seg[2];
        const ent = store.getEntity(id);
        if (!ent || ent.type !== type) {
          send(res, 404, { error: `no ${type} with id ${id}` });
          return;
        }

        // GET /objects/:type/:id
        if (seg.length === 3) {
          send(res, 200, serializeEntity(ent));
          return;
        }

        // GET /objects/:type/:id/links/:linkType
        if (seg.length === 5 && seg[3] === "links") {
          const links = store.linksFrom(id, seg[4]);
          const targets = links.map((l) => {
            const target = store.getEntity(l.toId);
            return {
              link: { id: l.id, type: l.type, createdNs: l.createdNs.toString(), body: l.body },
              target: target ? serializeEntity(target) : null,
            };
          });
          send(res, 200, { from: id, linkType: seg[4], count: targets.length, links: targets });
          return;
        }
      }

      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });

  server.on("upgrade", (req, socket) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/subscribe") {
      socket.destroy();
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    wsClients.add(ws);
    ws.onClose(() => wsClients.delete(ws));
    ws.send(JSON.stringify({ event: "hello", entities: store.count("entity") }));
  });

  return {
    server,
    listen: (port, cb) => server.listen(port, cb),
    close: (cb) => {
      for (const ws of wsClients) ws.close();
      wsClients.clear();
      server.close(cb);
    },
    notifyEntity: (entityId) => {
      const ent = store.getEntity(entityId);
      if (!ent) return;
      const msg = JSON.stringify({ event: "entity", entity: serializeEntity(ent) });
      for (const ws of wsClients) ws.send(msg);
    },
    wsClientCount: () => wsClients.size,
  };
}

function clampInt(raw: string | null, dflt: number, lo: number, hi: number): number {
  const n = raw == null ? dflt : Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function readJsonBody(
  req: http.IncomingMessage,
  cb: (err: Error | null, body: Record<string, unknown>) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > 1 << 20) {
      req.destroy();
      cb(new Error("body too large"), {});
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      cb(null, {});
      return;
    }
    try {
      cb(null, JSON.parse(raw) as Record<string, unknown>);
    } catch (e) {
      cb(e as Error, {});
    }
  });
  req.on("error", (e) => cb(e, {}));
}
