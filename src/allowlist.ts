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
 */

/** Protocols an allowlist entry may enable. */
export type AllowlistProtocol = "v2" | "v4";

/** One `entityAllowlist` / `entityDenylist` entry as parsed from config. */
export interface AllowlistEntry {
  /** OData entity set name; case-sensitive exact match. */
  entity: string;
  /** Omitted = both protocols (D-15); otherwise a non-empty, duplicate-free subset. */
  protocols?: AllowlistProtocol[];
}

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
 * Pure check: may `entityName` be queried under `allowlist` via `protocol`?
 *
 * - `allowlist` undefined OR empty => allowed: the list only narrows, and a list
 *   that adds nothing narrows nothing.
 * - Entity not listed => denied.
 * - Entry listed with `protocols` omitted => allowed on any protocol.
 * - Entry listed with `protocols` => allowed only when `protocol` is included.
 */
export function isEntityAllowed(
  allowlist: AllowlistEntry[] | undefined,
  entityName: string,
  protocol: AllowlistProtocol = "v2",
): boolean {
  if (allowlist === undefined || allowlist.length === 0) {
    return true;
  }
  return listsEntity(allowlist, entityName, protocol);
}

/**
 * Final decision for one entity: the DENYLIST wins over the allowlist.
 *
 * - An entity named in `denylist` (for `protocol`) is denied, whatever the
 *   allowlist says.
 * - Otherwise the allowlist decides, with the semantics of `isEntityAllowed`.
 */
export function isEntityPermitted(
  allowlist: AllowlistEntry[] | undefined,
  denylist: AllowlistEntry[] | undefined,
  entityName: string,
  protocol: AllowlistProtocol = "v2",
): boolean {
  if (listsEntity(denylist, entityName, protocol)) {
    return false;
  }
  return isEntityAllowed(allowlist, entityName, protocol);
}
