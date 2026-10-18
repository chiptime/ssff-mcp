/**
 * $metadata validation and MCP Resources support with disk/memory caching.
 *
 * - Fetches and parses the EDMX `$metadata` document to extract EntitySet and
 *   FunctionImport names, and detailed schemas (keys, properties, navigation
 *   properties with cardinality).
 * - Caches parsed metadata in memory (10 min TTL) and on local disk with TTL
 *   (24 hours default) under the OS cache directory (~/.cache/ssff-mcp on Linux).
 * - No tool bypasses this cache: the former `get_metadata` tool was retired
 *   (archive/PRD-feature-remove-get-metadata.md), so every LLM-facing path reads here.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { isEntityAllowed, type AllowlistEntry } from "./allowlist.js";
import { SanitizedError } from "./errors.js";
import { dispatchGet, type EnvTarget, type FetchImpl } from "./http.js";
import type { SupportedLocale } from "./i18n.js";
import {
  classifyEntity,
  isCustomMdfEntity,
  isEmployeeLinkedType,
  summarizeCustomMdf,
  type CustomMdfDetails,
  type CustomMdfSummary,
} from "./mdf.js";

export type {
  CustomMdfDetails,
  CustomMdfSummary,
  MdfEmployeeLink,
  MdfEmployeeLinkType,
  MdfQueryGuidance,
} from "./mdf.js";

export const METADATA_TTL_MS = 10 * 60 * 1000;
export const METADATA_DISK_TTL_MS = 24 * 60 * 60 * 1000;
const METADATA_TIMEOUT_MS = 60_000;

export interface MetadataNameSets {
  entitySets: Set<string>;
  functionImports: Set<string>;
}

export interface EntityProperty {
  name: string;
  type: string;
  nullable: boolean;
  maxLength?: number;
}

export interface NavigationProperty {
  name: string;
  targetEntitySet: string;
  relationship: string;
  multiplicity: "0..1" | "1" | "*";
}

export interface EntitySchema {
  entitySet: string;
  entityType: string;
  keys: string[];
  properties: EntityProperty[];
  navigationProperties: NavigationProperty[];
}

export interface ParsedMetadata {
  entitySets: string[];
  functionImports: string[];
  entitySchemas: Record<string, EntitySchema>;
}

interface CacheEntry {
  data: ParsedMetadata;
  nameSets: MetadataNameSets;
  fetchedAt: number;
}

export type FirstSegmentVerdict =
  | { kind: "entity-set" }
  | { kind: "function-import" }
  | { kind: "unknown" };

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  isArray: (name) =>
    name === "EntitySet" ||
    name === "FunctionImport" ||
    name === "EntityType" ||
    name === "Association" ||
    name === "AssociationSet" ||
    name === "Property" ||
    name === "NavigationProperty" ||
    name === "PropertyRef" ||
    name === "End" ||
    name === "Schema",
});

export function defaultCacheDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "ssff-mcp", "cache");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ssff-mcp");
  }
  const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(xdgCache, "ssff-mcp");
}

export function parseMetadata(xml: string): ParsedMetadata {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new SanitizedError("METADATA_UNAVAILABLE", "metadata for the configured environment could not be parsed");
  }

  const edmx = (doc.Edmx ?? doc) as Record<string, unknown> | undefined;
  const dataServices = (edmx?.DataServices ?? doc.DataServices) as Record<string, unknown> | undefined;
  const rawSchemas = dataServices?.Schema;
  const schemas: Array<Record<string, unknown>> = Array.isArray(rawSchemas)
    ? rawSchemas
    : rawSchemas && typeof rawSchemas === "object"
      ? [rawSchemas as Record<string, unknown>]
      : [];

  const entitySetsList: Array<{ name: string; entityType: string }> = [];
  const functionImportsSet = new Set<string>();
  const entityTypes = new Map<string, Record<string, unknown>>();
  const associations = new Map<string, Record<string, unknown>>();
  const associationSets: Array<Record<string, unknown>> = [];

  for (const schema of schemas) {
    const namespace = typeof schema["@_Namespace"] === "string" ? schema["@_Namespace"] : "";

    const rawEntityTypes = schema.EntityType;
    const typeList = Array.isArray(rawEntityTypes) ? rawEntityTypes : [];
    for (const et of typeList) {
      if (typeof et === "object" && et !== null) {
        const name = (et as Record<string, unknown>)["@_Name"];
        if (typeof name === "string" && name.length > 0) {
          entityTypes.set(name, et as Record<string, unknown>);
          if (namespace.length > 0) {
            entityTypes.set(`${namespace}.${name}`, et as Record<string, unknown>);
          }
        }
      }
    }

    const rawAssocs = schema.Association;
    const assocList = Array.isArray(rawAssocs) ? rawAssocs : [];
    for (const assoc of assocList) {
      if (typeof assoc === "object" && assoc !== null) {
        const name = (assoc as Record<string, unknown>)["@_Name"];
        if (typeof name === "string" && name.length > 0) {
          associations.set(name, assoc as Record<string, unknown>);
          if (namespace.length > 0) {
            associations.set(`${namespace}.${name}`, assoc as Record<string, unknown>);
          }
        }
      }
    }

    const rawContainers = schema.EntityContainer;
    const containers = Array.isArray(rawContainers)
      ? rawContainers
      : rawContainers && typeof rawContainers === "object"
        ? [rawContainers]
        : [];

    for (const container of containers) {
      if (typeof container === "object" && container !== null) {
        const c = container as Record<string, unknown>;
        const rawSets = c.EntitySet;
        const setList = Array.isArray(rawSets) ? rawSets : [];
        for (const es of setList) {
          if (typeof es === "object" && es !== null) {
            const esObj = es as Record<string, unknown>;
            const name = esObj["@_Name"];
            const entityType = esObj["@_EntityType"];
            if (typeof name === "string" && name.length > 0) {
              entitySetsList.push({
                name,
                entityType: typeof entityType === "string" ? entityType : name,
              });
            }
          }
        }

        const rawFuncs = c.FunctionImport;
        const funcList = Array.isArray(rawFuncs) ? rawFuncs : [];
        for (const fi of funcList) {
          if (typeof fi === "object" && fi !== null) {
            const name = (fi as Record<string, unknown>)["@_Name"];
            if (typeof name === "string" && name.length > 0) {
              functionImportsSet.add(name);
            }
          }
        }

        const rawAssocSets = c.AssociationSet;
        const aSetsList = Array.isArray(rawAssocSets) ? rawAssocSets : [];
        for (const as of aSetsList) {
          if (typeof as === "object" && as !== null) {
            associationSets.push(as as Record<string, unknown>);
          }
        }
      }
    }
  }

  const entitySchemas: Record<string, EntitySchema> = {};
  for (const es of entitySetsList) {
    const bareType = es.entityType.split(".").pop() ?? es.entityType;
    const et = entityTypes.get(es.entityType) ?? entityTypes.get(bareType);

    const keys: string[] = [];
    if (et?.Key && typeof et.Key === "object") {
      const keyObj = et.Key as Record<string, unknown>;
      const propRefs = Array.isArray(keyObj.PropertyRef) ? keyObj.PropertyRef : [];
      for (const pr of propRefs) {
        if (typeof pr === "object" && pr !== null) {
          const kName = (pr as Record<string, unknown>)["@_Name"];
          if (typeof kName === "string" && kName.length > 0) {
            keys.push(kName);
          }
        }
      }
    }

    const properties: EntityProperty[] = [];
    const rawProps = et?.Property;
    const propList = Array.isArray(rawProps) ? rawProps : [];
    for (const p of propList) {
      if (typeof p === "object" && p !== null) {
        const pObj = p as Record<string, unknown>;
        const name = pObj["@_Name"];
        const type = pObj["@_Type"];
        if (typeof name === "string" && typeof type === "string") {
          const prop: EntityProperty = {
            name,
            type,
            nullable: pObj["@_Nullable"] !== "false",
          };
          if (pObj["@_MaxLength"] !== undefined) {
            const maxL = Number(pObj["@_MaxLength"]);
            if (!Number.isNaN(maxL)) {
              prop.maxLength = maxL;
            }
          }
          properties.push(prop);
        }
      }
    }

    const navigationProperties: NavigationProperty[] = [];
    const rawNavs = et?.NavigationProperty;
    const navList = Array.isArray(rawNavs) ? rawNavs : [];
    for (const np of navList) {
      if (typeof np === "object" && np !== null) {
        const npObj = np as Record<string, unknown>;
        const name = npObj["@_Name"];
        const relationship = npObj["@_Relationship"];
        const toRole = npObj["@_ToRole"];
        if (typeof name === "string" && typeof relationship === "string" && typeof toRole === "string") {
          const bareRel = relationship.split(".").pop() ?? relationship;
          const assoc = associations.get(relationship) ?? associations.get(bareRel);

          let multiplicity: "0..1" | "1" | "*" = "*";
          if (assoc?.End && Array.isArray(assoc.End)) {
            const end = (assoc.End as Array<Record<string, unknown>>).find((e) => e["@_Role"] === toRole);
            const m = end?.["@_Multiplicity"];
            if (m === "0..1" || m === "1" || m === "*") {
              multiplicity = m;
            }
          }

          let targetEntitySet = toRole;
          const matchedSet = associationSets.find(
            (as) => as["@_Association"] === relationship || as["@_Name"] === bareRel,
          );
          if (matchedSet?.End && Array.isArray(matchedSet.End)) {
            const endSet = (matchedSet.End as Array<Record<string, unknown>>).find((e) => e["@_Role"] === toRole);
            const esName = endSet?.["@_EntitySet"];
            if (typeof esName === "string" && esName.length > 0) {
              targetEntitySet = esName;
            }
          }

          navigationProperties.push({
            name,
            targetEntitySet,
            relationship,
            multiplicity,
          });
        }
      }
    }

    entitySchemas[es.name] = {
      entitySet: es.name,
      entityType: es.entityType,
      keys,
      properties,
      navigationProperties,
    };
  }

  return {
    entitySets: entitySetsList.map((e) => e.name),
    functionImports: [...functionImportsSet],
    entitySchemas,
  };
}

export function parseMetadataXml(xml: string): MetadataNameSets {
  const parsed = parseMetadata(xml);
  return {
    entitySets: new Set(parsed.entitySets),
    functionImports: new Set(parsed.functionImports),
  };
}

export interface MetadataServiceOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  ttlMs?: number;
  diskTtlMs?: number;
  cacheDir?: string;
  disableDiskCache?: boolean;
  /**
   * Tenant namespace for the disk cache (D-121/FR-161): two tenants sharing
   * an environment alias must never share an entry. Defaults to "default"
   * (the migrated flat shape and inline mode).
   */
  tenantId?: string;
}

/**
 * Cache file name, namespaced by tenant (D-121). Single source of truth —
 * `ssff-mcp cache invalidate` builds the same name from this function.
 */
export function metadataCacheFileName(tenantId: string, alias: string): string {
  // Escape the separator inside each component as well (encodeURIComponent
  // leaves '-' intact). Otherwise ('a-b', 'c') collides with ('a', 'b-c').
  const component = (value: string) => encodeURIComponent(value).replace(/-/g, "%2D");
  return `metadata-${component(tenantId)}-${component(alias)}.json`;
}

export class MetadataService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl?: FetchImpl;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly diskTtlMs: number;
  private readonly cacheDir: string;
  private readonly disableDiskCache: boolean;
  private readonly tenantId: string;

  constructor(options: MetadataServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? METADATA_TTL_MS;
    this.diskTtlMs = options.diskTtlMs ?? METADATA_DISK_TTL_MS;
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.disableDiskCache =
      options.disableDiskCache ??
      (options.cacheDir !== undefined ? false : options.fetchImpl !== undefined);
    this.tenantId = options.tenantId ?? "default";
  }

  private async fetchFreshMetadata(env: EnvTarget): Promise<ParsedMetadata> {
    let xml: string;
    try {
      const result = await dispatchGet(env, "$metadata", {
        accept: "application/xml",
        timeoutMs: METADATA_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
      });
      xml = result.body;
    } catch (error) {
      if (
        error instanceof SanitizedError &&
        (error.code === "HTTP_ERROR" || error.code === "OAUTH_ASSERTION_ERROR" || error.code === "OAUTH_TOKEN_ERROR")
      ) {
        throw error;
      }
      throw new SanitizedError(
        "METADATA_UNAVAILABLE",
        "metadata for the configured environment could not be retrieved",
      );
    }

    return parseMetadata(xml);
  }

  async getParsedMetadata(env: EnvTarget, alias: string): Promise<ParsedMetadata> {
    const memEntry = this.cache.get(alias);
    if (memEntry !== undefined && this.now() - memEntry.fetchedAt < this.ttlMs) {
      // FR-95: `ssff-mcp cache invalidate` runs in another process and can only
      // delete the disk file, so the in-memory entry stops being trusted once
      // the file is gone. Without this the command would look broken for up to
      // the 10-minute memory TTL.
      let backed = true;
      if (!this.disableDiskCache) {
        try {
          await fs.stat(path.join(this.cacheDir, metadataCacheFileName(this.tenantId, alias)));
        } catch {
          backed = false;
        }
      }
      if (backed) {
        return memEntry.data;
      }
      this.cache.delete(alias);
    }

    // Try reading disk cache
    if (!this.disableDiskCache) {
      try {
        const cacheFile = path.join(this.cacheDir, metadataCacheFileName(this.tenantId, alias));
        const content = await fs.readFile(cacheFile, "utf-8");
        const diskEntry = JSON.parse(content) as { fetchedAt: number; data: ParsedMetadata };
        if (
          typeof diskEntry.fetchedAt === "number" &&
          this.now() - diskEntry.fetchedAt < this.diskTtlMs &&
          diskEntry.data?.entitySets
        ) {
          const nameSets: MetadataNameSets = {
            entitySets: new Set(diskEntry.data.entitySets),
            functionImports: new Set(diskEntry.data.functionImports),
          };
          this.cache.set(alias, {
            data: diskEntry.data,
            nameSets,
            fetchedAt: diskEntry.fetchedAt,
          });
          return diskEntry.data;
        }
      } catch {
        // Disk read missed, expired, or invalid.
      }
    }

    // Fetch fresh
    const data = await this.fetchFreshMetadata(env);
    const nameSets: MetadataNameSets = {
      entitySets: new Set(data.entitySets),
      functionImports: new Set(data.functionImports),
    };
    this.cache.set(alias, { data, nameSets, fetchedAt: this.now() });

    // Best-effort disk write
    if (!this.disableDiskCache) {
      try {
        await fs.mkdir(this.cacheDir, { recursive: true });
        const cacheFile = path.join(this.cacheDir, metadataCacheFileName(this.tenantId, alias));
        await fs.writeFile(
          cacheFile,
          JSON.stringify({ fetchedAt: this.now(), data }),
          "utf-8",
        );
      } catch {
        // Best-effort; do not fail in-memory success if disk write fails
      }
    }

    return data;
  }

  async getNameSets(env: EnvTarget, alias: string): Promise<MetadataNameSets> {
    const entry = this.cache.get(alias);
    if (entry !== undefined && this.now() - entry.fetchedAt < this.ttlMs) {
      return entry.nameSets;
    }
    const data = await this.getParsedMetadata(env, alias);
    return {
      entitySets: new Set(data.entitySets),
      functionImports: new Set(data.functionImports),
    };
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

  async getEntitySchema(env: EnvTarget, alias: string, entitySet: string): Promise<EntitySchema | undefined> {
    const data = await this.getParsedMetadata(env, alias);
    return data.entitySchemas[entitySet];
  }

  /**
   * Allowed Custom MDF entities, classified from the cached `$metadata` only
   * (D-62/DS-MDF-02: no data-endpoint request). Entities excluded by the
   * allowlist are never listed (D-68); `[]` therefore lists nothing.
   */
  async listCustomMdf(
    env: EnvTarget,
    alias: string,
    allowlist?: AllowlistEntry[],
    employeeLinkedOnly = false,
  ): Promise<CustomMdfSummary[]> {
    const data = await this.getParsedMetadata(env, alias);
    const summaries: CustomMdfSummary[] = [];
    for (const name of [...data.entitySets].sort()) {
      const schema = data.entitySchemas[name];
      if (schema === undefined || !isCustomMdfEntity(name) || !isEntityAllowed(allowlist, name)) {
        continue;
      }
      const summary = summarizeCustomMdf(schema, data.entitySchemas);
      if (!employeeLinkedOnly || isEmployeeLinkedType(summary.linkType)) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  /**
   * Full classification + guidance of one Custom MDF entity. Throws
   * `ENTITY_NOT_ALLOWED` (fail-closed, before touching metadata) when the
   * allowlist excludes it; returns `undefined` for unknown or non-custom names.
   */
  async getCustomMdfDetails(
    env: EnvTarget,
    alias: string,
    entitySet: string,
    allowlist?: AllowlistEntry[],
    locale?: SupportedLocale,
  ): Promise<CustomMdfDetails | undefined> {
    if (!isEntityAllowed(allowlist, entitySet)) {
      throw new SanitizedError(
        "ENTITY_NOT_ALLOWED",
        "the entity is not permitted by the configured entityAllowlist",
      );
    }
    const data = await this.getParsedMetadata(env, alias);
    const schema = data.entitySchemas[entitySet];
    if (schema === undefined || !isCustomMdfEntity(entitySet)) {
      return undefined;
    }
    return classifyEntity(schema, data.entitySchemas, locale);
  }
}
