/**
 * Entity allowlist: pure decision logic (FR-28, D-30 with D-15 semantics).
 *
 * - The allowlist is optional config: absent means NO restriction (everything
 *   the tenant account can read is reachable).
 * - Present means only the listed entity sets are queryable; an entity
 *   absent from the list is denied (fail-closed).
 * - An EMPTY array `[]` is a configured allowlist that denies everything.
 * - Matching is case-sensitive and exact against the OData entity set name
 *   (the FIRST path segment's name; navigation segments after it are never
 *   re-checked once the first segment is allowed).
 * - `protocols` per entry: omitted means "both protocols" (D-15). v2 is the
 *   only active protocol in this phase, so an entry that excludes v2 (for
 *   example `protocols: ["v4"]`) is denied (DS-P2-03).
 * - `$metadata` is never filtered by the allowlist (FR-28/D-15); that rule
 *   lives in the tool layer, not here.
 */

/** Protocols an allowlist entry may enable. */
export type AllowlistProtocol = "v2" | "v4";

/** One `entityAllowlist` entry as parsed from config. */
export interface AllowlistEntry {
  /** OData entity set name; case-sensitive exact match. */
  entity: string;
  /** Omitted = both protocols (D-15); otherwise a non-empty, duplicate-free subset. */
  protocols?: AllowlistProtocol[];
}

/**
 * Pure check: may `entityName` be queried under `allowlist` via `protocol`?
 *
 * - `allowlist` undefined => allowed (no allowlist configured).
 * - Entity not listed => denied.
 * - Entry listed with `protocols` omitted => allowed on any protocol.
 * - Entry listed with `protocols` => allowed only when `protocol` is included.
 */
export function isEntityAllowed(
  allowlist: AllowlistEntry[] | undefined,
  entityName: string,
  protocol: AllowlistProtocol = "v2",
): boolean {
  if (allowlist === undefined) {
    return true;
  }
  const entry = allowlist.find((candidate) => candidate.entity === entityName);
  if (entry === undefined) {
    return false;
  }
  return entry.protocols === undefined || entry.protocols.includes(protocol);
}
