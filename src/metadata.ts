/**
 * $metadata validation support.
 *
 * Fetches and parses the EDMX `$metadata` document to extract EntitySet and
 * FunctionImport NAMES ONLY. Used exclusively to validate the first segment
 * of `entityPath` (function imports are excluded per PRD DS-04/FR-08).
 *
 * The cache is process-memory only, keyed by environment alias, with a 10
 * minute TTL. No XML documents and no response bodies are ever cached or
 * persisted. `get_metadata` (the tool) always hits the source fresh and never
 * uses this cache.
 */

import { XMLParser } from "fast-xml-parser";
import { SanitizedError } from "./errors.js";
import { dispatchGet, type EnvTarget, type FetchImpl } from "./http.js";

export const METADATA_TTL_MS = 10 * 60 * 1000;
const METADATA_TIMEOUT_MS = 60_000;

export interface MetadataNameSets {
  entitySets: Set<string>;
  functionImports: Set<string>;
}

interface CacheEntry {
  sets: MetadataNameSets;
  fetchedAt: number;
}

export type FirstSegmentVerdict =
  | { kind: "entity-set" }
  | { kind: "function-import" }
  | { kind: "unknown" };

/** Extract EntitySet / FunctionImport names from a parsed EDMX document. */
function collectNames(node: unknown, sets: MetadataNameSets): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectNames(item, sets);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "EntitySet" || key === "FunctionImport") {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (typeof item === "object" && item !== null) {
          // With attributes enabled, fast-xml-parser keys them as `@_Name`.
          const name = (item as Record<string, unknown>)["@_Name"];
          if (typeof name === "string" && name.length > 0) {
            if (key === "EntitySet") {
              sets.entitySets.add(name);
            } else {
              sets.functionImports.add(name);
            }
          }
        }
      }
    } else {
      collectNames(value, sets);
    }
  }
}

const parser = new XMLParser({
  // Attribute keys keep the default `@_` prefix; we only read `Name`.
  ignoreAttributes: false,
  removeNSPrefix: true,
  isArray: (name) => name === "EntitySet" || name === "FunctionImport",
});

export function parseMetadataXml(xml: string): MetadataNameSets {
  const sets: MetadataNameSets = { entitySets: new Set(), functionImports: new Set() };
  const parsed: unknown = parser.parse(xml);
  collectNames(parsed, sets);
  return sets;
}

export interface MetadataServiceOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  ttlMs?: number;
}

export class MetadataService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl?: FetchImpl;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: MetadataServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? METADATA_TTL_MS;
  }

  private async fetchNameSets(env: EnvTarget): Promise<MetadataNameSets> {
    let xml: string;
    try {
      const result = await dispatchGet(env, "$metadata", {
        accept: "application/xml",
        timeoutMs: METADATA_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
      });
      xml = result.body;
    } catch (error) {
      if (error instanceof SanitizedError && error.code === "HTTP_ERROR") {
        // The service answered with an HTTP error: keep the richer sanitized
        // error (e.g. 401 invalid credentials) instead of masking it.
        throw error;
      }
      // Fetch-level failures (network, timeout, blocked redirect) map to
      // METADATA_UNAVAILABLE.
      throw new SanitizedError(
        "METADATA_UNAVAILABLE",
        "metadata for the configured environment could not be retrieved",
      );
    }
    try {
      return parseMetadataXml(xml);
    } catch {
      throw new SanitizedError("METADATA_UNAVAILABLE", "metadata for the configured environment could not be parsed");
    }
  }

  async getNameSets(env: EnvTarget, alias: string): Promise<MetadataNameSets> {
    const entry = this.cache.get(alias);
    if (entry !== undefined && this.now() - entry.fetchedAt < this.ttlMs) {
      return entry.sets;
    }
    const sets = await this.fetchNameSets(env);
    this.cache.set(alias, { sets, fetchedAt: this.now() });
    return sets;
  }

  /** Classify the first path segment against the tenant metadata. */
  async classifyFirstSegment(env: EnvTarget, alias: string, segmentName: string): Promise<FirstSegmentVerdict> {
    const sets = await this.getNameSets(env, alias);
    if (sets.entitySets.has(segmentName)) {
      return { kind: "entity-set" };
    }
    if (sets.functionImports.has(segmentName)) {
      return { kind: "function-import" };
    }
    return { kind: "unknown" };
  }
}
