/**
 * `$expand` parser for the subset the server can PROVE.
 *
 * `$expand` used to be passed straight through, which made it a hole in the
 * allowlist: the value names NavigationProperties, so anything in it reached an
 * entity set that was never checked.
 *
 * It now yields both the navigation routes AND the `$select` property lists, so
 * the caller can check every reference against the metadata: a `$select` that
 * names an association of the expanded entity reaches a denied entity just as
 * surely as a route does.
 *
 * Anything the parser cannot prove is rejected with `OPTION_INVALID`, never
 * dispatched: a value the server half-understands is exactly where a restriction
 * silently stops applying.
 *
 * Supported: `A`, `A,B`, `A/B`, nested `A($expand=B/C)`, and `$select` with a
 * plain comma-separated property list.
 * Rejected: percent-encoded characters (SuccessFactors decodes them, so an
 * encoded `;` would hide a nested expand from this parser while the service still
 * honoured it), `$filter`/`$orderby` and any other sub-option, wildcards, and
 * anything else unparseable.
 */

/** A `$select` list attached to the entity a route reaches. */
export interface ExpandSelection {
  /** Route whose destination entity the `$select` applies to. */
  route: string[];
  properties: string[];
}

export type ExpandParse =
  | { ok: true; routes: string[][]; selections: ExpandSelection[] }
  | { ok: false; reason: string };

interface Cursor {
  readonly text: string;
  index: number;
}

interface ParsedChunk {
  routes: string[][];
  selections: ExpandSelection[];
}

class ExpandSyntaxError extends Error {}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPTION = /^\$[A-Za-z]+/;

function skipSpace(cursor: Cursor): void {
  while (/\s/.test(cursor.text[cursor.index] ?? "")) {
    cursor.index += 1;
  }
}

function peek(cursor: Cursor): string {
  skipSpace(cursor);
  return cursor.text[cursor.index] ?? "";
}

function take(cursor: Cursor, expected: string): boolean {
  if (peek(cursor) === expected) {
    cursor.index += 1;
    return true;
  }
  return false;
}

function expect(cursor: Cursor, expected: string): void {
  if (!take(cursor, expected)) {
    throw new ExpandSyntaxError(`expected "${expected}"`);
  }
}

function read(cursor: Cursor, pattern: RegExp, what: string): string {
  skipSpace(cursor);
  const match = pattern.exec(cursor.text.slice(cursor.index));
  if (match === null) {
    throw new ExpandSyntaxError(`expected ${what}`);
  }
  cursor.index += match[0].length;
  return match[0];
}

/**
 * `$select` carries property names. It is parsed into a list instead of being
 * skipped, so its names can be checked against the metadata and so no unbalanced
 * or structural syntax can ride along unexamined.
 */
function parseSelectList(cursor: Cursor): string[] {
  const properties: string[] = [];
  for (;;) {
    properties.push(read(cursor, IDENT, "a property name"));
    // `take` skips surrounding whitespace: `a , b` is an ordinary property list.
    if (!take(cursor, ",")) {
      return properties;
    }
  }
}

function parseRoutes(cursor: Cursor): ParsedChunk {
  const chunk: ParsedChunk = { routes: [], selections: [] };
  for (;;) {
    const route = parseRoute(cursor);
    chunk.routes.push(...route.routes);
    chunk.selections.push(...route.selections);
    if (!take(cursor, ",")) {
      return chunk;
    }
  }
}

function parseRoute(cursor: Cursor): ParsedChunk {
  const base: string[] = [];
  for (;;) {
    base.push(read(cursor, IDENT, "a navigation property name"));
    if (take(cursor, "(")) {
      const nested: ParsedChunk = { routes: [], selections: [] };
      for (;;) {
        const option = read(cursor, OPTION, "an expand option");
        if (option === "$select") {
          expect(cursor, "=");
          nested.selections.push({ route: [], properties: parseSelectList(cursor) });
        } else if (option === "$expand") {
          expect(cursor, "=");
          const inner = parseRoutes(cursor);
          nested.routes.push(...inner.routes);
          nested.selections.push(...inner.selections);
        } else {
          throw new ExpandSyntaxError(`unsupported expand option "${option}"`);
        }
        if (!take(cursor, ";")) {
          break;
        }
      }
      expect(cursor, ")");
      // Everything nested hangs off the entity this route's last segment reached.
      return {
        routes: [base, ...nested.routes.map((route) => [...base, ...route])],
        selections: nested.selections.map((selection) => ({
          route: [...base, ...selection.route],
          properties: selection.properties,
        })),
      };
    }
    if (take(cursor, "/")) {
      continue;
    }
    return { routes: [base], selections: [] };
  }
}

/**
 * Parse an `$expand` value into the navigation routes and `$select` lists it
 * selects. Every failure is a rejection: the caller must not dispatch.
 */
export function parseExpand(raw: string): ExpandParse {
  if (raw.trim().length === 0) {
    return { ok: true, routes: [], selections: [] };
  }
  if (raw.includes("%")) {
    return {
      ok: false,
      reason:
        "percent-encoded characters are not accepted: the service decodes them, so they can hide structure this parser would not check",
    };
  }
  const cursor: Cursor = { text: raw, index: 0 };
  try {
    const chunk = parseRoutes(cursor);
    if (peek(cursor) !== "") {
      return { ok: false, reason: `unexpected "${cursor.text[cursor.index]}"` };
    }
    return { ok: true, routes: chunk.routes, selections: chunk.selections };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid expand" };
  }
}
