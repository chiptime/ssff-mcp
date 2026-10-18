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
  | { kind: "permitted"; reached: string }
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
 * already decided it. `reached` is the entity set the path ends at, which is the
 * one an `$expand` on the same request applies to.
 *
 * A hop that cannot be resolved is REPORTED, never handed to the service.
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
  return { kind: "permitted", reached: current };
}

/**
 * Check every route of a parsed `$expand` value, each starting from
 * `baseEntitySet`: the entity set the request's PATH reached, not necessarily
 * the first path segment. Expanding from the wrong base both rejects legitimate
 * queries and lets a denied destination through.
 */
export async function checkExpandRoutes(
  baseEntitySet: string,
  routes: readonly (readonly string[])[],
  allowlist: AllowlistEntry[] | undefined,
  denylist: AllowlistEntry[] | undefined,
  lookup: NavigationLookup,
): Promise<NavigationVerdict> {
  for (const route of routes) {
    const verdict = await checkNavigationPath(
      [baseEntitySet, ...route],
      allowlist,
      denylist,
      lookup,
    );
    if (verdict.kind !== "permitted") {
      return verdict;
    }
  }
  return { kind: "permitted", reached: baseEntitySet };
}

/**
 * Navigation ROUTES referenced by a `$filter`/`$orderby` expression.
 *
 * Only the production-verified shapes matter: `<navProp>/<field> eq '<value>'`
 * and `and`/`or` combinations of it. Rather than parsing the whole OData
 * expression language, this scans for `name/name[/name...]` sequences OUTSIDE
 * single-quoted literals (with `''` escaping) and returns the leading
 * navigations of each — the last element is a property, not a navigation.
 *
 * A slash inside a literal is never mistaken for a path, and a plain scalar
 * field yields no route at all.
 */
export function navigationPathsInExpression(raw: string): string[][] {
  const routes: string[][] = [];
  const isNameStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
  const isNamePart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "'") {
      // Skip the literal, honouring OData's doubled-quote escape.
      index += 1;
      while (index < raw.length) {
        if (raw[index] === "'") {
          if (raw[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (!isNameStart(char)) {
      index += 1;
      continue;
    }
    const parts: string[] = [];
    for (;;) {
      const start = index;
      while (isNamePart(raw[index])) {
        index += 1;
      }
      parts.push(raw.slice(start, index));
      if (raw[index] !== "/") {
        break;
      }
      index += 1;
      if (!isNameStart(raw[index])) {
        break;
      }
    }
    // The final element is a property; the navigations are everything before it.
    if (parts.length > 1) {
      routes.push(parts.slice(0, -1));
    }
  }
  return routes;
}

