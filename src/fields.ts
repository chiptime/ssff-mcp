/**
 * Field-level granularity for the entity allowlist.
 *
 * `entityAllowlist` entries may carry `fields`: the property names that entity
 * exposes. Absent or empty means every property, exactly like the entity list
 * itself. The entity's KEY properties are always readable, so `__metadata.uri`
 * never leaks a denied field and every record stays referenceable.
 *
 * Two jobs live here:
 * 1. REJECT references to a property the config does not permit (in `$select`,
 *    `$filter`, `$orderby` and `$select` inside `$expand`).
 * 2. REDACT the response payload, because omitting `$select` returns every
 *    field and a restriction that only guards the request guards nothing.
 */

import { permittedFieldsFor, type AllowlistEntry } from "./allowlist.js";
import type { NavigationLookup } from "./allowlist-navigation.js";

export interface EntitySchemaLike {
  keys: string[];
  properties: Array<{ name: string }>;
  navigationProperties: Array<{ name: string; targetEntitySet: string }>;
}

/** Resolves the schema of an entity set (from the cached metadata). */
export type SchemaLookup = (entitySet: string) => Promise<EntitySchemaLike | undefined>;

/**
 * The property names `entitySet` may expose, or undefined when the allowlist does
 * not restrict them.
 *
 * A configured field list whose schema cannot be resolved is NOT treated as
 * "unrestricted": that would silently return the very properties the config
 * wanted hidden. It fails closed instead.
 */
export async function allowedProperties(
  allowlist: AllowlistEntry[] | undefined,
  entitySet: string,
  schemaLookup: SchemaLookup,
): Promise<Set<string> | undefined> {
  const configured = permittedFieldsFor(allowlist, entitySet);
  if (configured === undefined) {
    return undefined;
  }
  const schema = await schemaLookup(entitySet);
  if (schema === undefined) {
    throw new FieldNotPermittedError(
      `"${entitySet}" declares fields but its schema could not be resolved from the cached metadata; refusing to return data that cannot be redacted`,
    );
  }
  return new Set([...configured, ...schema.keys]);
}

/**
 * Reject a reference to a property the config does not permit.
 *
 * Navigation properties are deliberately skipped here: the navigation policy
 * already owns them, and mixing the two would reject legitimate queries. Names
 * the metadata does not know are left to the service.
 */
export async function assertPropertyPermitted(
  allowlist: AllowlistEntry[] | undefined,
  entitySet: string,
  property: string,
  schemaLookup: SchemaLookup,
  optionName: string,
): Promise<void> {
  const schema = await schemaLookup(entitySet);
  if (schema === undefined) {
    return;
  }
  if (schema.navigationProperties.some((nav) => nav.name === property)) {
    return;
  }
  if (!schema.properties.some((candidate) => candidate.name === property)) {
    return;
  }
  const allowed = await allowedProperties(allowlist, entitySet, schemaLookup);
  if (allowed !== undefined && !allowed.has(property)) {
    throw new FieldNotPermittedError(
      `${optionName} references a property of "${entitySet}" that the configured fields do not permit`,
    );
  }
}

/** Thrown by the field policy; the tool layer maps it to ENTITY_NOT_ALLOWED. */
export class FieldNotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldNotPermittedError";
  }
}

/**
 * Hide non-permitted properties from a schema payload (`inspect_entity` and the
 * schema resource). Keys are always visible: `allowedProperties` includes them.
 * If you cannot read a property, you cannot discover it exists.
 */
export function filterSchemaProperties<T extends { properties: Array<{ name: string }> }>(
  schema: T,
  allowed: Set<string> | undefined,
): T {
  if (allowed === undefined) {
    return schema;
  }
  return { ...schema, properties: schema.properties.filter((p) => allowed.has(p.name)) };
}

const STRUCTURAL_KEYS = new Set(["__metadata", "results", "__deferred", "__count"]);

/**
 * Redact a record payload: properties outside the permitted set are removed,
 * and expanded navigations are redacted against the entity they reach.
 * `__metadata`, feed structure and deferred links are structural, not data.
 */
export async function redactValue(
  value: unknown,
  entitySet: string,
  allowlist: AllowlistEntry[] | undefined,
  schemaLookup: SchemaLookup,
  navigationLookup: NavigationLookup,
): Promise<unknown> {
  // Resolved first on purpose: a configured field list with no resolvable schema
  // throws here, before any payload could be returned unredacted.
  const allowed = await allowedProperties(allowlist, entitySet, schemaLookup);
  const schema = await schemaLookup(entitySet);
  if (schema === undefined) {
    // Only reachable when the entity has NO configured fields, so there is
    // nothing to redact; the value passes through untouched.
    return value;
  }
  const navByName = new Map(schema.navigationProperties.map((nav) => [nav.name, nav]));

  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((item) => redactValue(item, entitySet, allowlist, schemaLookup, navigationLookup)),
    );
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;

  // An expanded feed wraps its entries in { __metadata, results: [...] }.
  if (Array.isArray(record.results)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) {
      if (STRUCTURAL_KEYS.has(key) || key.startsWith("__")) {
        redacted[key] = inner;
        continue;
      }
      redacted[key] = inner; // non-structural extras are preserved verbatim
    }
    redacted.results = await Promise.all(
      record.results.map((item) =>
        redactValue(item, entitySet, allowlist, schemaLookup, navigationLookup),
      ),
    );
    return redacted;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (STRUCTURAL_KEYS.has(key) || key.startsWith("__")) {
      redacted[key] = inner;
      continue;
    }
    const nav = navByName.get(key);
    if (nav !== undefined) {
      redacted[key] = await redactValue(
        inner,
        nav.targetEntitySet,
        allowlist,
        schemaLookup,
        navigationLookup,
      );
      continue;
    }
    if (allowed !== undefined && !allowed.has(key)) {
      continue; // the property is not permitted: dropped
    }
    redacted[key] = inner;
  }
  return redacted;
}
