/**
 * Picklist resolution and caching subsystem (PRD-feature-picklists.md, D-53..D-61).
 *
 * Provides:
 * - Two-tier caching (L1 memory 24h, L2 disk 30d) for SAP picklist metadata.
 * - Bidirectional indexation (byOptionId, byExternalCode, byPicklistId, byLabel).
 * - Multi-lingual fallback degradation (FR-64).
 * - Safe internal fetches bypassing entityAllowlist (D-58 / FR-66).
 * - Fail-safe enrichment for query_entity and batch_get (D-57 / D-59 / FR-63 / FR-65).
 * - In-flight deduplication of concurrent requests (NFR-04).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { dispatchGet, type EnvTarget, type FetchImpl } from "./http.js";
import { defaultCacheDir, type EntitySchema } from "./metadata.js";
import { parseExpand } from "./expand.js";

export const PICKLIST_DISK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const PICKLIST_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours
export const MAX_CACHED_OPTIONS_PER_ENV = 50_000;             // DS-PL-05
const PICKLIST_FETCH_TIMEOUT_MS = 30_000;

export interface CachedPicklistOption {
  optionId: string;              // "10283" (Legacy ID or legacyOptionId)
  picklistId: string;            // "gender", "contract_type"
  externalCode: string;          // "M", "FT"
  status: "ACTIVE" | "INACTIVE";
  sortOrder?: number;
  labels: Record<string, string>;// { "en_US": "Male", "es_ES": "Masculino", "defaultValue": "Male" }
}

export interface EnvironmentPicklistCache {
  fetchedAt: number;
  version: number;
  options: CachedPicklistOption[];
  // O(1) in-memory indices:
  byOptionId: Map<string, CachedPicklistOption>;
  byExternalCode: Map<string, CachedPicklistOption>; // Key: `${picklistId}:${externalCode}`
  byPicklistId: Map<string, CachedPicklistOption[]>;  // Key: `${picklistId}`
  byLabel: Map<string, CachedPicklistOption>;         // Key: `${picklistId}:${locale}:${normalizedText}`
}

export interface PicklistMatch {
  optionId: string;
  picklistId: string;
  externalCode: string;
  label: string;
  locale: string;
  status: "ACTIVE" | "INACTIVE";
  suggestedFilter: string;
}

export interface ResolveOptionResult {
  label: string;
  optionId?: string;
  externalCode: string;
  picklistId: string;
  resolved: boolean;
  rawValue?: string;
  reason?: "OPTION_NOT_FOUND" | "FETCH_FAILED";
}

export interface DiskPicklistCache {
  fetchedAt: number;
  version: number;
  options: CachedPicklistOption[];
}

export interface PicklistServiceOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  cacheDir?: string;
  disableDiskCache?: boolean;
  diskTtlMs?: number;
  memoryTtlMs?: number;
  maxEntries?: number;
  tenantId?: string;
  log?: (message: string) => void;
}

export function picklistCacheFileName(tenantId: string, alias: string): string {
  const component = (value: string) => encodeURIComponent(value).replace(/-/g, "%2D");
  return tenantId === "default"
    ? `picklists-${component(alias)}.json`
    : `picklists-${component(tenantId)}-${component(alias)}.json`;
}

export function picklistCacheDirName(tenantId: string, alias: string): string {
  const component = (value: string) => encodeURIComponent(value).replace(/-/g, "%2D");
  return tenantId === "default"
    ? `picklists-${component(alias)}`
    : `picklists-${component(tenantId)}-${component(alias)}`;
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** Resolves locale code prioritizing: tool > config > env > "en_US". */
export function resolvePicklistLocale(sources: {
  tool?: string;
  config?: string;
  env?: string;
}): string {
  for (const candidate of [sources.tool, sources.config, sources.env]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const trimmed = candidate.trim();
      const match = /^([A-Za-z]{2})(?:[-_]([A-Za-z]{2}))?$/.exec(trimmed);
      if (match) {
        const lang = match[1]!.toLowerCase();
        const reg = match[2]?.toUpperCase();
        return reg ? `${lang}_${reg}` : `${lang}_${lang.toUpperCase()}`;
      }
      return trimmed;
    }
  }
  return "en_US";
}

/** Multilingual fallback chain (FR-64 / D-60): locale -> en_US -> defaultValue -> externalCode -> optionId. */
export function resolveLabel(
  option: CachedPicklistOption,
  requestedLocale?: string,
): { label: string; locale: string } {
  const loc = requestedLocale?.trim();
  if (loc && option.labels[loc]) {
    return { label: option.labels[loc]!, locale: loc };
  }
  // If e.g. "es" requested, match any "es_*" in labels
  if (loc && loc.length === 2) {
    for (const [k, v] of Object.entries(option.labels)) {
      if (k.toLowerCase().startsWith(`${loc.toLowerCase()}_`) && v) {
        return { label: v, locale: k };
      }
    }
  }
  // Fallback 1: en_US
  if (option.labels["en_US"]) {
    return { label: option.labels["en_US"]!, locale: "en_US" };
  }
  // Fallback 2: defaultValue or localized
  if (option.labels["defaultValue"]) {
    return { label: option.labels["defaultValue"]!, locale: "defaultValue" };
  }
  if (option.labels["localized"]) {
    return { label: option.labels["localized"]!, locale: "localized" };
  }
  // Fallback 3: any available label
  const anyLabelKey = Object.keys(option.labels)[0];
  if (anyLabelKey && option.labels[anyLabelKey]) {
    return { label: option.labels[anyLabelKey]!, locale: anyLabelKey };
  }
  // Fallback 4: externalCode
  if (option.externalCode && option.externalCode.length > 0) {
    return { label: option.externalCode, locale: "externalCode" };
  }
  // Fallback 5: optionId
  return { label: option.optionId, locale: "raw" };
}

export function buildCacheIndices(options: CachedPicklistOption[]): {
  byOptionId: Map<string, CachedPicklistOption>;
  byExternalCode: Map<string, CachedPicklistOption>;
  byPicklistId: Map<string, CachedPicklistOption[]>;
  byLabel: Map<string, CachedPicklistOption>;
} {
  const byOptionId = new Map<string, CachedPicklistOption>();
  const byExternalCode = new Map<string, CachedPicklistOption>();
  const byPicklistId = new Map<string, CachedPicklistOption[]>();
  const byLabel = new Map<string, CachedPicklistOption>();

  for (const opt of options) {
    if (opt.optionId) {
      byOptionId.set(opt.optionId, opt);
    }
    if (opt.picklistId && opt.externalCode) {
      byExternalCode.set(`${opt.picklistId}:${opt.externalCode}`, opt);
    }
    if (opt.picklistId) {
      let list = byPicklistId.get(opt.picklistId);
      if (!list) {
        list = [];
        byPicklistId.set(opt.picklistId, list);
      }
      list.push(opt);
    }
    if (opt.picklistId && opt.labels) {
      for (const [locale, label] of Object.entries(opt.labels)) {
        if (typeof label === "string" && label.length > 0) {
          byLabel.set(`${opt.picklistId}:${locale}:${normalize(label)}`, opt);
        }
      }
    }
  }

  return { byOptionId, byExternalCode, byPicklistId, byLabel };
}

export class PicklistService {
  private readonly memoryCache = new Map<string, EnvironmentPicklistCache>();
  private readonly pendingFetches = new Map<string, Promise<CachedPicklistOption[]>>();
  private readonly fetchImpl?: FetchImpl;
  private readonly now: () => number;
  private readonly diskTtlMs: number;
  private readonly memoryTtlMs: number;
  private readonly cacheDir: string;
  private readonly disableDiskCache: boolean;
  private readonly maxEntries: number;
  private readonly tenantId: string;
  private readonly logSink?: (message: string) => void;

  constructor(options: PicklistServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    this.diskTtlMs = options.diskTtlMs ?? PICKLIST_DISK_TTL_MS;
    this.memoryTtlMs = options.memoryTtlMs ?? PICKLIST_MEMORY_TTL_MS;
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.disableDiskCache =
      options.disableDiskCache ??
      (options.cacheDir !== undefined ? false : options.fetchImpl !== undefined);
    this.maxEntries = options.maxEntries ?? MAX_CACHED_OPTIONS_PER_ENV;
    this.tenantId = options.tenantId ?? "default";
    this.logSink = options.log;
  }

  private logWarning(message: string): void {
    if (this.logSink) {
      this.logSink(`ssff-mcp picklists warning: ${message}`);
    } else {
      process.stderr.write(`ssff-mcp picklists warning: ${message}\n`);
    }
  }

  async getCacheFor(alias: string): Promise<EnvironmentPicklistCache> {
    const memEntry = this.memoryCache.get(alias);
    if (memEntry !== undefined && this.now() - memEntry.fetchedAt < this.memoryTtlMs) {
      return memEntry;
    }

    // Try reading disk cache (L2)
    if (!this.disableDiskCache) {
      try {
        const cacheFile = path.join(this.cacheDir, picklistCacheFileName(this.tenantId, alias));
        const content = await fs.readFile(cacheFile, "utf-8");
        const diskEntry = JSON.parse(content) as DiskPicklistCache;
        if (
          typeof diskEntry.fetchedAt === "number" &&
          this.now() - diskEntry.fetchedAt < this.diskTtlMs &&
          Array.isArray(diskEntry.options)
        ) {
          const indices = buildCacheIndices(diskEntry.options);
          const cache: EnvironmentPicklistCache = {
            fetchedAt: diskEntry.fetchedAt,
            version: diskEntry.version ?? 1,
            options: diskEntry.options,
            ...indices,
          };
          this.memoryCache.set(alias, cache);
          return cache;
        }
      } catch {
        // Disk read missed, expired, or unparseable.
      }
    }

    // Brand new empty cache for environment
    const emptyCache: EnvironmentPicklistCache = {
      fetchedAt: this.now(),
      version: 1,
      options: [],
      byOptionId: new Map(),
      byExternalCode: new Map(),
      byPicklistId: new Map(),
      byLabel: new Map(),
    };
    this.memoryCache.set(alias, emptyCache);
    return emptyCache;
  }

  /**
   * Ensures that options for a picklist are loaded in L1/L2 cache.
   * Deduplicates concurrent fetches for the same picklist (NFR-04).
   */
  async ensurePicklistLoaded(
    env: EnvTarget,
    alias: string,
    picklistId: string,
    forceRefresh = false,
  ): Promise<CachedPicklistOption[]> {
    const trimmedId = picklistId.trim();
    if (!trimmedId) {
      return [];
    }

    if (!forceRefresh) {
      const cache = await this.getCacheFor(alias);
      const existing = cache.byPicklistId.get(trimmedId);
      if (existing !== undefined) {
        return existing;
      }

      // Check granular L2 disk cache for this picklist specifically (lazy disk -> RAM)
      if (!this.disableDiskCache) {
        try {
          const dir = path.join(this.cacheDir, picklistCacheDirName(this.tenantId, alias));
          const granularFile = path.join(dir, `${encodeURIComponent(trimmedId)}.json`);
          const content = await fs.readFile(granularFile, "utf-8");
          const diskEntry = JSON.parse(content) as { fetchedAt: number; version?: number; options: CachedPicklistOption[] };
          if (
            typeof diskEntry.fetchedAt === "number" &&
            this.now() - diskEntry.fetchedAt < this.diskTtlMs &&
            Array.isArray(diskEntry.options)
          ) {
            await this.mergeAndPersist(alias, diskEntry.options, trimmedId, false);
            return diskEntry.options;
          }
        } catch {
          // Granular file not found or expired
        }
      }
    }

    const dedupeKey = `${alias}:${trimmedId}`;
    const pending = this.pendingFetches.get(dedupeKey);
    if (pending) {
      return await pending;
    }

    const fetchPromise = (async () => {
      try {
        const options = await this.fetchPicklistFromSAP(env, alias, trimmedId);
        await this.mergeAndPersist(alias, options, trimmedId);
        return options;
      } catch (error) {
        this.logWarning(`failed to load picklist "${trimmedId}": ${error instanceof Error ? error.message : String(error)}`);
        return [];
      } finally {
        this.pendingFetches.delete(dedupeKey);
      }
    })();

    this.pendingFetches.set(dedupeKey, fetchPromise);
    return await fetchPromise;
  }

  /**
   * Direct fetch of a picklist from SAP using Legacy or MDF OData endpoints (D-55, D-58, DS-PL-02).
   * Supports pagination (__next) for large picklists (e.g. 15k records).
   */
  private async fetchPicklistFromSAP(
    env: EnvTarget,
    _alias: string,
    picklistId: string,
  ): Promise<CachedPicklistOption[]> {
    const escapedId = picklistId.replace(/'/g, "''");

    // Attempt 1: Legacy Picklist (PicklistOption)
    try {
      let legacyPath: string | null = `PicklistOption?$filter=picklist/id eq '${escapedId}'&$expand=picklistLabels`;
      const allLegacyResults: Array<Record<string, unknown>> = [];
      while (legacyPath && allLegacyResults.length < this.maxEntries) {
        const res = await dispatchGet(env, legacyPath, {
          accept: "application/json",
          timeoutMs: PICKLIST_FETCH_TIMEOUT_MS,
          fetchImpl: this.fetchImpl,
          now: this.now,
        });
        const parsed = JSON.parse(res.body) as Record<string, unknown>;
        const results = this.extractResults(parsed);
        if (results.length === 0) break;
        allLegacyResults.push(...results);

        const d = parsed?.d as Record<string, unknown> | undefined;
        const nextUrl = d?.__next;
        if (typeof nextUrl === "string" && nextUrl.length > 0) {
          try {
            const u = new URL(nextUrl, "https://dummy.example.com");
            legacyPath = u.pathname.replace(/^\/odata\/v2\/?/, "") + u.search;
          } catch {
            legacyPath = null;
          }
        } else {
          legacyPath = null;
        }
      }
      if (allLegacyResults.length > 0) {
        return this.parseLegacyOptions(allLegacyResults, picklistId);
      }
    } catch (err) {
      this.logWarning(`legacy picklist fetch failed for "${picklistId}": ${err instanceof Error ? err.message : String(err)}`);
    }

    // Attempt 2: MDF Picklist (PickListValueV2)
    try {
      let mdfPath: string | null = `PickListValueV2?$filter=PickListV2_id eq '${escapedId}'`;
      const allMdfResults: Array<Record<string, unknown>> = [];
      while (mdfPath && allMdfResults.length < this.maxEntries) {
        const res = await dispatchGet(env, mdfPath, {
          accept: "application/json",
          timeoutMs: PICKLIST_FETCH_TIMEOUT_MS,
          fetchImpl: this.fetchImpl,
          now: this.now,
        });
        const parsed = JSON.parse(res.body) as Record<string, unknown>;
        const results = this.extractResults(parsed);
        if (results.length === 0) break;
        allMdfResults.push(...results);

        const d = parsed?.d as Record<string, unknown> | undefined;
        const nextUrl = d?.__next;
        if (typeof nextUrl === "string" && nextUrl.length > 0) {
          try {
            const u = new URL(nextUrl, "https://dummy.example.com");
            mdfPath = u.pathname.replace(/^\/odata\/v2\/?/, "") + u.search;
          } catch {
            mdfPath = null;
          }
        } else {
          mdfPath = null;
        }
      }
      if (allMdfResults.length > 0) {
        return this.parseMdfOptions(allMdfResults, picklistId);
      }
    } catch (err) {
      this.logWarning(`mdf picklist fetch failed for "${picklistId}": ${err instanceof Error ? err.message : String(err)}`);
    }

    return [];
  }

  private extractResults(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
    const d = parsed?.d as Record<string, unknown> | undefined;
    if (d && Array.isArray(d.results)) {
      return d.results as Array<Record<string, unknown>>;
    }
    if (Array.isArray(d)) {
      return d as Array<Record<string, unknown>>;
    }
    if (d && typeof d === "object") {
      return [d];
    }
    return [];
  }

  private parseLegacyOptions(
    results: Array<Record<string, unknown>>,
    fallbackPicklistId: string,
  ): CachedPicklistOption[] {
    const list: CachedPicklistOption[] = [];
    for (const item of results) {
      const rawId = item.id ?? item.optionId;
      const optionId = rawId !== undefined && rawId !== null ? String(rawId).replace(/L$/, "") : "";
      const picklistObj = item.picklist as Record<string, unknown> | undefined;
      const picklistId = typeof picklistObj?.id === "string" ? picklistObj.id : fallbackPicklistId;
      const externalCode = item.externalCode !== undefined && item.externalCode !== null ? String(item.externalCode) : "";
      const status: "ACTIVE" | "INACTIVE" =
        item.status === "ACTIVE" || item.status === "A" ? "ACTIVE" : "INACTIVE";
      const sortOrder = typeof item.sortOrder === "number" ? item.sortOrder : undefined;

      const labels: Record<string, string> = {};
      const rawLabels = item.picklistLabels as Record<string, unknown> | undefined;
      const labelArray = Array.isArray(rawLabels?.results)
        ? (rawLabels.results as Array<Record<string, unknown>>)
        : Array.isArray(item.picklistLabels)
          ? (item.picklistLabels as Array<Record<string, unknown>>)
          : rawLabels && typeof rawLabels === "object"
            ? [rawLabels]
            : [];

      for (const l of labelArray) {
        if (typeof l.locale === "string" && typeof l.label === "string" && l.label.length > 0) {
          labels[l.locale] = l.label;
        }
      }
      if (!labels["defaultValue"] && labels["en_US"]) {
        labels["defaultValue"] = labels["en_US"];
      }

      list.push({ optionId, picklistId, externalCode, status, sortOrder, labels });
    }
    return list;
  }

  private parseMdfOptions(
    results: Array<Record<string, unknown>>,
    fallbackPicklistId: string,
  ): CachedPicklistOption[] {
    const list: CachedPicklistOption[] = [];
    for (const item of results) {
      const externalCode = item.externalCode !== undefined && item.externalCode !== null ? String(item.externalCode) : "";
      const rawLegacy = item.legacyOptionId;
      const optionId =
        rawLegacy !== undefined && rawLegacy !== null && String(rawLegacy).length > 0
          ? String(rawLegacy).replace(/L$/, "")
          : externalCode;
      const picklistId = typeof item.PickListV2_id === "string" ? item.PickListV2_id : fallbackPicklistId;
      const status: "ACTIVE" | "INACTIVE" =
        item.status === "A" || item.status === "ACTIVE" ? "ACTIVE" : "INACTIVE";

      const labels: Record<string, string> = {};
      for (const [k, v] of Object.entries(item)) {
        if (k.startsWith("label_") && typeof v === "string" && v.length > 0) {
          const localeKey = k.slice(6);
          labels[localeKey] = v;
        }
      }
      if (!labels["defaultValue"] && labels["en_US"]) {
        labels["defaultValue"] = labels["en_US"];
      }
      if (!labels["defaultValue"] && labels["localized"]) {
        labels["defaultValue"] = labels["localized"];
      }

      list.push({ optionId, picklistId, externalCode, status, labels });
    }
    return list;
  }

  private async mergeAndPersist(
    alias: string,
    newOptions: CachedPicklistOption[],
    picklistId?: string,
    persistGranular = true,
  ): Promise<void> {
    const cache = await this.getCacheFor(alias);
    // Replace options of this picklist if refreshing or appending
    let merged = cache.options;
    if (picklistId) {
      merged = merged.filter((opt) => opt.picklistId !== picklistId);
    }
    for (const opt of newOptions) {
      if (merged.length < this.maxEntries) {
        merged.push(opt);
      }
    }

    cache.options = merged;
    const indices = buildCacheIndices(merged);
    cache.byOptionId = indices.byOptionId;
    cache.byExternalCode = indices.byExternalCode;
    cache.byPicklistId = indices.byPicklistId;
    cache.byLabel = indices.byLabel;
    cache.fetchedAt = this.now();

    // Persist to L2 disk cache (DS-PL-03, NFR-03)
    if (!this.disableDiskCache) {
      // 1. Granular per-picklist persistence (enables lazy retrieval per picklist)
      if (persistGranular && picklistId && newOptions.length > 0) {
        try {
          const dir = path.join(this.cacheDir, picklistCacheDirName(this.tenantId, alias));
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          const granularFile = path.join(dir, `${encodeURIComponent(picklistId)}.json`);
          await fs.writeFile(
            granularFile,
            JSON.stringify({ fetchedAt: this.now(), version: 1, picklistId, options: newOptions }),
            { encoding: "utf-8", mode: 0o600 },
          );
          if (process.platform !== "win32") {
            await fs.chmod(granularFile, 0o600).catch(() => {});
          }
        } catch (err) {
          this.logWarning(`failed to persist granular disk cache for "${picklistId}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 2. Monolithic environment cache
      try {
        await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
        const cacheFile = path.join(this.cacheDir, picklistCacheFileName(this.tenantId, alias));
        const payload: DiskPicklistCache = {
          fetchedAt: this.now(),
          version: 1,
          options: cache.options,
        };
        await fs.writeFile(cacheFile, JSON.stringify(payload), {
          encoding: "utf-8",
          mode: 0o600,
        });
        if (process.platform !== "win32") {
          await fs.chmod(cacheFile, 0o600).catch(() => {});
        }
      } catch (err) {
        this.logWarning(`failed to persist disk cache: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Resolves a single option by optionId or externalCode.
   */
  async resolveOption(
    env: EnvTarget,
    alias: string,
    picklistId: string | undefined,
    optionIdOrCode: string,
    locale?: string,
    forceRefresh = false,
  ): Promise<ResolveOptionResult> {
    if (picklistId) {
      await this.ensurePicklistLoaded(env, alias, picklistId, forceRefresh);
    }

    const cache = await this.getCacheFor(alias);
    let option: CachedPicklistOption | undefined;

    if (picklistId && optionIdOrCode) {
      option =
        cache.byOptionId.get(optionIdOrCode) ??
        cache.byExternalCode.get(`${picklistId}:${optionIdOrCode}`);
    } else if (optionIdOrCode) {
      option = cache.byOptionId.get(optionIdOrCode);
      if (!option) {
        // Try finding by externalCode across picklists
        for (const opt of cache.options) {
          if (opt.externalCode === optionIdOrCode) {
            option = opt;
            break;
          }
        }
      }
    }

    // If still not found and numeric optionId, try on-demand fetch
    if (!option && optionIdOrCode) {
      option = await this.fetchSingleOption(env, alias, optionIdOrCode);
    }

    if (option) {
      const res = resolveLabel(option, locale);
      return {
        label: res.label,
        optionId: option.optionId,
        externalCode: option.externalCode,
        picklistId: option.picklistId,
        resolved: true,
      };
    }

    return {
      label: optionIdOrCode,
      externalCode: optionIdOrCode,
      picklistId: picklistId ?? "",
      resolved: false,
      rawValue: optionIdOrCode,
      reason: "OPTION_NOT_FOUND",
    };
  }

  private async fetchSingleOption(
    env: EnvTarget,
    alias: string,
    optionId: string,
  ): Promise<CachedPicklistOption | undefined> {
    const isNumeric = /^\d+$/.test(optionId);
    if (!isNumeric) {
      return undefined;
    }

    try {
      const legacyPath = `PicklistOption?$filter=id eq ${optionId}L&$expand=picklist,picklistLabels`;
      const res = await dispatchGet(env, legacyPath, {
        accept: "application/json",
        timeoutMs: PICKLIST_FETCH_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
        now: this.now,
      });
      const parsed = JSON.parse(res.body) as Record<string, unknown>;
      const results = this.extractResults(parsed);
      if (results.length > 0) {
        const options = this.parseLegacyOptions(results, "");
        if (options[0]) {
          await this.mergeAndPersist(alias, [options[0]]);
          return options[0];
        }
      }
    } catch {
      // Ignore single fetch failure
    }

    return undefined;
  }

  /**
   * Search options by localized text query (FR-60 / Caso A).
   */
  async searchByLabel(
    env: EnvTarget,
    alias: string,
    query: string,
    picklistId?: string,
    locale?: string,
    forceRefresh = false,
  ): Promise<PicklistMatch[]> {
    if (picklistId) {
      await this.ensurePicklistLoaded(env, alias, picklistId, forceRefresh);
    }

    const cache = await this.getCacheFor(alias);
    const pool = picklistId ? cache.byPicklistId.get(picklistId) ?? [] : cache.options;
    const normalizedQuery = normalize(query);
    const matches: PicklistMatch[] = [];

    for (const opt of pool) {
      let matched = false;
      let matchedLocale = locale ?? "en_US";

      // 1. Check in requested locale
      if (locale && opt.labels[locale]) {
        if (normalize(opt.labels[locale]!).includes(normalizedQuery)) {
          matched = true;
          matchedLocale = locale;
        }
      }

      // 2. Check across all labels if not matched yet
      if (!matched) {
        for (const [loc, text] of Object.entries(opt.labels)) {
          if (normalize(text).includes(normalizedQuery)) {
            matched = true;
            matchedLocale = loc;
            break;
          }
        }
      }

      // 3. Check externalCode or optionId
      if (!matched && (normalize(opt.externalCode).includes(normalizedQuery) || opt.optionId === query.trim())) {
        matched = true;
        matchedLocale = "externalCode";
      }

      if (matched) {
        const res = resolveLabel(opt, locale ?? matchedLocale);
        const filterVal = opt.optionId ? opt.optionId : opt.externalCode;
        matches.push({
          optionId: opt.optionId,
          picklistId: opt.picklistId,
          externalCode: opt.externalCode,
          label: res.label,
          locale: res.locale,
          status: opt.status,
          suggestedFilter: `${opt.picklistId} eq '${filterVal}'`,
        });
      }
    }

    // Sort: ACTIVE first, exact label match first
    matches.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "ACTIVE" ? -1 : 1;
      }
      const aExact = normalize(a.label) === normalizedQuery;
      const bExact = normalize(b.label) === normalizedQuery;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return a.label.localeCompare(b.label);
    });

    return matches;
  }

  /**
   * List options of a catalog (FR-59 / Caso C).
   */
  async listOptions(
    env: EnvTarget,
    alias: string,
    picklistId: string,
    locale?: string,
    forceRefresh = false,
  ): Promise<Array<{ optionId: string; externalCode: string; label: string; locale: string; status: "ACTIVE" | "INACTIVE" }>> {
    await this.ensurePicklistLoaded(env, alias, picklistId, forceRefresh);
    const cache = await this.getCacheFor(alias);
    const list = cache.byPicklistId.get(picklistId) ?? [];

    return list
      .filter((opt) => opt.status === "ACTIVE")
      .map((opt) => {
        const res = resolveLabel(opt, locale);
        return {
          optionId: opt.optionId,
          externalCode: opt.externalCode,
          label: res.label,
          locale: res.locale,
          status: opt.status,
        };
      });
  }

  /**
   * Non-destructive enrichment of records with <field>_NavLabels and _picklistLabels (D-57, FR-61, FR-62, FR-63, FR-65, NFR-01).
   */
  async enrichRecords(
    records: unknown[],
    entitySchema: EntitySchema,
    env: EnvTarget,
    alias: string,
    locale?: string,
    activePicklists?: Map<string, Set<string>>,
  ): Promise<unknown[]> {
    if (!Array.isArray(records) || records.length === 0) {
      return records;
    }

    let picklistProperties = entitySchema.properties.filter(
      (p) => typeof p.picklistId === "string" && p.picklistId.length > 0,
    );
    if (picklistProperties.length === 0) {
      return records;
    }

    // If activePicklists is specified, only process those picklists requested via $expand
    if (activePicklists !== undefined) {
      picklistProperties = picklistProperties.filter((p) => activePicklists.has(p.name));
      if (picklistProperties.length === 0) {
        return records;
      }
    }

    // Pre-load all relevant picklists in parallel before iterating records
    const uniquePicklistIds = Array.from(new Set(picklistProperties.map((p) => p.picklistId!)));
    await Promise.all(
      uniquePicklistIds.map((id) => this.ensurePicklistLoaded(env, alias, id).catch(() => [])),
    );

    const cache = await this.getCacheFor(alias);

    // Fast O(1) enrichment loop (< 5 ms for 1,000 records)
    for (const record of records) {
      if (typeof record !== "object" || record === null) {
        continue;
      }
      const rec = record as Record<string, unknown>;
      const picklistLabels: Record<string, unknown> = {};

      for (const prop of picklistProperties) {
        const rawVal = rec[prop.name];
        if (rawVal === undefined || rawVal === null || rawVal === "") {
          continue;
        }

        const rawStr = String(rawVal);
        const option =
          cache.byOptionId.get(rawStr) ??
          cache.byExternalCode.get(`${prop.picklistId!}:${rawStr}`);

        const requestedFields = activePicklists?.get(prop.name) ?? new Set<string>();

        if (option) {
          const res = resolveLabel(option, locale);

          // Option C: <field>_NavLabels
          // Minimal info by default: optionId + label
          // Expanded if requested via $select: externalCode, order, picklistId
          const navLabels: Record<string, unknown> = {
            optionId: option.optionId,
            label: res.label,
          };
          if (requestedFields.has("externalcode") || requestedFields.has("external_code")) {
            navLabels.externalCode = option.externalCode;
          }
          if (requestedFields.has("order") || requestedFields.has("sortorder")) {
            navLabels.order = option.sortOrder;
          }
          if (requestedFields.has("picklistid") || requestedFields.has("picklist_id")) {
            navLabels.picklistId = option.picklistId;
          }

          rec[`${prop.name}_NavLabels`] = navLabels;

          // Legacy / backward-compatible _picklistLabels
          picklistLabels[prop.name] = {
            label: res.label,
            optionId: option.optionId,
            externalCode: option.externalCode,
            picklistId: option.picklistId,
            resolved: true,
          };
        } else {
          rec[`${prop.name}_NavLabels`] = {
            resolved: false,
            rawValue: rawStr,
            reason: "OPTION_NOT_FOUND",
          };
          picklistLabels[prop.name] = {
            resolved: false,
            rawValue: rawStr,
            reason: "OPTION_NOT_FOUND",
          };
        }
      }

      if (Object.keys(picklistLabels).length > 0) {
        rec._picklistLabels = picklistLabels;
      }
    }

    return records;
  }
}

export interface PicklistExpansionPlan {
  /** Map of propertyName -> Set of requested fields (e.g. "externalcode", "order", "picklistid") */
  activePicklists: Map<string, Set<string>>;
  /** Routes to remain in expand for SAP */
  sapExpand?: string;
  /** Select string with picklist navigation fields stripped for SAP */
  sapSelect?: string;
}

/**
 * Plans which picklist navigations should be resolved locally versus sent to SAP (Option C).
 * Only fields expanded via $expand=<fieldNav> or $expand=<field>_NavLabels are resolved.
 */
export function planPicklistExpansion(
  entitySchema: EntitySchema | undefined,
  expand: string | undefined,
  select: string | undefined,
  resolvePicklists: boolean | undefined,
): PicklistExpansionPlan {
  if (!resolvePicklists || !entitySchema) {
    return {
      activePicklists: new Map(),
      sapExpand: expand,
      sapSelect: select,
    };
  }

  const picklistProperties = entitySchema.properties.filter(
    (p) => typeof p.picklistId === "string" && p.picklistId.length > 0,
  );
  if (picklistProperties.length === 0) {
    return {
      activePicklists: new Map(),
      sapExpand: expand,
      sapSelect: select,
    };
  }

  // Build lookup of candidate navigation names to property
  const navToProp = new Map<string, typeof picklistProperties[0]>();
  for (const p of picklistProperties) {
    navToProp.set(p.name.toLowerCase() + "nav", p);
    navToProp.set(p.name.toLowerCase() + "_navlabels", p);
    navToProp.set(p.name.toLowerCase(), p);
  }

  const activePicklists = new Map<string, Set<string>>();
  const sapRoutes: string[] = [];

  if (expand && expand.trim().length > 0) {
    const parsed = parseExpand(expand);
    if (parsed.ok) {
      for (const route of parsed.routes) {
        const topNav = route[0] ?? "";
        const matchedProp = navToProp.get(topNav.toLowerCase());
        if (matchedProp) {
          // Local picklist navigation!
          if (!activePicklists.has(matchedProp.name)) {
            activePicklists.set(matchedProp.name, new Set());
          }
          // Check if selections were attached to this route
          for (const sel of parsed.selections) {
            if (sel.route.length > 0 && sel.route[0]?.toLowerCase() === topNav.toLowerCase()) {
              for (const propName of sel.properties) {
                activePicklists.get(matchedProp.name)!.add(propName.toLowerCase());
              }
            }
          }
        } else {
          // Remote SAP navigation route
          sapRoutes.push(route.join("/"));
        }
      }
    } else {
      // Unparseable expand will be rejected downstream
      return {
        activePicklists: new Map(),
        sapExpand: expand,
        sapSelect: select,
      };
    }
  }

  // Now inspect top-level select if present
  let sapSelect = select;
  if (select && select.trim().length > 0) {
    const parts = select.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const retainedParts: string[] = [];
    for (const part of parts) {
      const slashIndex = part.indexOf("/");
      if (slashIndex > 0) {
        const nav = part.slice(0, slashIndex).toLowerCase();
        const sub = part.slice(slashIndex + 1).toLowerCase();
        const matchedProp = navToProp.get(nav);
        if (matchedProp) {
          if (!activePicklists.has(matchedProp.name)) {
            activePicklists.set(matchedProp.name, new Set());
          }
          activePicklists.get(matchedProp.name)!.add(sub);
          // Omit from sapSelect so SAP doesn't try to select on non-expanded nav
          continue;
        }
      } else {
        const matchedProp = navToProp.get(part.toLowerCase());
        if (matchedProp && activePicklists.has(matchedProp.name)) {
          // e.g. select includes maritalStatusNav or maritalStatus_NavLabels
          continue;
        }
      }
      retainedParts.push(part);
    }
    sapSelect = retainedParts.length > 0 ? retainedParts.join(",") : undefined;
  }

  const sapExpand = sapRoutes.length > 0 ? sapRoutes.join(",") : undefined;

  return {
    activePicklists,
    sapExpand,
    sapSelect,
  };
}
