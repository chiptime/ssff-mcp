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

// OData v2 key predicate values: single-quoted strings ('It''s' doubling
// allowed), integers/decimals, optionally signed.
const LITERAL = `(?:'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?)`;
const PAIR = `${NAME_PATTERN}\\s*=\\s*${LITERAL}`;
const PREDICATE_ITEM = `(?:${PAIR}|${LITERAL})`;
const PREDICATE = `\\(\\s*(?:${PREDICATE_ITEM}(?:\\s*,\\s*${PREDICATE_ITEM})*)?\\s*\\)`;
const SEGMENT = new RegExp(`^${NAME_PATTERN}(?:${PREDICATE})?$`);

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
  top?: number;
  skip?: number;
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

  const topClamped = top !== undefined && top > RECORD_CEILING;
  const params = new URLSearchParams();
  addIfPresent(params, "$filter", options.filter);
  addIfPresent(params, "$orderby", options.orderby);
  addIfPresent(params, "$select", options.select);
  addIfPresent(params, "$expand", options.expand);
  if (top !== undefined) {
    params.set("$top", String(topClamped ? RECORD_CEILING : top));
  }
  if (skip !== undefined && skip > 0) {
    params.set("$skip", String(skip));
  }

  const queryString = params.toString();
  return {
    pathAndQuery: queryString.length > 0 ? `${entityPath}?${queryString}` : entityPath,
    topClamped,
  };
}

function addIfPresent(params: URLSearchParams, name: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    params.set(name, value);
  }
}

export interface UnwrappedFeed {
  records: unknown[];
  hasMore: boolean;
  truncatedToCeiling: boolean;
}

/**
 * Unwrap an OData v2 JSON body:
 * - feed `{ d: { results: [...], __next?: string } }` -> records = d.results
 * - single entity `{ d: { ... } }` -> records = [d]
 * Records are preserved verbatim (no field normalization, `__metadata` kept).
 * The `__next` URL is never returned, only reported via `hasMore`.
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
  if (Array.isArray((d as { results?: unknown }).results)) {
    records = (d as { results: unknown[] }).results;
    const next = (d as { __next?: unknown }).__next;
    hasMore = typeof next === "string" && next.length > 0;
  } else {
    records = [d];
  }

  let truncatedToCeiling = false;
  if (records.length > RECORD_CEILING) {
    records = records.slice(0, RECORD_CEILING);
    truncatedToCeiling = true;
  }

  return { records, hasMore, truncatedToCeiling };
}
