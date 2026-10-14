/**
 * Response size guard for what is returned to the LLM client (D-75/FR-86).
 *
 * The cap applies ONLY to tool output that reaches the model. Internal uses of
 * data (the $metadata used for classification, the disk cache, hydration) never
 * pass through here and are exempt. It is purely size-based: it never consults a
 * list of known entities.
 */

import { SanitizedError } from "./errors.js";

/** Maximum UTF-8 size of one result returned to the model (256 KiB). */
export const MAX_RESPONSE_BYTES = 256 * 1024;

export function responseBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function exceedsResponseCap(text: string): boolean {
  return responseBytes(text) > MAX_RESPONSE_BYTES;
}

/** Sanitized, actionable error: says how to narrow the query, never echoes data. */
export function responseTooLargeError(text: string): SanitizedError {
  const actualKb = Math.ceil(responseBytes(text) / 1024);
  const capKb = MAX_RESPONSE_BYTES / 1024;
  return new SanitizedError(
    "RESPONSE_TOO_LARGE",
    `the response is about ${actualKb} KB, above the ${capKb} KB limit for results returned to the model; ` +
      "narrow the query with $select (fewer fields), $top (fewer records) or $filter, " +
      "and avoid $expand of collections; to explore a schema use the sf://{env}/entities resources one entity at a time",
  );
}
