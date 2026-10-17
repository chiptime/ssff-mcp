/**
 * `$expand` parser for the subset the server can PROVE.
 *
 * `$expand` used to be passed straight through, which made it a hole in the
 * allowlist: the value names NavigationProperties, so anything in it reached an
 * entity set that was never checked.
 *
 * Only the navigation structure is extracted — the entity sets to check. Anything
 * the parser cannot prove is rejected with `OPTION_INVALID`, never dispatched:
 * a value the server half-understands is exactly where a restriction silently
 * stops applying.
 *
 * Supported: `A`, `A,B`, `A/B`, nested `A($expand=B/C)`, and `$select` sub-options
 * (which carry properties, not entities, so they are skipped).
 * Rejected: `$filter`/`$orderby` and any other sub-option (they belong to the
 * filter vector), plus wildcards and anything unparseable.
 */

export type ExpandParse =
  | { ok: true; routes: string[][] }
  | { ok: false; reason: string };

interface Cursor {
  readonly text: string;
  index: number;
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

/** `$select` carries property names, not entities: consume it without interpreting it. */
function skipValue(cursor: Cursor): void {
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index]!;
    if (char === ";" || char === ")") {
      return;
    }
    cursor.index += 1;
  }
  throw new ExpandSyntaxError("unterminated expand option");
}

function parseRoutes(cursor: Cursor): string[][] {
  const routes: string[][] = [];
  for (;;) {
    routes.push(...parseRoute(cursor));
    if (!take(cursor, ",")) {
      return routes;
    }
  }
}

function parseRoute(cursor: Cursor): string[][] {
  const base: string[] = [];
  for (;;) {
    base.push(read(cursor, IDENT, "a navigation property name"));
    if (take(cursor, "(")) {
      const nested: string[][] = [];
      for (;;) {
        const option = read(cursor, OPTION, "an expand option");
        if (option === "$select") {
          expect(cursor, "=");
          skipValue(cursor);
        } else if (option === "$expand") {
          expect(cursor, "=");
          nested.push(...parseRoutes(cursor));
        } else {
          throw new ExpandSyntaxError(`unsupported expand option "${option}"`);
        }
        if (!take(cursor, ";")) {
          break;
        }
      }
      expect(cursor, ")");
      // Nested routes hang off the entity this route's last segment reached.
      return [base, ...nested.map((route) => [...base, ...route])];
    }
    if (take(cursor, "/")) {
      continue;
    }
    return [base];
  }
}

/**
 * Parse an `$expand` value into the navigation routes it selects.
 * Every failure is a rejection: the caller must not dispatch.
 */
export function parseExpand(raw: string): ExpandParse {
  if (raw.trim().length === 0) {
    return { ok: true, routes: [] };
  }
  const cursor: Cursor = { text: raw, index: 0 };
  try {
    const routes = parseRoutes(cursor);
    if (peek(cursor) !== "") {
      return { ok: false, reason: `unexpected "${cursor.text[cursor.index]}"` };
    }
    return { ok: true, routes };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid expand" };
  }
}
