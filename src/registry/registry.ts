/*
 * registry.ts — the schema authority for planetar-ontology.
 *
 * P1 stand-in for the full git-vault registry (ARCH-canonical-data-model.md §6).
 * Loads object-type definitions and classifies incoming envelopes into
 * observation / action / event (ARCH-planetar-ontology.md §3 step 3).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ObjectTypeDef {
  name: string;
  extends: string;
  identifierFields: string[];
  topicPrefixes: string[];
}

export interface ParameterSpec {
  type: string;
  required: boolean;
}
export interface Precondition {
  field: string;
  op: "eq" | "ne" | "in" | "exists" | "absent";
  value?: unknown;
}
export interface Effect {
  op: "set";
  field: string;
  /** A literal, or `$paramName` to copy a parameter value. */
  value: unknown;
}
export interface ActionTypeDef {
  name: string;
  description: string;
  parameters: Record<string, ParameterSpec>;
  /** Parameter naming the entity the action operates on. */
  target?: string;
  /** Parameter naming the acting principal (for the audit log). */
  actor?: string;
  preconditions: Precondition[];
  effects: Effect[];
  /** core:Event type written when the action succeeds. */
  event: string;
}

export type EnvelopeKind = "observation" | "action" | "event" | "unknown";

export interface Classification {
  kind: EnvelopeKind;
  /** Canonical type, e.g. `planetar:Vessel`. Empty when kind is `unknown`. */
  type: string;
}

interface RegistryJson {
  version: string;
  objectTypes: Record<string, Omit<ObjectTypeDef, "name">>;
  actionTypes?: Record<string, Omit<ActionTypeDef, "name">>;
}

export class Registry {
  readonly version: string;
  readonly objectTypes: Map<string, ObjectTypeDef>;
  readonly actionTypes: Map<string, ActionTypeDef>;

  constructor(json: RegistryJson) {
    this.version = json.version;
    this.objectTypes = new Map(
      Object.entries(json.objectTypes).map(([name, def]) => [
        name,
        {
          name,
          extends: def.extends,
          identifierFields: def.identifierFields ?? [],
          topicPrefixes: def.topicPrefixes ?? [],
        },
      ]),
    );
    this.actionTypes = new Map(
      Object.entries(json.actionTypes ?? {}).map(([name, def]) => [
        name,
        {
          name,
          description: def.description ?? "",
          parameters: def.parameters ?? {},
          target: def.target,
          actor: def.actor,
          preconditions: def.preconditions ?? [],
          effects: def.effects ?? [],
          event: def.event ?? "action",
        },
      ]),
    );
  }

  static load(path?: string): Registry {
    const p = path ?? join(import.meta.dirname, "..", "..", "registry", "types.json");
    return new Registry(JSON.parse(readFileSync(p, "utf8")) as RegistryJson);
  }

  /** Classify an envelope by topic and (optionally) its decoded body. */
  classify(topic: string, body: Record<string, unknown> | null): Classification {
    if (topic.startsWith("action.")) {
      return { kind: "action", type: typeStr(body) ?? "core:Action" };
    }
    if (topic.startsWith("event.")) {
      return { kind: "event", type: typeStr(body) ?? "core:Event" };
    }
    // An explicit, known `type` in the body wins.
    const declared = typeStr(body);
    if (declared && this.objectTypes.has(declared)) {
      return { kind: "observation", type: declared };
    }
    // Otherwise match a registered topic prefix.
    for (const def of this.objectTypes.values()) {
      for (const pre of def.topicPrefixes) {
        if (topic === pre || topic.startsWith(pre + ".")) {
          return { kind: "observation", type: def.name };
        }
      }
    }
    return { kind: "unknown", type: declared ?? "" };
  }
}

function typeStr(body: Record<string, unknown> | null): string | null {
  return body && typeof body.type === "string" ? body.type : null;
}
