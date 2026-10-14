/**
 * OData v2 read-shape handling: entity path grammar validation, query option
 * assembly, pagination ceiling and response unwrapping.
 *
 * The path grammar is validated BEFORE any network dispatch: anything that is
 * not a plain entity/property read shape (system resources like `$batch`,
 * `$value`, `$links`, `$count`, `$metadata`, malformed predicates, control
 * characters...) is rejected with PATH_INVALID.
 */

import { SanitizedError } from "./errors.js";

export const RECORD_CEILING = 1000;
export const MAX_SKIP = 1_000_000;
export const MAX_PATH_LENGTH = 512;
export const MAX_SEGMENTS = 4;

const NAME_PATTERN = "[A-Za-z_][A-Za-z0-9_]*";
const SEGMENT_NAME = new RegExp(`^${NAME_PATTERN}$`);

// OData v2 key predicate values (matched case-insensitively, see SEGMENT):
// - a single-quoted string body ('It''s' doubling allowed; `:`, `-`, `/` etc.
//   are plain body characters), optionally preceded by a type prefix such as
//   datetime'2013-01-01T00:00:00', guid'...' or X'0A0B';
// - true, false or null;
// - an optionally signed integer/decimal with an optional numeric type suffix
//   (860259L, 1.5f, 2D, 3m).
// Raw `%` is still only legal inside a quoted body, never elsewhere (FR-77).
const QUOTED = `'(?:[^']|'')*'`;
const TYPE_PREFIX = `(?:datetimeoffset|datetime|time|guid|binary|X|decimal|float|double)`;
const LITERAL = `(?:${TYPE_PREFIX}?${QUOTED}|true|false|null|-?\\d+(?:\\.\\d+)?[LfFdDmM]?)`;
const PAIR = `${NAME_PATTERN}\\s*=\\s*${LITERAL}`;
const PREDICATE_ITEM = `(?:${PAIR}|${LITERAL})`;
const PREDICATE = `\\(\\s*(?:${PREDICATE_ITEM}(?:\\s*,\\s*${PREDICATE_ITEM})*)?\\s*\\)`;
// The `i` flag makes type prefixes, true/false/null and numeric suffixes
// case-insensitive (real $metadata and callers use both cases); NAME_PATTERN
// already covers both cases, so it is unaffected.
const SEGMENT = new RegExp(`^${NAME_PATTERN}(?:${PREDICATE})?$`, "i");

// CR, LF and NUL are never legal in a query option value (FR-80).
const CONTROL_CHARACTERS = /[\r\n\0]/;

// Effective-dating option values (fromDate/toDate/asOfDate) are plain dates.
const EFFECTIVE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidatedPath {
  segments: string[];
  firstSegmentName: string;
}

/**
 * Split a path on `/` while respecting single-quoted string literals (a `/`
 * inside quotes does not split). Returns null for unbalanced quotes.
 */
function splitSegments(entityPath: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of entityPath) {
    if (inQuote) {
      current += ch;
      if (ch === "'") {
        inQuote = false;
      }
    } else if (ch === "'") {
      inQuote = true;
      current += ch;
    } else if (ch === "/") {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (inQuote) {
    return null;
  }
  segments.push(current);
  return segments;
}

/** Validate the entity path grammar. Throws PATH_INVALID (never echoes the path). */
export function validateEntityPath(entityPath: string): ValidatedPath {
  if (typeof entityPath !== "string" || entityPath.length === 0) {
    throw new SanitizedError("PATH_INVALID", "entity path must be a non-empty string");
  }
  if (entityPath.length > MAX_PATH_LENGTH) {
    throw new SanitizedError("PATH_INVALID", `entity path exceeds the maximum length of ${MAX_PATH_LENGTH} characters`);
  }
  const segments = splitSegments(entityPath);
  if (segments === null) {
    throw new SanitizedError("PATH_INVALID", "entity path contains an unterminated string literal");
  }
  if (segments.length > MAX_SEGMENTS) {
    throw new SanitizedError("PATH_INVALID", `entity path exceeds the maximum of ${MAX_SEGMENTS} segments`);
  }
  for (const segment of segments) {
    if (segment.startsWith("$")) {
      // Blocks $batch, $count, $value, $links, $metadata, ...
      throw new SanitizedError(
        "PATH_INVALID",
        "system resource paths ($batch, $count, $value, $links, $metadata) are not supported",
      );
    }
    if (!SEGMENT.test(segment)) {
      throw new SanitizedError("PATH_INVALID", "entity path segment is invalid");
    }
  }
  const firstSegmentName = segments[0]!.replace(/\(.*/, "");
  return { segments, firstSegmentName };
}

export interface QueryOptions {
  filter?: string;
  orderby?: string;
  select?: string;
  expand?: string;
  /** Effective-dating window start (`YYYY-MM-DD`). Emitted BARE (`fromDate=`), never `$fromDate`. */
  fromDate?: string;
  /** Effective-dating window end (`YYYY-MM-DD`). Emitted BARE (`toDate=`), never `$toDate`. */
  toDate?: string;
  /** Effective-dating point in time (`YYYY-MM-DD`). Emitted BARE; mutually exclusive with fromDate/toDate. */
  asOfDate?: string;
  top?: number;
  skip?: number;
  /** Adds `$inlinecount=allpages` (the only accepted value, D-31). */
  inlinecount?: "allpages";
  /** Opaque continuation token extracted from a validated cursor (FR-25). Percent-encoded as `$skiptoken`. */
  skiptoken?: string;
}

export interface BuiltQuery {
  /** Path plus optional query string, relative to the service root. */
  pathAndQuery: string;
  topClamped: boolean;
}

/** Validate option bounds (sanitized OPTION_INVALID errors) and assemble the query string. */
export function buildQuery(entityPath: string, options: QueryOptions): BuiltQuery {
  const { top, skip } = options;
  if (top !== undefined) {
    if (!Number.isInteger(top) || top < 1) {
      throw new SanitizedError("OPTION_INVALID", "top must be an integer greater than or equal to 1");
    }
  }
  if (skip !== undefined) {
    if (!Number.isInteger(skip) || skip < 0 || skip > MAX_SKIP) {
      throw new SanitizedError("OPTION_INVALID", `skip must be an integer between 0 and ${MAX_SKIP}`);
    }
  }

  // Control characters would let a value inject extra HTTP request lines or
  // headers inside the `$batch` multipart envelope. The message never echoes
  // the offending value (it may carry business keys).
  for (const name of ["filter", "orderby", "select", "expand"] as const) {
    const value = options[name];
    if (value !== undefined && CONTROL_CHARACTERS.test(value)) {
      throw new SanitizedError("OPTION_INVALID", `${name} must not contain carriage return, line feed or NUL characters`);
    }
  }

  // Effective-dating options are validated before anything is assembled. The
  // messages state the expected format and never echo the submitted value.
  for (const name of ["fromDate", "toDate", "asOfDate"] as const) {
    const value = options[name];
    if (value !== undefined && value.length > 0 && !EFFECTIVE_DATE.test(value)) {
      throw new SanitizedError("OPTION_INVALID", `${name} must be a date in YYYY-MM-DD format`);
    }
  }
  if (
    options.asOfDate !== undefined &&
    options.asOfDate.length > 0 &&
    ((options.fromDate !== undefined && options.fromDate.length > 0) ||
      (options.toDate !== undefined && options.toDate.length > 0))
  ) {
    throw new SanitizedError("OPTION_INVALID", "asOfDate cannot be combined with fromDate or toDate");
  }

  const topClamped = top !== undefined && top > RECORD_CEILING;
  const pairs: string[] = [];
  // $filter/$orderby/$select/$expand bypass URLSearchParams (which would turn
  // spaces into `+` and percent-encode `'`, `,`, `(`, `/`...). Only spaces are
  // encoded, uniformly as `%20`; every other character is emitted literally.
  addRawIfPresent(pairs, "$filter", options.filter);
  addRawIfPresent(pairs, "$orderby", options.orderby);
  addRawIfPresent(pairs, "$select", options.select);
  addRawIfPresent(pairs, "$expand", options.expand);
  // Effective-dating options are BARE names: SuccessFactors silently ignores
  // `$fromDate`/`$toDate`/`$asOfDate` and falls back to the active slice. The
  // values are already restricted to YYYY-MM-DD above, so no encoding is needed.
  // Full emission order (deterministic): $filter, $orderby, $select, $expand,
  // fromDate, toDate, asOfDate, $top, $skip, $inlinecount, $skiptoken.
  addRawIfPresent(pairs, "fromDate", options.fromDate);
  addRawIfPresent(pairs, "toDate", options.toDate);
  addRawIfPresent(pairs, "asOfDate", options.asOfDate);
  if (top !== undefined) {
    pairs.push(`$top=${topClamped ? RECORD_CEILING : top}`);
  }
  if (skip !== undefined && skip > 0) {
    pairs.push(`$skip=${skip}`);
  }
  if (options.inlinecount === "allpages") {
    pairs.push("$inlinecount=allpages");
  }
  // The skiptoken is opaque (never interpreted or rewritten, D-27 / A-P2-3) but
  // MUST be percent-encoded: `extractSkiptoken` decodes it through
  // `URL.searchParams.get("$skiptoken")`, so the round-trip is only
  // byte-identical when it is encoded here, and the JSON braces/quotes of a
  // token such as {"startRow":1000,"endRow":2000} must never break the HTTP
  // request line inside a `$batch` multipart envelope.
  if (options.skiptoken !== undefined && options.skiptoken.length > 0) {
    pairs.push(`$skiptoken=${encodeURIComponent(options.skiptoken)}`);
  }

  const queryString = pairs.join("&");
  return {
    pathAndQuery: queryString.length > 0 ? `${entityPath}?${queryString}` : entityPath,
    topClamped,
  };
}

function addRawIfPresent(pairs: string[], name: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    pairs.push(`${name}=${value.replace(/ /g, "%20")}`);
  }
}

export interface UnwrappedFeed {
  records: unknown[];
  hasMore: boolean;
  truncatedToCeiling: boolean;
  /** Raw `__next` URL when present (internal only; never returned to the model). */
  nextUrl: string | null;
  /** Total from `d.__count` when the service provides a usable value, else null. */
  totalCount: number | null;
}

/**
 * Parse `d.__count` into a finite integer >= 0. Accepts number or numeric
 * string; anything else yields null (totalCount is then omitted).
 */
export function parseTotalCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Unwrap an OData v2 JSON body:
 * - feed `{ d: { results: [...], __next?: string } }` -> records = d.results
 * - single entity `{ d: { ... } }` -> records = [d]
 * Records are preserved verbatim (no field normalization, `__metadata` kept).
 * The `__next` URL is never meant for the model: it is returned internally as
 * `nextUrl` so callers can extract the continuation token; `hasMore` merely
 * reports that a next page exists.
 */
export function unwrapODataV2(body: unknown): UnwrappedFeed {
  if (typeof body !== "object" || body === null || !("d" in body)) {
    throw new SanitizedError("RESPONSE_INVALID", "the service response is not an OData v2 JSON document");
  }
  const d = (body as { d: unknown }).d;
  if (typeof d !== "object" || d === null || Array.isArray(d)) {
    throw new SanitizedError("RESPONSE_INVALID", "the service response is not an OData v2 JSON document");
  }

  let records: unknown[];
  let hasMore = false;
  let nextUrl: string | null = null;
  if (Array.isArray((d as { results?: unknown }).results)) {
    records = (d as { results: unknown[] }).results;
    const next = (d as { __next?: unknown }).__next;
    if (typeof next === "string" && next.length > 0) {
      hasMore = true;
      nextUrl = next;
    }
  } else {
    records = [d];
  }

  const totalCount = parseTotalCount((d as { __count?: unknown }).__count);

  let truncatedToCeiling = false;
  if (records.length > RECORD_CEILING) {
    records = records.slice(0, RECORD_CEILING);
    truncatedToCeiling = true;
  }

  return { records, hasMore, truncatedToCeiling, nextUrl, totalCount };
}

/**
 * Extract the raw `$skiptoken` query parameter from a service-provided next
 * URL. Returns null for malformed URLs or when no usable token is present.
 * The token is opaque: returned as-is, never interpreted.
 */
export function extractSkiptoken(nextUrl: string): string | null {
  let url: URL | null = null;
  try {
    url = new URL(nextUrl);
  } catch {
    // Tolerate root-relative next links; anything else is unusable.
    try {
      url = new URL(nextUrl, "https://ssff-mcp.invalid/");
    } catch {
      return null;
    }
  }
  const token = url.searchParams.get("$skiptoken");
  if (token === null || token.length === 0) {
    return null;
  }
  return token;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface XmlPaging {
  /** True when a `<link rel="next" .../>` with an href is present. */
  hasMore: boolean;
  /** Decoded href of the next link (internal only; never returned to the model). */
  nextUrl: string | null;
  /** Total from `<m:count>` when it parses as a usable integer, else null. */
  totalCount: number | null;
  /** Number of `<entry>` elements (used to enforce the response ceiling). */
  entryCount: number;
}

/**
 * Extract paging facts from a raw OData v2 Atom XML body: next link, inline
 * count and entry count. Pure regex (bodies can be huge; no full parse).
 */
export function extractXmlPaging(xml: string): XmlPaging {
  let nextUrl: string | null = null;
  for (const match of xml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel="next"/.test(tag)) {
      continue;
    }
    const href = /\bhref="([^"]*)"/.exec(tag);
    if (href !== null && href[1]!.length > 0) {
      nextUrl = decodeXmlEntities(href[1]!);
    }
    break;
  }
  const countMatch = /<m:count[^>]*>([\s\S]*?)<\/m:count>/.exec(xml);
  const totalCount = countMatch === null ? null : parseTotalCount(countMatch[1]);
  const entryCount = (xml.match(/<entry[\s>]/g) ?? []).length;
  return { hasMore: nextUrl !== null, nextUrl, totalCount, entryCount };
}

// rel="next" (double or single quotes) inside a link tag. Non-global: no
// lastIndex state, safe for repeated .test() calls.
const REL_IS_NEXT = /\brel\s*=\s*(?:"next"|'next')/;
// The href attribute of a link tag, including its leading whitespace, so
// removing it never leaves a double space inside the tag.
const HREF_ATTRIBUTE = /\s+href\s*=\s*(?:"[^"]*"|'[^']*')/;

/**
 * Return `xml` with the `href` attribute removed from every Atom `<link>`
 * element whose `rel` is exactly `next` — tolerating single or double quotes,
 * any attribute order and an optional element namespace prefix. Everything
 * else (non-next links, all other elements and whitespace) is preserved
 * byte-for-byte, and a body with no next link is returned unchanged.
 *
 * This applies the D-27 cursor-opacity contract to the D-32 raw XML output
 * (DS-P2-06): paging facts (`hasMore`/cursor) are extracted from the ORIGINAL
 * body by `extractXmlPaging` BEFORE this runs, so the returned body must
 * never carry the service next URL or the raw `$skiptoken`.
 */
export function sanitizeXmlNextLinks(xml: string): string {
  return xml.replace(/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?link\b[^>]*>/g, (tag) => {
    if (!REL_IS_NEXT.test(tag)) {
      return tag;
    }
    return tag.replace(HREF_ATTRIBUTE, "");
  });
}
