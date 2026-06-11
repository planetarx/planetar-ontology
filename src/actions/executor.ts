/*
 * executor.ts — the Kinetic layer: the Action Type executor.
 *
 * An Action Type (registry §actionTypes) is the only sanctioned way to mutate
 * an entity other than observation ingest. Executing one is validated,
 * precondition-checked, applied atomically, and audited as a core:Event —
 * see ARCH-planetar-ontology.md §6. Because every mutation flows through here,
 * an AI agent can be handed exactly the registered Action Types and nothing
 * else (the AIP-containment story).
 */

import { uuid7, uuidToString } from "../codec/zmesg.ts";
import type { Registry, Precondition } from "../registry/registry.ts";
import type { Store } from "../store/store.ts";
import type { ActionOutcome } from "../api/server.ts";

export class ActionExecutor {
  #store: Store;
  #registry: Registry;

  constructor(store: Store, registry: Registry) {
    this.#store = store;
    this.#registry = registry;
  }

  execute(actionType: string, params: Record<string, unknown>): ActionOutcome {
    const def = this.#registry.actionTypes.get(actionType);
    if (!def) {
      return { status: 404, body: { error: `unknown action type: ${actionType}` } };
    }

    // 1. validate parameters
    for (const [name, spec] of Object.entries(def.parameters)) {
      const v = params[name];
      if (spec.required && (v === undefined || v === null || v === "")) {
        return { status: 400, body: { error: `missing required parameter: ${name}` } };
      }
    }

    // 2. resolve the target entity
    const target = def.target ? this.#lookupTarget(params[def.target]) : null;
    if (def.target && !target) {
      return {
        status: 404,
        body: { error: `target entity not found: ${String(params[def.target])}` },
      };
    }

    // 3. check preconditions
    if (target) {
      for (const pc of def.preconditions) {
        if (!evalPrecondition(pc, target.body)) {
          return {
            status: 409,
            body: {
              error: `precondition failed: ${pc.field} ${pc.op} ${JSON.stringify(pc.value)}`,
              field: pc.field,
              actual: target.body[pc.field] ?? null,
            },
          };
        }
      }
    }

    const eventId = uuidToString(uuid7());
    const tsNs = BigInt(Date.now()) * 1_000_000n;

    // 4. apply effects atomically
    const changed: string[] = [];
    if (target) {
      for (const eff of def.effects) {
        if (eff.op !== "set") continue;
        target.body[eff.field] = resolveValue(eff.value, params);
        target.provenance[eff.field] = {
          obs: eventId,
          src: `action:${actionType}`,
          conf: 1.0,
          ts: tsNs.toString(),
        };
        changed.push(eff.field);
      }
      if (typeof target.body.name === "string") target.name = target.body.name;
      target.updatedNs = tsNs;
      this.#store.updateEntity(target);
    }

    // 5. audit — write the core:Event
    const actor =
      def.actor && typeof params[def.actor] === "string"
        ? (params[def.actor] as string)
        : "unknown";
    this.#store.insertEvent({
      id: eventId,
      tsNs,
      type: def.event,
      actor,
      actionType,
      targetId: target?.id ?? "",
      body: params,
    });

    return {
      status: 200,
      body: {
        ok: true,
        action: actionType,
        event: eventId,
        actor,
        target: target?.id ?? null,
        changed,
        entity: target ? { id: target.id, type: target.type, body: target.body } : null,
      },
    };
  }

  #lookupTarget(id: unknown) {
    return typeof id === "string" ? this.#store.getEntity(id) : null;
  }
}

function evalPrecondition(pc: Precondition, body: Record<string, unknown>): boolean {
  const cur = body[pc.field] ?? null;
  switch (pc.op) {
    case "eq":
      return jsonEq(cur, pc.value);
    case "ne":
      return !jsonEq(cur, pc.value);
    case "in":
      return Array.isArray(pc.value) && pc.value.some((v) => jsonEq(cur, v));
    case "exists":
      return cur !== null;
    case "absent":
      return cur === null;
    default:
      return false;
  }
}

/** A literal value, or `$paramName` to copy a parameter into the effect. */
function resolveValue(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return params[value.slice(1)];
  }
  return value;
}

function jsonEq(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
