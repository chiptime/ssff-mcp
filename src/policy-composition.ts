/**
 * Compose the ENVIRONMENT policy and the ROLE policy into ONE entity policy
 * value (S4, FR-08: «Ningún usuario puede ampliar el techo de permisos de la
 * cuenta técnica» — no user can widen the technical account's ceiling).
 *
 * `intersectEntityPolicies` folds both layers into an explicit
 * `CompositeEntityPolicy` (see allowlist.ts) that every surface accepting an
 * `entityAllowlist` already enforces: queries, navigation, expand, batch,
 * schemas, catalogs, resources, XML downgrade and picklist surfaces. The
 * caller replaces the environment's `entityAllowlist` VALUE with the
 * composite; nothing else in the pipeline changes.
 *
 * Design constraints, both load-bearing:
 *
 * - NO metadata enumeration: the intersection is evaluated lazily, per entity,
 *   by the existing leaf helpers (`isEntityPermitted`, `permittedFieldsFor`).
 *   This module never inspects `$metadata` and never computes entity lists.
 * - NO materialized legacy `[]`: an empty intersection written as a plain
 *   array would mean "unrestricted" in the legacy semantics. The composite
 *   keeps the layers explicit, so an empty entity intersection denies every
 *   entity and an empty FIELD intersection stays restricted (schema keys only,
 *   re-added by `allowedProperties`).
 *
 * This module has no runtime dependencies; both imports are types-only, so it
 * can never introduce an import cycle. Entry-level validation (names,
 * protocols, duplicates) belongs to the config layer that produces the lists.
 */

import type { EntityAllowlist } from "./allowlist.js";
import type { PolicyLayer } from "./layered-policy.js";

/** Shape guard for one policy layer; mirrors layered-policy's `assertLayer`. */
function assertLayerShape(layer: PolicyLayer, name: "environment" | "role"): void {
  if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
    throw new TypeError(`intersectEntityPolicies: ${name} policy layer must be an object`);
  }
  for (const list of ["entityAllowlist", "entityDenylist"] as const) {
    if (layer[list] !== undefined && !Array.isArray(layer[list])) {
      throw new TypeError(`intersectEntityPolicies: ${name}.${list} must be an array when present`);
    }
  }
}

/**
 * The INTERSECTION of the environment ceiling and the role narrowing, as one
 * value accepted wherever a legacy `entityAllowlist` array is accepted.
 *
 * The returned composite is shallow-frozen and keeps both layer objects BY
 * REFERENCE: callers hand it the same lists the rest of the config reads.
 * Keep the environment's own `entityDenylist` configured beside it — the
 * helpers enforce it too, and `intersectEntityPolicies` expects it folded
 * into `environment` (denying twice is idempotent).
 */
export function intersectEntityPolicies(environment: PolicyLayer, role: PolicyLayer): EntityAllowlist {
  assertLayerShape(environment, "environment");
  assertLayerShape(role, "role");
  return Object.freeze({ kind: "composite" as const, environment, role });
}
