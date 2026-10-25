/**
 * Entity allowlist / denylist: pure decision logic (FR-28, D-30 with D-15 semantics).
 *
 * - The allowlist is a NARROWING on top of what the tenant account can already
 *   read. Absent, or an EMPTY array, narrows nothing: every entity the account
 *   can read is reachable. An empty array is NOT a deny-all.
 * - A non-empty allowlist means only the listed entity sets are queryable; an
 *   entity absent from the list is denied.
 * - The DENYLIST wins over the allowlist: an entity named there is always
 *   denied, whatever the allowlist says. It exists for the layered model, where
 *   an environment subtracts from a base inherited at tenant level.
 * - Matching is case-sensitive and exact against the OData entity set name (the
 *   FIRST path segment's name; navigation segments belong to the separate
 *   navigation vector).
 * - `protocols` per entry: omitted means "both protocols" (D-15). v2 is the only
 *   active protocol in this phase, so an entry that excludes v2 (for example
 *   `protocols: ["v4"]`) never applies (DS-P2-03).
 *
 * Composite policies (S4/FR-08): every helper below also accepts a
 * `CompositeEntityPolicy` in place of the array — the environment ceiling and
 * the role narrowing kept as two explicit layers, evaluated as their
 * INTERSECTION through these same leaf helpers. The composite exists so a role
 * layer can narrow every existing surface by replacing the allowlist VALUE,
 * without enumerating metadata and without materializing a legacy `[]` (which
 * means "unrestricted", never "deny-all"). See policy-composition.ts.
 */

import type { PolicyLayer } from "./layered-policy.js";

/** Protocols an allowlist entry may enable. */
export type AllowlistProtocol = "v2" | "v4";

/** One `entityAllowlist` / `entityDenylist` entry as parsed from config. */
export interface AllowlistEntry {
  /** OData entity set name; case-sensitive exact match. */
  entity: string;
  /** Omitted = both protocols (D-15); otherwise a non-empty, duplicate-free subset. */
  protocols?: AllowlistProtocol[];
  /**
   * Property names this entity exposes. ABSENT or EMPTY means every property:
   * like the entity list itself, a field list only narrows.
   */
  fields?: string[];
}

/**
 * A composite entity policy: the ENVIRONMENT ceiling and the ROLE narrowing
 * kept as two explicit layers, evaluated as their intersection. Produced by
 * `intersectEntityPolicies` (policy-composition.ts); the layers hold the
 * caller's arrays by reference.
 */
export interface CompositeEntityPolicy {
  /** Discriminator distinguishing the composite from a plain `AllowlistEntry[]`. */
  readonly kind: "composite";
  /** The environment ceiling: the existing per-environment allow/deny lists. */
  readonly environment: PolicyLayer;
  /** The role narrowing: the allow/deny lists of the user's effective role. */
  readonly role: PolicyLayer;
}

/**
 * What `entityAllowlist` accepts everywhere: the legacy plain array, or an
 * explicit two-layer composite policy. Plain-array behavior is unchanged.
 */
export type EntityAllowlist = AllowlistEntry[] | CompositeEntityPolicy;

/**
 * True when `entityName` is named in `list` and the entry applies to `protocol`.
 */
function listsEntity(
  list: AllowlistEntry[] | undefined,
  entityName: string,
  protocol: AllowlistProtocol,
): boolean {
  if (list === undefined) {
    return false;
  }
  const entry = list.find((candidate) => candidate.entity === entityName);
  return entry !== undefined && (entry.protocols === undefined || entry.protocols.includes(protocol));
}

/**
 * The composite member of an allowlist value, or undefined for a legacy array
 * (or absence). A value that is NEITHER a valid composite NOR an array fails
 * CLOSED with a loud TypeError: guessing its shape could only widen or narrow
 * the policy by accident.
 */
function asCompositePolicy(
  allowlist: EntityAllowlist | undefined,
): CompositeEntityPolicy | undefined {
  if (allowlist === undefined || Array.isArray(allowlist)) {
    return undefined;
  }
  if (allowlist.kind !== "composite") {
    throw new TypeError(
      'entity allowlist must be an AllowlistEntry[] or a { kind: "composite" } policy',
    );
  }
  return allowlist;
}

/**
 * Pure check: may `entityName` be queried under `allowlist` via `protocol`?
 *
 * - `allowlist` undefined OR empty => allowed: the list only narrows, and a list
 *   that adds nothing narrows nothing.
 * - Entity not listed => denied.
 * - Entry listed with `protocols` omitted => allowed on any protocol.
 * - Entry listed with `protocols` => allowed only when `protocol` is included.
 * - Composite: BOTH layers must permit, each with its own allow/deny lists and
 *   protocol rules (`isEntityPermitted` applies denylist-wins within one layer,
 *   so one call per layer IS the intersection). An empty entity intersection
 *   therefore denies every entity without ever materializing a legacy `[]`.
 */
export function isEntityAllowed(
  allowlist: EntityAllowlist | undefined,
  entityName: string,
  protocol: AllowlistProtocol = "v2",
): boolean {
  const composite = asCompositePolicy(allowlist);
  if (composite !== undefined) {
    return (
      isEntityPermitted(
        composite.environment.entityAllowlist,
        composite.environment.entityDenylist,
        entityName,
        protocol,
      ) &&
      isEntityPermitted(
        composite.role.entityAllowlist,
        composite.role.entityDenylist,
        entityName,
        protocol,
      )
    );
  }
  const list = allowlist as AllowlistEntry[] | undefined;
  if (list === undefined || list.length === 0) {
    return true;
  }
  return listsEntity(list, entityName, protocol);
}

/**
 * Final decision for one entity: the DENYLIST wins over the allowlist.
 *
 * - An entity named in `denylist` (for `protocol`) is denied, whatever the
 *   allowlist says.
 * - Otherwise the allowlist decides, with the semantics of `isEntityAllowed`.
 * - Composite: the `denylist` passed BESIDE the composite (the environment's
 *   own `entityDenylist`) still wins first — `intersectEntityPolicies` folds
 *   it into the environment layer too, and denying twice is idempotent.
 */
export function isEntityPermitted(
  allowlist: EntityAllowlist | undefined,
  denylist: AllowlistEntry[] | undefined,
  entityName: string,
  protocol: AllowlistProtocol = "v2",
): boolean {
  const composite = asCompositePolicy(allowlist);
  if (composite !== undefined) {
    if (listsEntity(denylist, entityName, protocol)) {
      return false;
    }
    return isEntityAllowed(composite, entityName, protocol);
  }
  if (listsEntity(denylist, entityName, protocol)) {
    return false;
  }
  return isEntityAllowed(allowlist, entityName, protocol);
}

/**
 * The property names `entityName` exposes, or `undefined` when the allowlist does
 * not restrict them.
 *
 * ABSENT and EMPTY both mean "no narrowing", exactly like the entity list itself:
 * a list that names nothing narrows nothing. Callers MUST treat `undefined` as
 * "every property".
 *
 * Composite: each layer narrows independently with these same legacy semantics;
 * the composite exposes the INTERSECTION. `undefined` — unrestricted — only
 * when BOTH layers are unrestricted. A disjoint intersection is `[]`, which
 * STAYS RESTRICTED: `allowedProperties` adds the actual schema keys, so `[]`
 * means "keys only", never "every property". Unlike the entity list, an empty
 * FIELDS result is not read back as "no narrowing" anywhere downstream.
 */
export function permittedFieldsFor(
  allowlist: EntityAllowlist | undefined,
  entityName: string,
  protocol: AllowlistProtocol = "v2",
): string[] | undefined {
  const composite = asCompositePolicy(allowlist);
  if (composite !== undefined) {
    const environmentFields = permittedFieldsFor(
      composite.environment.entityAllowlist,
      entityName,
      protocol,
    );
    const roleFields = permittedFieldsFor(composite.role.entityAllowlist, entityName, protocol);
    if (environmentFields === undefined) {
      return roleFields;
    }
    if (roleFields === undefined) {
      return environmentFields;
    }
    return environmentFields.filter((field) => roleFields.includes(field));
  }
  const list = allowlist as AllowlistEntry[] | undefined;
  if (list === undefined) {
    return undefined;
  }
  const entry = list.find(
    (candidate) =>
      candidate.entity === entityName &&
      (candidate.protocols === undefined || candidate.protocols.includes(protocol)),
  );
  if (entry === undefined || entry.fields === undefined || entry.fields.length === 0) {
    return undefined;
  }
  return entry.fields;
}

/** True when `field` may be read from `entityName` under `allowlist`. */
export function isFieldPermitted(
  allowlist: EntityAllowlist | undefined,
  entityName: string,
  field: string,
  protocol: AllowlistProtocol = "v2",
): boolean {
  const fields = permittedFieldsFor(allowlist, entityName, protocol);
  return fields === undefined || fields.includes(field);
}
