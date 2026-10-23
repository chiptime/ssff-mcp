/**
 * Layered entity/field policy for Phase 3 IAS roles (FR-07, FR-08).
 *
 * Pure composition of TWO independent policy layers — the ENVIRONMENT policy
 * (the existing tenant/environment ceiling) and the ROLE policy — over one
 * query: an entity set name, a protocol, and the entity's schema keys.
 *
 * The layer semantics are the existing `entityAllowlist` / `entityDenylist` /
 * `fields` semantics, reused through `isEntityPermitted` and
 * `permittedFieldsFor`; nothing here re-implements or changes them:
 *
 * - An entity is permitted only when BOTH layers permit it. A denylist in
 *   either layer wins, whatever the allowlists say (FR-08: a role can never
 *   widen the environment ceiling).
 * - Absent or empty lists/fields narrow nothing IN THEIR OWN LAYER only. They
 *   never remove the other layer's narrowing (FR-07: no implicit deny-all).
 * - Schema keys are always readable for a PERMITTED entity, exactly like
 *   `allowedProperties` adds them. Keys never rescue a denied entity.
 *
 * Field outcomes are an explicit discriminated union so that a RESTRICTED
 * empty readable set (disjoint field restrictions, no keys) can never be
 * confused with UNRESTRICTED. Derived field lists are never passed back into
 * the legacy helpers, where `[]` would be read as "no narrowing".
 *
 * A field restriction with an UNRESOLVED schema (`schemaKeys: undefined`)
 * fails closed — the whole decision denies with an explicit schema reason —
 * mirroring `allowedProperties`, which refuses rather than guess the key set.
 * `schemaKeys: []` (a resolved schema with zero keys) is honored as-is.
 *
 * This module is internal Phase 3 scaffolding: it defines no configuration
 * schema, validates no tokens, and is not yet wired into any tool surface.
 */

import {
  isEntityPermitted,
  permittedFieldsFor,
  type AllowlistEntry,
  type AllowlistProtocol,
} from "./allowlist.js";

/**
 * One policy layer, in the existing list semantics. Both lists are optional
 * and absent means "narrows nothing here". Entry-level validation (names,
 * protocols, duplicates) belongs to the config layer that produces these.
 */
export interface PolicyLayer {
  entityAllowlist?: AllowlistEntry[];
  entityDenylist?: AllowlistEntry[];
}

/**
 * The fields a permitted entity may expose.
 *
 * - `unrestricted`: neither layer narrows the fields.
 * - `restricted`: ONLY the named properties (already including the schema
 *   keys) are readable. The set may be EMPTY: that is a restricted entity
 *   exposing nothing beyond structural data, never an open one.
 */
export type FieldAccess =
  | { readonly kind: "unrestricted" }
  | { readonly kind: "restricted"; readonly fields: ReadonlySet<string> };

/** Why a decision denied the entity (or refused to resolve its fields). */
export type LayeredDenialReason =
  | {
      /** The layer whose list denied the entity; environment is the ceiling. */
      readonly source: "environment" | "role";
      /** A denylist entry wins over any allowlist; else the allowlist misses. */
      readonly cause: "denylist" | "allowlist";
    }
  | {
      /** Fields are restricted but the schema keys are unknown: fail closed. */
      readonly source: "schema";
      readonly cause: "unresolved";
    };

/** Explicit outcome for one entity/protocol query under the two layers. */
export interface LayeredDecision {
  readonly entity: string;
  readonly protocol: AllowlistProtocol;
  readonly permitted: boolean;
  /** Present for every denial path; `undefined` when permitted. */
  readonly reason: LayeredDenialReason | undefined;
  /** Nothing is readable on a denied entity, not even the schema keys. */
  readonly fields: FieldAccess;
}

/** One layered evaluation request. `schemaKeys` undefined = schema unresolved. */
export interface LayeredPolicyQuery {
  readonly entity: string;
  /** Defaults to `"v2"`, like the underlying helpers. */
  readonly protocol?: AllowlistProtocol;
  /** The entity's key properties from the cached metadata, if resolvable. */
  readonly schemaKeys: string[] | undefined;
  readonly environment: PolicyLayer;
  readonly role: PolicyLayer;
}

/** Nothing is readable when the entity itself is refused. */
const NOTHING_READABLE: FieldAccess = { kind: "restricted", fields: new Set<string>() };

function invalid(message: string): never {
  throw new TypeError(`layered policy: ${message}`);
}

function assertLayer(layer: unknown, name: "environment" | "role"): void {
  if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
    invalid(`${name} policy layer must be an object`);
  }
  for (const list of ["entityAllowlist", "entityDenylist"] as const) {
    const value = (layer as Record<string, unknown>)[list];
    if (value !== undefined && !Array.isArray(value)) {
      invalid(`${name}.${list} must be an array when present`);
    }
  }
}

function denied(
  entity: string,
  protocol: AllowlistProtocol,
  reason: LayeredDenialReason,
): LayeredDecision {
  // Keys never rescue a denied entity: no property, keys included, is readable.
  return { entity, protocol, permitted: false, reason, fields: NOTHING_READABLE };
}

/**
 * Combine the environment and role policies into one explicit decision.
 *
 * The environment layer is evaluated first: it is the ceiling, so its denial
 * is the reported cause when both layers would deny. Field restrictions from
 * the two layers are intersected (a single layer restricting counts as-is);
 * the schema keys are then added to the readable set.
 */
export function evaluateLayeredPolicy(query: LayeredPolicyQuery): LayeredDecision {
  if (typeof query !== "object" || query === null) {
    invalid("query must be an object");
  }
  const input = query as unknown as Record<string, unknown>;
  if (typeof input.entity !== "string" || input.entity.length === 0) {
    invalid("entity must be a non-empty string");
  }
  const protocol: AllowlistProtocol =
    input.protocol === undefined ? "v2" : (input.protocol as AllowlistProtocol);
  if (protocol !== "v2" && protocol !== "v4") {
    invalid('protocol must be "v2" or "v4"');
  }
  if (
    input.schemaKeys !== undefined &&
    (!Array.isArray(input.schemaKeys) ||
      input.schemaKeys.some((key) => typeof key !== "string"))
  ) {
    invalid("schemaKeys must be an array of strings or undefined");
  }
  if (input.environment === undefined) {
    invalid("environment policy layer is required");
  }
  if (input.role === undefined) {
    invalid("role policy layer is required");
  }
  assertLayer(input.environment, "environment");
  assertLayer(input.role, "role");

  const entity = input.entity;
  const environment = input.environment as PolicyLayer;
  const role = input.role as PolicyLayer;

  // Entity: BOTH layers must permit; a denylist in either wins. The existing
  // helper already applies denylist-wins per layer; calling it once per layer
  // yields "both must permit". The environment runs first so its denial is
  // the reported one when both deny.
  const layers = [
    { policy: environment, source: "environment" as const },
    { policy: role, source: "role" as const },
  ];
  for (const { policy, source } of layers) {
    if (!isEntityPermitted(policy.entityAllowlist, policy.entityDenylist, entity, protocol)) {
      // With no allowlist the helper permits unless the denylist lists the
      // entity, so this call isolates the denylist as the denying list.
      const denylistDenies = !isEntityPermitted(undefined, policy.entityDenylist, entity, protocol);
      return denied(entity, protocol, { source, cause: denylistDenies ? "denylist" : "allowlist" });
    }
  }

  // Fields: each layer narrows independently; undefined = unrestricted THERE.
  const environmentFields = permittedFieldsFor(environment.entityAllowlist, entity, protocol);
  const roleFields = permittedFieldsFor(role.entityAllowlist, entity, protocol);
  const restrictions = [environmentFields, roleFields].filter(
    (fields): fields is string[] => fields !== undefined,
  );

  if (restrictions.length === 0) {
    return { entity, protocol, permitted: true, reason: undefined, fields: { kind: "unrestricted" } };
  }

  // Any restriction requires the schema: the key set cannot be guessed, and an
  // unresolved schema MUST NOT be read as "no keys" (allowedProperties fails
  // closed on the same condition).
  if (input.schemaKeys === undefined) {
    return denied(entity, protocol, { source: "schema", cause: "unresolved" });
  }

  const combined =
    restrictions.length === 1
      ? restrictions[0]
      : restrictions[0].filter((field) => restrictions[1].includes(field));

  // The discriminated kind is what keeps an EMPTY intersection restricted:
  // the derived list is folded into a Set here and never handed back to a
  // legacy helper that would read `[]` as unrestricted.
  const fields = new Set<string>([...combined, ...input.schemaKeys]);
  return { entity, protocol, permitted: true, reason: undefined, fields: { kind: "restricted", fields } };
}
