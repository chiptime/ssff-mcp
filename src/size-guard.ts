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

let configuredMaxResponseBytes: number | undefined;

/**
 * Applies the `config.json` value (FR-86). Called on every config load, which
 * the server re-does per call, so the effective cap always tracks the live
 * configuration. `undefined` clears it and falls back to the environment.
 */
export function setMaxResponseBytes(configured?: number): void {
  configuredMaxResponseBytes = configured;
}

/**
 * Effective cap: `config.json` wins, then `SF_MAX_RESPONSE_BYTES` when it holds
 * a positive integer, then the 256 KiB default.
 */
export function resolveMaxResponseBytes(configured?: number): number {
  if (configured !== undefined) return configured;
  if (configuredMaxResponseBytes !== undefined) {
    return configuredMaxResponseBytes;
  }
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
