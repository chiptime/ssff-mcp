/**
 * Response size guard for what is returned to the LLM client (D-75/FR-86).
 *
 * The cap applies ONLY to tool output that reaches the model. Internal uses of
 * data (the $metadata used for classification, the disk cache, hydration) never
 * pass through here and are exempt. It is purely size-based: it never consults a
 * list of known entities.
 */

import { SanitizedError } from "./errors.js";

/** Default maximum UTF-8 size of one result returned to the model (256 KiB). */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Effective cap for this process: `SF_MAX_RESPONSE_BYTES` when it holds a
 * positive integer, otherwise the 256 KiB default. Mirrors how
 * `SF_DEFAULT_LOCALE` overrides `defaultLocale` (i18n.ts).
 */
export function resolveMaxResponseBytes(): number {
  const raw = process.env.SF_MAX_RESPONSE_BYTES;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return MAX_RESPONSE_BYTES;
}

export function responseBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function exceedsResponseCap(text: string, capBytes: number = resolveMaxResponseBytes()): boolean {
  return responseBytes(text) > capBytes;
}

/** Sanitized, actionable error: says how to narrow the query, never echoes data. */
export function responseTooLargeError(text: string, capBytes: number = resolveMaxResponseBytes()): SanitizedError {
  const actualKb = Math.ceil(responseBytes(text) / 1024);
  const capKb = Math.ceil(capBytes / 1024);
  return new SanitizedError(
    "RESPONSE_TOO_LARGE",
    `the response is about ${actualKb} KB, above the ${capKb} KB limit for results returned to the model; ` +
      "narrow the query with $select (fewer fields), $top (fewer records) or $filter, " +
      "and avoid $expand of collections; to explore a schema use the sf://{env}/entities resources one entity at a time",
  );
}
