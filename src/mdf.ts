/**
 * Custom MDF discovery and classification (D-62..D-69).
 *
 * Everything here is a pure function over the already-parsed `$metadata`
 * (`EntitySchema`): no network, no I/O (DS-MDF-01/02). The reliable link signal
 * to an employee is a navigation property whose TARGET is `User` / `EmpEmployment`,
 * never the property name (real tenants use `cust_GerenteNav`, `cust_workerIdNav`,
 * `cust_Jefe_ServicioNav`, ...). The audit navigations `createdByNav` and
 * `lastModifiedByNav` point at `User` on every custom object and are always excluded.
 */

import { guidanceMessages, DEFAULT_LOCALE, type SupportedLocale } from "./i18n.js";
import type { EntityProperty, EntitySchema, NavigationProperty } from "./metadata.js";

export type MdfEmployeeLinkType =
  | "DIRECT_USER_KEY"
  | "DIRECT_EMPLOYMENT_KEY"
  | "USER_FIELD_NAVIGATION"
  | "EMPLOYMENT_FIELD_NAVIGATION"
  | "COMPOSITE_CHILD"
  | "UNLINKED_STANDALONE";

/** Employee link of one entity, nested in the detail payload (§5.1.3). */
export interface MdfEmployeeLink {
  type: MdfEmployeeLinkType;
  targetEntitySet?: string;
  matchingField?: string;
  navigationProperty?: string;
  /** Only for COMPOSITE_CHILD. */
  parentEntitySet?: string;
}

/** Semantic guidance block (§5.1.3). */
export interface MdfQueryGuidance {
  /** Catalog locale the `warnings` were resolved with (D-70). */
  locale: string;
  /** `$filter` template; absent when the entity has no employee link field. */
  suggestedFilter?: string;
  recommendedOrderBy?: string;
  /** Prose in the single active language, never several (D-70). */
  warnings: string[];
  exampleQuery: {
    tool: "query_entity";
    entityPath: string;
    filter?: string;
    orderby?: string;
    top?: number;
  };
}

/** Item of the `sf://{env}/mdf/custom` listing: flat and compact (§5.1.2). */
export interface CustomMdfSummary {
  name: string;
  isEffectiveDated: boolean;
  linkType: MdfEmployeeLinkType;
  targetEntity?: string;
  matchField?: string;
}

/**
 * Payload of `sf://{env}/entities/{entitySet}` for a Custom MDF entity (§5.1.3).
 * It does NOT extend `CustomMdfSummary`: the detail is nested and schema-shaped.
 */
export interface CustomMdfDetails {
  entitySet: string;
  entityType: string;
  isCustom: true;
  isEffectiveDated: boolean;
  keys: string[];
  employeeLink: MdfEmployeeLink;
  guidance: MdfQueryGuidance;
  properties: EntityProperty[];
  navigationProperties: NavigationProperty[];
}

/** The ONE definition of "Custom MDF entity" (D-63). */
export function isCustomMdfEntity(name: string): boolean {
  return /^[cC]ust_/.test(name);
}

const AUDIT_NAVIGATIONS = new Set(["createdByNav", "lastModifiedByNav"]);
const EFFECTIVE_DATE_KEYS = ["effectiveStartDate", "mdfSystemEffectiveStartDate"] as const;
const LINK_KEYS = ["externalCode", "userId"] as const;
const COMPOSITE_KEY = /^cust_([A-Za-z0-9_]+?)_(externalCode|effectiveStartDate|userId)$/;
const SAMPLE_USER_ID = "1042";

/** The effective-date key of the entity (D-69), when it has one. */
export function effectiveDateKey(schema: EntitySchema): string | undefined {
  return EFFECTIVE_DATE_KEYS.find((candidate) => schema.keys.includes(candidate));
}

/** True when the entity is tied to an employee directly (a composite child is indirect). */
export function isEmployeeLinkedType(type: MdfEmployeeLinkType): boolean {
  return (
    type === "DIRECT_USER_KEY" ||
    type === "DIRECT_EMPLOYMENT_KEY" ||
    type === "USER_FIELD_NAVIGATION" ||
    type === "EMPLOYMENT_FIELD_NAVIGATION"
  );
}

function businessNavigations(schema: EntitySchema, target: string): NavigationProperty[] {
  return schema.navigationProperties.filter(
    (candidate) => candidate.targetEntitySet === target && !AUDIT_NAVIGATIONS.has(candidate.name),
  );
}

/**
 * Rules in order (§4.2). Rules 1-2 require the navigation to be the KEY's OWN
 * (`externalCodeNav` for `externalCode`, `userIdNav` for `userId`): every MDF has an
 * `externalCode` key, so accepting any User navigation there would absorb every
 * linked entity and leave the field rules (3-4) unreachable.
 */
export function classifyEmployeeLink(
  schema: EntitySchema,
  allSchemas: Record<string, EntitySchema>,
): MdfEmployeeLink {
  const userNavs = businessNavigations(schema, "User");
  const employmentNavs = businessNavigations(schema, "EmpEmployment");

  const directKind: Array<[string, NavigationProperty[], MdfEmployeeLinkType]> = [
    ["User", userNavs, "DIRECT_USER_KEY"],
    ["EmpEmployment", employmentNavs, "DIRECT_EMPLOYMENT_KEY"],
  ];
  for (const [target, navs, type] of directKind) {
    for (const key of LINK_KEYS) {
      if (!schema.keys.includes(key)) {
        continue;
      }
      const own = navs.find((candidate) => candidate.name === `${key}Nav`);
      if (own !== undefined) {
        return { type, targetEntitySet: target, matchingField: key, navigationProperty: own.name };
      }
    }
  }

  const fieldKind: Array<[string, NavigationProperty[], MdfEmployeeLinkType]> = [
    ["User", userNavs, "USER_FIELD_NAVIGATION"],
    ["EmpEmployment", employmentNavs, "EMPLOYMENT_FIELD_NAVIGATION"],
  ];
  for (const [target, navs, type] of fieldKind) {
    const first = navs[0];
    if (first !== undefined) {
      return {
        type,
        targetEntitySet: target,
        matchingField: first.name.replace(/Nav$/, ""),
        navigationProperty: first.name,
      };
    }
  }

  for (const key of schema.keys) {
    const match = COMPOSITE_KEY.exec(key);
    if (match === null) {
      continue;
    }
    const parent = `cust_${match[1]}`;
    if (allSchemas[parent] !== undefined) {
      return { type: "COMPOSITE_CHILD", parentEntitySet: parent };
    }
  }

  return { type: "UNLINKED_STANDALONE" };
}

/** `$filter` expression that ties the entity to a user, or undefined when none applies. */
function linkExpression(link: MdfEmployeeLink): string | undefined {
  switch (link.type) {
    case "DIRECT_USER_KEY":
    case "DIRECT_EMPLOYMENT_KEY":
      return link.matchingField;
    case "USER_FIELD_NAVIGATION":
    case "EMPLOYMENT_FIELD_NAVIGATION":
      return `${link.navigationProperty}/userId`;
    default:
      return undefined;
  }
}

function buildGuidance(
  schema: EntitySchema,
  link: MdfEmployeeLink,
  dateKey: string | undefined,
  locale: SupportedLocale,
): MdfQueryGuidance {
  const messages = guidanceMessages(locale);
  const expression = linkExpression(link);
  const suggestedFilter = expression === undefined ? undefined : `${expression} eq '<userId>'`;
  const orderby = dateKey === undefined ? undefined : `${dateKey} desc`;

  const warnings: string[] = [];
  if (link.targetEntitySet === "User") {
    warnings.push(messages.reverseNavigation(schema.entitySet));
  }
  if (dateKey !== undefined) {
    const fallbackField = schema.keys.find((key) => !(EFFECTIVE_DATE_KEYS as readonly string[]).includes(key));
    warnings.push(messages.effectiveDated(expression ?? fallbackField ?? "externalCode", dateKey));
  }
  if (link.type === "COMPOSITE_CHILD" && link.parentEntitySet !== undefined) {
    warnings.push(messages.compositeChild(link.parentEntitySet, schema.entitySet));
  }
  if (link.type === "UNLINKED_STANDALONE") {
    warnings.push(messages.unlinked(schema.entitySet));
  }
  warnings.push(messages.permissions(schema.entitySet));

  const exampleQuery: MdfQueryGuidance["exampleQuery"] = {
    tool: "query_entity",
    entityPath: schema.entitySet,
  };
  if (expression !== undefined) {
    exampleQuery.filter = `${expression} eq '${SAMPLE_USER_ID}'`;
  }
  if (orderby !== undefined) {
    exampleQuery.orderby = orderby;
  }
  exampleQuery.top = dateKey !== undefined && expression !== undefined ? 1 : 10;

  const guidance: MdfQueryGuidance = { locale, warnings, exampleQuery };
  if (suggestedFilter !== undefined) {
    guidance.suggestedFilter = suggestedFilter;
  }
  if (orderby !== undefined) {
    guidance.recommendedOrderBy = orderby;
  }
  return guidance;
}

/** Full classification of one Custom MDF entity (the detail payload). */
export function classifyEntity(
  schema: EntitySchema,
  allSchemas: Record<string, EntitySchema>,
  locale: SupportedLocale = DEFAULT_LOCALE,
): CustomMdfDetails {
  const link = classifyEmployeeLink(schema, allSchemas);
  const dateKey = effectiveDateKey(schema);
  return {
    entitySet: schema.entitySet,
    entityType: schema.entityType,
    isCustom: true,
    isEffectiveDated: dateKey !== undefined,
    keys: schema.keys,
    employeeLink: link,
    guidance: buildGuidance(schema, link, dateKey, locale),
    properties: schema.properties,
    navigationProperties: schema.navigationProperties,
  };
}

/** Flat summary used by the listing (no guidance, no schema). */
export function summarizeCustomMdf(
  schema: EntitySchema,
  allSchemas: Record<string, EntitySchema>,
): CustomMdfSummary {
  const link = classifyEmployeeLink(schema, allSchemas);
  const summary: CustomMdfSummary = {
    name: schema.entitySet,
    isEffectiveDated: effectiveDateKey(schema) !== undefined,
    linkType: link.type,
  };
  if (link.targetEntitySet !== undefined) {
    summary.targetEntity = link.targetEntitySet;
  }
  if (link.matchingField !== undefined) {
    summary.matchField = link.matchingField;
  }
  return summary;
}
