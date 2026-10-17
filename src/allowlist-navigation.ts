/**
 * Navigation enforcement for the entity allowlist/denylist.
 *
 * The allowlist is expressed in terms of **entity sets**, but a navigation
 * segment (and every `$expand` route) names a **NavigationProperty**. Comparing
 * names directly would be wrong in both directions, so each hop is resolved to
 * its `targetEntitySet` through the metadata and the destination is what gets
 * checked. The denylist wins, exactly as it does for direct access.
 */

import { isEntityPermitted, type AllowlistEntry } from "./allowlist.js";

/** Resolve `navigationName` declared on `fromEntitySet` to its target entity set. */
export type NavigationLookup = (
  fromEntitySet: string,
  navigationName: string,
) => Promise<string | undefined>;

export type NavigationVerdict =
  | { kind: "permitted" }
  | { kind: "denied"; entitySet: string }
  | { kind: "unresolvable"; navigationName: string };

/** The entity-set name of a path segment, with any key predicate removed: `User('1')` -> `User`. */
export function entitySetOfSegment(segment: string): string {
  const index = segment.indexOf("(");
  return index === -1 ? segment : segment.slice(0, index);
}

/**
 * Walk `segments` (as produced by `validateEntityPath`) and check every
 * navigation destination against the environment's lists.
 *
 * The first segment is the query root and is NOT re-checked here: the caller has
 * already decided it. Only a destination resolved from metadata is compared to
 * the lists, and a hop that cannot be resolved is reported instead of being
 * handed to the service.
 */
export async function checkNavigationPath(
  segments: readonly string[],
  allowlist: AllowlistEntry[] | undefined,
  denylist: AllowlistEntry[] | undefined,
  lookup: NavigationLookup,
): Promise<NavigationVerdict> {
  let current = entitySetOfSegment(segments[0] ?? "");
  for (const segment of segments.slice(1)) {
    const navigationName = entitySetOfSegment(segment);
    const target = await lookup(current, navigationName);
    if (target === undefined) {
      return { kind: "unresolvable", navigationName };
    }
    if (!isEntityPermitted(allowlist, denylist, target)) {
      return { kind: "denied", entitySet: target };
    }
    current = target;
  }
  return { kind: "permitted" };
}

/**
 * Check every route of a parsed `$expand` value, each starting from the root
 * entity set. Atomic: the first offending destination decides.
 */
export async function checkExpandRoutes(
  rootEntitySet: string,
  routes: readonly (readonly string[])[],
  allowlist: AllowlistEntry[] | undefined,
  denylist: AllowlistEntry[] | undefined,
  lookup: NavigationLookup,
): Promise<NavigationVerdict> {
  for (const route of routes) {
    const verdict = await checkNavigationPath(
      [rootEntitySet, ...route],
      allowlist,
      denylist,
      lookup,
    );
    if (verdict.kind !== "permitted") {
      return verdict;
    }
  }
  return { kind: "permitted" };
}
