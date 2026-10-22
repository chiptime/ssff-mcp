/**
 * Single source of truth for the MCP tools: name, title, description and input
 * schema.
 *
 * `createMcpServer` (src/tools.ts) registers every tool from this catalog, and
 * `src/tool-doc.ts` renders the tools reference in docs/tools.md from it, so the
 * documentation cannot drift from the registered tools. Nothing here changes the
 * registered contract: the values are the exact ones previously inlined in
 * src/tools.ts.
 */

import { z } from "zod";

/** SAP $batch hard limit: max embedded requests per batch (D-28/R9). */
export const MAX_BATCH_REQUESTS = 180;

export const LIST_ENVIRONMENTS_DESCRIPTION =
  "Lists the environments configured for this server (aliases and auth type only; no URLs or credentials). Takes no arguments.";

export const QUERY_ENTITY_DESCRIPTION = [
  "Reads entity data from SAP SuccessFactors OData v2 for the selected environment.",
  "entityPath examples: \"User\", \"User('123')\", \"Foobar(key1='a',key2=1)/navProperty\".",
  "Options map 1:1 to OData system query options and their values pass through unmodified:",
  "filter -> $filter, orderby -> $orderby, select -> $select, expand -> $expand, top -> $top,",
  "skip -> $skip, inlinecount -> $inlinecount (allpages only).",
  "The configured entityAllowlist/entityDenylist is enforced on the first path segment AND on every",
  "navigation destination, including every $expand route: a hop whose target entity set is not permitted",
  "fails with ENTITY_NOT_ALLOWED, a hop the metadata does not model fails with NAVIGATION_NOT_ALLOWED, and",
  "an $expand the server cannot fully parse (including $filter or $orderby nested inside it) fails with",
  "OPTION_INVALID instead of being dispatched unverified.",
  "An allowlist entry may also carry fields: the properties that entity exposes (its keys are",
  "always readable). References to a property outside that list fail with ENTITY_NOT_ALLOWED, the",
  "returned records are redacted to the permitted properties, and when fields apply the xml output",
  "is downgraded to JSON with outputDowngraded: true.",
  "Effective dating: fromDate, toDate and asOfDate (bare YYYY-MM-DD, NOT $-prefixed; SuccessFactors",
  "ignores the $-prefixed forms) select the effective-dated slices; asOfDate is exclusive and cannot",
  "be combined with fromDate or toDate.",
  "Ceiling: at most 1000 records and exactly one OData page are returned per call;",
  "next links are never followed automatically (hasMore indicates a next page exists).",
  "Continuation: when hasMore is true the response may carry an opaque cursor;",
  "to fetch the exact next page, re-issue the SAME call (same environment, entityPath and options)",
  "passing that cursor as the cursor argument. The cursor is a signed envelope tied to this",
  "server process: it is rejected (CURSOR_INVALID) when altered, reused with different",
  "arguments, or after a server restart; skip cannot be combined with cursor.",
  "inlinecount \"allpages\" returns totalCount when the service provides __count.",
  "output selects the representation: \"json\" (default, unwrapped records) or",
  "\"xml\" (raw service XML body, hasMore/totalCount/cursor reported in structuredContent).",
].join(" ");

export const BATCH_GET_DESCRIPTION = [
  "Executes multiple read-only OData v2 GETs against the selected environment in ONE $batch POST.",
  "Each item uses exactly the query_entity GET grammar (entityPath plus optional filter, orderby,",
  "select, expand, fromDate, toDate, asOfDate, top, skip, cursor, inlinecount); there is no field for",
  "HTTP method, URL, host, headers, body or changesets, and unknown keys are rejected before dispatch.",
  "fromDate, toDate and asOfDate are bare YYYY-MM-DD effective-dating options (NOT $-prefixed);",
  "asOfDate is exclusive and cannot be combined with fromDate or toDate.",
  "Hard limits: 1 to 180 items per call (SAP $batch limit) and at most 1000 records returned in",
  "TOTAL across all items; items are processed in input order and truncated records are flagged",
  "(truncatedToCeiling) when the aggregate ceiling is hit.",
  "Every item is fully validated BEFORE the batch is dispatched (path grammar, entity allowlist,",
  "option bounds, cursor binding, $metadata classification): one invalid item rejects the whole",
  "batch with no $batch POST issued (a metadata GET for classification is the only allowed call).",
  "The entityAllowlist/entityDenylist is enforced per item on the first path segment AND on every navigation",
  "destination, including every $expand route; one denied, unresolvable or unparseable item rejects the whole",
  "batch before the POST. Allowlist entries may carry fields (permitted properties, keys always readable):",
  "an item referencing a non-permitted property rejects the batch, records are redacted, and when fields apply",
  "the xml output is downgraded to JSON with outputDowngraded: true per item.",
  "The response contains one entry per item in input order with per-item status:",
  "{ index, path, success, httpStatus, recordCount, records|body, hasMore, cursor?, totalCount?,",
  "truncatedToCeiling? }; per-item failures carry a sanitized error, never the raw service body.",
  "output selects the representation for the whole call: \"json\" (default, unwrapped records) or",
  "\"xml\" (raw Atom item bodies, Accept: application/atom+xml). Continuation cursors work exactly",
  "like query_entity cursors and must be replayed with the same environment, entityPath and options.",
].join(" ");

export const INSPECT_ENTITY_DESCRIPTION = [
  "Reads the data model from the cached $metadata; no data request is made.",
  "Without entitySet it lists entities as { name, isCustom }; customOnly narrows to Custom MDF objects",
  "(adding isEffectiveDated, linkType, targetEntity, matchField, plus employeeLinkedCount), employeeLinkedOnly",
  "narrows that list further to the ones tied to a User or EmpEmployment, and query filters names by substring.",
  "With entitySet it returns that entity's schema; Custom MDF entities also carry isCustom, isEffectiveDated,",
  "employeeLink and query guidance (suggested $filter, $orderby, warnings, and a ready query_entity example).",
  "Always query a custom entity as the root with $filter and $top; expanding it from User returns the whole child collection.",
  "locale selects the language of the guidance prose (the user's language, e.g. es_ES).",
].join(" ");

export const RESOLVE_PICKLIST_DESCRIPTION = [
  "Resolves picklist option IDs to readable labels, lists options of a picklist, or searches options",
  "by label to assist in building $filter queries.",
  "optionId: resolves a numeric legacy ID (e.g. '10283').",
  "picklistId: lists active options for that catalog (e.g. 'maritalStatus', 'gender').",
  "externalCode: looks up an option by its business code (e.g. 'M', 'FULL_TIME').",
  "query: searches labels by text and returns matching optionId and suggestedFilter (e.g. 'Casado' -> 'maritalStatus eq 10119').",
  "locale: preferred language for labels (e.g. 'es_ES', 'en_US').",
  "forceRefresh: when true, refreshes the local cache from SuccessFactors.",
].join(" ");

// The date format is validated in buildQuery (not by zod) so a malformed value
// surfaces as our sanitized OPTION_INVALID rather than a protocol validation error.
const EFFECTIVE_FROM_DESCRIPTION =
  "Effective-dating window start, format YYYY-MM-DD. Sent as the bare fromDate query parameter " +
  "(not $-prefixed). Cannot be combined with asOfDate.";
const EFFECTIVE_TO_DESCRIPTION =
  "Effective-dating window end, format YYYY-MM-DD. Sent as the bare toDate query parameter " +
  "(not $-prefixed). Cannot be combined with asOfDate.";
const EFFECTIVE_AS_OF_DESCRIPTION =
  "Effective-dating point in time, format YYYY-MM-DD. Sent as the bare asOfDate query parameter " +
  "(not $-prefixed). Cannot be combined with fromDate or toDate.";

const environmentArg = z.string().optional();

export const queryEntitySchema = z
  .object({
    environment: environmentArg,
    entityPath: z.string().min(1),
    filter: z.string().optional(),
    orderby: z.string().optional(),
    select: z.string().optional(),
    expand: z.string().optional(),
    fromDate: z.string().optional().describe(EFFECTIVE_FROM_DESCRIPTION),
    toDate: z.string().optional().describe(EFFECTIVE_TO_DESCRIPTION),
    asOfDate: z.string().optional().describe(EFFECTIVE_AS_OF_DESCRIPTION),
    top: z.number().int().optional(),
    skip: z.number().int().optional(),
    cursor: z
      .string()
      .optional()
      .describe(
        "Continuation cursor from a previous response. Repeat the SAME environment, entityPath " +
          "and options of the call that produced it and pass the cursor to fetch the exact next " +
          "page. Rejected (CURSOR_INVALID) if altered, reused with different arguments, or after " +
          "a server restart. Cannot be combined with skip.",
      ),
    inlinecount: z
      .enum(["allpages"])
      .optional()
      .describe('Adds $inlinecount=allpages; the response includes totalCount when the service provides __count.'),
    resolvePicklists: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Cuando es true, enriquece automáticamente los campos asociados a picklists añadiendo las etiquetas legibles en la propiedad _picklistLabels sin modificar los valores nativos.",
      ),
    locale: z
      .string()
      .optional()
      .describe(
        "Idioma preferido para las etiquetas (ej. 'es_ES', 'en_US'). Si se omite, utiliza el locale configurado globalmente (`defaultLocale`), si existe.",
      ),
    output: z
      .enum(["json", "xml"])
      .optional()
      .describe('Response representation: "json" (default, unwrapped records) or "xml" (raw service XML body).'),
  })
  .strict();

export const listEnvironmentsSchema = z.object({}).strict();

export const inspectEntitySchema = z
  .object({
    environment: environmentArg,
    entitySet: z
      .string()
      .min(1)
      .optional()
      .describe("Entity set to detail (e.g. 'User', 'cust_EmployeeEquipment'). If omitted, lists entities."),
    customOnly: z
      .boolean()
      .optional()
      .describe("When listing, keep only Custom MDF objects and add their classification fields. Default: false."),
    employeeLinkedOnly: z
      .boolean()
      .optional()
      .describe("When listing Custom MDF objects, keep only those tied to a User or EmpEmployment. Requires customOnly."),
    query: z
      .string()
      .min(1)
      .optional()
      .describe("When listing, keep entities whose name contains this text (case-insensitive)."),
    locale: z
      .string()
      .optional()
      .describe(
        "Locale for the guidance text, normally the user's own language (e.g. 'es_ES'). It takes precedence over config defaultLocale, SF_DEFAULT_LOCALE and the 'en_US' fallback.",
      ),
  })
  .strict();

/** One batch_get item: exactly the query_entity GET grammar, nothing else. */
const batchRequestItemSchema = z
  .object({
    entityPath: z.string().min(1),
    filter: z.string().optional(),
    orderby: z.string().optional(),
    select: z.string().optional(),
    expand: z.string().optional(),
    fromDate: z.string().optional().describe(EFFECTIVE_FROM_DESCRIPTION),
    toDate: z.string().optional().describe(EFFECTIVE_TO_DESCRIPTION),
    asOfDate: z.string().optional().describe(EFFECTIVE_AS_OF_DESCRIPTION),
    top: z.number().int().optional(),
    skip: z.number().int().optional(),
    cursor: z.string().optional(),
    inlinecount: z.enum(["allpages"]).optional(),
    resolvePicklists: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Cuando es true, enriquece automáticamente los campos asociados a picklists añadiendo las etiquetas legibles en la propiedad _picklistLabels sin modificar los valores nativos.",
      ),
    locale: z
      .string()
      .optional()
      .describe(
        "Idioma preferido para las etiquetas (ej. 'es_ES', 'en_US'). Si se omite, utiliza el locale configurado globalmente (`defaultLocale`), si existe.",
      ),
  })
  .strict();

export const resolvePicklistSchema = z
  .object({
    environment: environmentArg,
    picklistId: z.string().optional().describe("Identificador de la picklist (ej. 'gender', 'maritalStatus')."),
    optionId: z.union([z.string(), z.number()]).optional().describe("Option ID numérico de SAP (ej. '10283' o 10283)."),
    externalCode: z.string().optional().describe("Código externo de negocio (ej. 'M', 'FULL_TIME')."),
    query: z.string().optional().describe("Texto libre o etiqueta a buscar para traducción inversa (ej. 'Casado', 'Masculino')."),
    locale: z.string().optional().describe("Código de idioma (ej. 'es_ES', 'en_US'). Por defecto usa el configurado globalmente (`defaultLocale`), si existe."),
    forceRefresh: z.boolean().optional().describe("Si es true, ignora la caché local y consulta directamente a SAP."),
  })
  .strict()
  .refine(
    (data) =>
      data.picklistId !== undefined ||
      data.optionId !== undefined ||
      data.externalCode !== undefined ||
      data.query !== undefined,
    { message: "Al menos uno de picklistId, optionId, externalCode o query debe ser proporcionado." },
  );

export const batchGetSchema = z
  .object({
    environment: environmentArg,
    // Hard SAP limit of 180 embedded requests per $batch (D-28/R9): enforced
    // by the schema, so 0 or >180 is rejected before any work or network call.
    requests: z.array(batchRequestItemSchema).min(1).max(MAX_BATCH_REQUESTS),
    output: z
      .enum(["json", "xml"])
      .optional()
      .describe('Response representation for the whole call: "json" (default) or "xml" (raw Atom item bodies).'),
  })
  .strict();

export interface ToolCatalogEntry {
  /** Registered MCP tool name. */
  name: string;
  /** Human-facing title shown by MCP clients. */
  title: string;
  /** Tool description shown to the model. */
  description: string;
  /** Strict input schema. */
  schema: z.ZodTypeAny;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    name: "list_environments",
    title: "List configured environments",
    description: LIST_ENVIRONMENTS_DESCRIPTION,
    schema: listEnvironmentsSchema,
  },
  {
    name: "inspect_entity",
    title: "Inspect the data model",
    description: INSPECT_ENTITY_DESCRIPTION,
    schema: inspectEntitySchema,
  },
  {
    name: "resolve_picklist",
    title: "Resolve or search picklist options and labels",
    description: RESOLVE_PICKLIST_DESCRIPTION,
    schema: resolvePicklistSchema,
  },
  {
    name: "query_entity",
    title: "Query OData v2 entity data",
    description: QUERY_ENTITY_DESCRIPTION,
    schema: queryEntitySchema,
  },
  {
    name: "batch_get",
    title: "Batch multiple OData v2 GETs (read-only $batch)",
    description: BATCH_GET_DESCRIPTION,
    schema: batchGetSchema,
  },
];
