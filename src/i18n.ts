/**
 * Locale resolution and the guidance message catalog (D-70/FR-75).
 *
 * Guidance prose is resolved in exactly ONE active language per response,
 * never all of them at once (DS-MDF-05: < 5 KB per entity). The catalog lives
 * in the repository as plain TypeScript (DS-MDF-06: no external dependency).
 *
 * `$filter` templates, `exampleQuery` and OData identifiers are NOT translated;
 * only the explanatory `warnings` go through this catalog.
 */

export const DEFAULT_LOCALE = "en_US";

/** Catalog keys, normalized as `ll_RR`. */
export const SUPPORTED_LOCALES = ["en_US", "es_ES"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Lax BCP-47: `es`, `es_ES` or `es-ES`. Mirrors the `defaultLocale` config format. */
const LOCALE_PATTERN = /^([A-Za-z]{2})(?:[-_]([A-Za-z]{2}))?$/;

/** Map any lax locale to a catalog key; unknown or malformed input yields `undefined`. */
function matchCatalogLocale(raw: string): SupportedLocale | undefined {
  const match = LOCALE_PATTERN.exec(raw.trim());
  if (match === null) {
    return undefined;
  }
  const language = match[1]!.toLowerCase();
  const region = match[2]?.toUpperCase();
  if (region !== undefined) {
    const exact = SUPPORTED_LOCALES.find((candidate) => candidate === `${language}_${region}`);
    if (exact !== undefined) {
      return exact;
    }
  }
  // Same language, other (or missing) region: first catalog entry of that language.
  return SUPPORTED_LOCALES.find((candidate) => candidate.startsWith(`${language}_`));
}

export interface LocaleSources {
  /** `locale` argument of the tool call: the language the user is speaking. */
  tool?: string;
  /** `defaultLocale` from config.json: the user's declared preference. */
  config?: string;
  /** `SF_DEFAULT_LOCALE` environment variable. */
  env?: string;
}

function provided(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the single active locale. The user's choice wins: the first level that
 * is PROVIDED decides, in the order tool > config > env > `en_US`. A provided
 * locale without translations falls back to `en_US` (it never falls through to a
 * lower level, which would answer in a language the user did not ask for).
 * Resources have no parameters, so they pass no `tool` source.
 */
export function resolveLocale(sources: LocaleSources): SupportedLocale {
  for (const candidate of [sources.tool, sources.config, sources.env]) {
    if (provided(candidate)) {
      return matchCatalogLocale(candidate) ?? DEFAULT_LOCALE;
    }
  }
  return DEFAULT_LOCALE;
}

export interface GuidanceMessages {
  /** Reverse navigation from `User` is expandable but unbounded (D-67/DS-MDF-03). */
  reverseNavigation(entitySet: string): string;
  /** Effective-dated: how to read the current record. */
  effectiveDated(linkField: string, dateField: string): string;
  /** Composite child of a parent custom object. */
  compositeChild(parent: string, entitySet: string): string;
  /** Not linked to employees. */
  unlinked(entitySet: string): string;
  /** RBP read permission caveat (§8.2). */
  permissions(entitySet: string): string;
}

const CATALOG: Record<SupportedLocale, GuidanceMessages> = {
  en_US: {
    reverseNavigation: (entitySet) =>
      `Reverse navigation from User exists and is expandable, but it returns the whole child collection and cannot be bounded (measured: 224 records / 1.75 MB); query ${entitySet} as the root with $filter and $top.`,
    effectiveDated: (linkField, dateField) =>
      `The entity is effective-dated. To get the current record, filter by ${linkField} and order by ${dateField} desc with $top=1.`,
    compositeChild: (parent, entitySet) =>
      `${entitySet} is a composite child of ${parent}; it has no direct employee link. Read the parent object first and use its key to filter this one.`,
    unlinked: (entitySet) =>
      `${entitySet} has no link to employees; it looks like a master or catalog table. Query it directly without an employee filter.`,
    permissions: (entitySet) =>
      `Reading ${entitySet} requires read permission in SAP (role-based permissions): an empty result can mean missing permission rather than missing data.`,
  },
  es_ES: {
    reverseNavigation: (entitySet) =>
      `La navegación inversa desde User existe y es expandible, pero devuelve la colección hija completa sin poder acotarse (medido: 224 registros / 1,75 MB); consulta ${entitySet} como raíz con $filter y $top.`,
    effectiveDated: (linkField, dateField) =>
      `La entidad está fechada efectivamente. Para obtener el registro vigente, filtra por ${linkField} y ordena por ${dateField} desc con $top=1.`,
    compositeChild: (parent, entitySet) =>
      `${entitySet} es un hijo compuesto de ${parent}; no tiene vínculo directo con empleados. Lee primero el objeto padre y usa su clave para filtrar este.`,
    unlinked: (entitySet) =>
      `${entitySet} no está vinculada a empleados; parece una tabla maestra o catálogo. Consúltala directamente sin filtro de empleado.`,
    permissions: (entitySet) =>
      `Leer ${entitySet} requiere permiso de lectura en SAP (permisos basados en roles): un resultado vacío puede indicar falta de permiso y no ausencia de datos.`,
  },
};

export function guidanceMessages(locale: SupportedLocale): GuidanceMessages {
  return CATALOG[locale];
}
