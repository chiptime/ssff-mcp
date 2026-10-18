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
import type { ExpandSelection } from "./expand.js";

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
 * Check every reference of a query option against the lists, starting from the
 * entity set the request reached.
 *
 * A `path` is walked through its navigations (every segment but the last, which
 * is a property). A bare `name` only matters when it IS a navigation of that
 * entity — `$select=empInfo` names the denied `EmpEmployment` and is rejected,
 * while `$select=userId` passes untouched.
 */
export async function checkExpressionReferences(
  rootEntitySet: string,
  references: readonly ExpressionReference[],
  allowlist: AllowlistEntry[] | undefined,
  denylist: AllowlistEntry[] | undefined,
  lookup: NavigationLookup,
): Promise<NavigationVerdict> {
  for (const reference of references) {
    if (reference.kind === "path") {
      const navigations = reference.segments.slice(0, -1);
      if (navigations.length === 0) {
        continue;
      }
      const verdict = await checkNavigationPath(
        [rootEntitySet, ...navigations],
        allowlist,
        denylist,
        lookup,
      );
      if (verdict.kind !== "permitted") {
        return verdict;
      }
      continue;
    }
    const target = await lookup(rootEntitySet, reference.name);
    if (target !== undefined && !isEntityPermitted(allowlist, denylist, target)) {
      return { kind: "denied", entitySet: target };
    }
  }
  return { kind: "permitted", reached: rootEntitySet };
}

/**
 * Check the `$select` lists attached to `$expand` routes.
 *
 * A property that IS a navigation of the expanded entity reaches a denied entity
 * even though it only returns a `__deferred` link, so it is rejected like any
 * other reference. Scalar properties pass untouched.
 */
export async function checkExpandSelections(
  baseEntitySet: string,
  selections: readonly ExpandSelection[],
  allowlist: AllowlistEntry[] | undefined,
  denylist: AllowlistEntry[] | undefined,
  lookup: NavigationLookup,
): Promise<NavigationVerdict> {
  for (const selection of selections) {
    const reached = await checkNavigationPath(
      [baseEntitySet, ...selection.route],
      allowlist,
      denylist,
      lookup,
    );
    if (reached.kind !== "permitted") {
      return reached;
    }
    const properties = selection.properties.map((name) => ({ kind: "name" as const, name }));
    const verdict = await checkExpressionReferences(
      reached.reached,
      properties,
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
 * A reference to a property or association found in a query option.
 *
 * - `path`: `A/B[/C]` — walk it from the root; every segment but the last is a
 *   navigation and its destination must be permitted.
 * - `name`: a BARE identifier. It only matters when it happens to be a
 *   NavigationProperty of the current entity (`$select=empInfo`,
 *   `$filter=empInfo ne null`); a scalar property is ignored.
 */
export type ExpressionReference =
  | { kind: "path"; segments: string[] }
  | { kind: "name"; name: string };

/**
 * Every property/association reference in a query option value.
 *
 * The requirement is that a denied entity is unreachable by ANY route, so this is
 * identifier-based rather than pattern-based: it scans OUTSIDE single-quoted
 * literals (honouring OData's `''` escape) and reports every identifier, whether
 * it stands alone or forms a `A/B` path. The caller decides what each one means
 * against the metadata.
 */
export function expressionReferences(raw: string): ExpressionReference[] {
  const references: ExpressionReference[] = [];
  const isNameStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
  const isNamePart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
  const skipSpaces = (from: number): number => {
    let at = from;
    while (/\s/.test(raw[at] ?? "")) {
      at += 1;
    }
    return at;
  };

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
    const segments: string[] = [];
    for (;;) {
      const start = index;
      while (isNamePart(raw[index])) {
        index += 1;
      }
      segments.push(raw.slice(start, index));
      // OData v2 does not accept whitespace around the slash, but tolerating it
      // is the fail-closed choice: the path gets CHECKED instead of ignored.
      const atSlash = skipSpaces(index);
      if (raw[atSlash] !== "/") {
        break;
      }
      const next = skipSpaces(atSlash + 1);
      if (!isNameStart(raw[next])) {
        break;
      }
      index = next;
    }
    references.push(
      segments.length === 1
        ? { kind: "name", name: segments[0]! }
        : { kind: "path", segments },
    );
  }
  return references;
}


