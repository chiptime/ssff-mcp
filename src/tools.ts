/**
 * MCP tool registrations: list_environments, query_entity, batch_get.
 *
 * Contract enforced here:
 * - Explicit environment per request, fail-closed (ENVIRONMENT_REQUIRED /
 *   ENVIRONMENT_UNKNOWN; never an implicit pick, never a retry elsewhere).
 * - Configuration is re-read and re-validated on EVERY tool call.
 * - Only GET is ever dispatched; entity paths are validated against the
 *   tenant metadata before dispatch (function imports rejected). The single
 *   exception POST is batch_get's fixed GET-only $batch envelope (DS-P2-04),
 *   dispatched only after every item passed the full preflight.
 * - Errors are returned as sanitized `{ code, message }` isError results.
 * - Every call produces one stderr JSON log line with metadata only.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { executeBatchGet, sanitizeEmbeddedFailure } from "./batch.js";
import { isEntityAllowed, type AllowlistEntry } from "./allowlist.js";
import { loadConfig, type EnvironmentConfig } from "./config.js";
import { CURSOR_VERSION, defaultCursorCodec } from "./cursor.js";
import { SanitizedError, toSanitizedError } from "./errors.js";
import { dispatchGet, envTargetFor, type EnvTarget, type FetchImpl } from "./http.js";
import { resolveLocale } from "./i18n.js";
import { makeLogger, type LogSink, type Logger } from "./logger.js";
import { classifyEmployeeLink, effectiveDateKey, isCustomMdfEntity, isEmployeeLinkedType } from "./mdf.js";
import { MetadataService } from "./metadata.js";
import { exceedsResponseCap, responseTooLargeError } from "./size-guard.js";
import {
  buildQuery,
  extractSkiptoken,
  extractXmlPaging,
  RECORD_CEILING,
  sanitizeXmlNextLinks,
  unwrapODataV2,
  validateEntityPath,
} from "./odata.js";

const QUERY_TOOL_TIMEOUT_MS = 30_000;
const BATCH_TOOL_TIMEOUT_MS = 120_000;
/** SAP $batch hard limit: max embedded requests per batch (D-28/R9). */
export const MAX_BATCH_REQUESTS = 180;

export const QUERY_ENTITY_DESCRIPTION = [
  "Reads entity data from SAP SuccessFactors OData v2 for the selected environment.",
  "entityPath examples: \"User\", \"User('123')\", \"Foobar(key1='a',key2=1)/navProperty\".",
  "Options map 1:1 to OData system query options and their values pass through unmodified:",
  "filter -> $filter, orderby -> $orderby, select -> $select, expand -> $expand, top -> $top,",
  "skip -> $skip, inlinecount -> $inlinecount (allpages only).",
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
  "select, expand, top, skip, cursor, inlinecount); there is no field for HTTP method, URL, host,",
  "headers, body or changesets, and unknown keys are rejected before dispatch.",
  "Hard limits: 1 to 180 items per call (SAP $batch limit) and at most 1000 records returned in",
  "TOTAL across all items; items are processed in input order and truncated records are flagged",
  "(truncatedToCeiling) when the aggregate ceiling is hit.",
  "Every item is fully validated BEFORE the batch is dispatched (path grammar, entity allowlist,",
  "option bounds, cursor binding, $metadata classification): one invalid item rejects the whole",
  "batch with no $batch POST issued (a metadata GET for classification is the only allowed call).",
  "The response contains one entry per item in input order with per-item status:",
  "{ index, path, success, httpStatus, recordCount, records|body, hasMore, cursor?, totalCount?,",
  "truncatedToCeiling? }; per-item failures carry a sanitized error, never the raw service body.",
  "output selects the representation for the whole call: \"json\" (default, unwrapped records) or",
  "\"xml\" (raw Atom item bodies, Accept: application/atom+xml). Continuation cursors work exactly",
  "like query_entity cursors and must be replayed with the same environment, entityPath and options.",
].join(" ");

const environmentArg = z.string().optional();

const queryEntitySchema = z
  .object({
    environment: environmentArg,
    entityPath: z.string().min(1),
    filter: z.string().optional(),
    orderby: z.string().optional(),
    select: z.string().optional(),
    expand: z.string().optional(),
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
    output: z
      .enum(["json", "xml"])
      .optional()
      .describe('Response representation: "json" (default, unwrapped records) or "xml" (raw service XML body).'),
  })
  .strict();

const listEnvironmentsSchema = z.object({}).strict();

export const INSPECT_CUSTOM_MDF_DESCRIPTION = [
  "Discovers Custom MDF objects (cust_* entity sets) of the selected environment from the cached $metadata;",
  "no data request is made. Without entitySet it returns the compact catalog of allowed Custom MDF entities",
  "(name, isEffectiveDated, linkType, targetEntity, matchField); employeeLinkedOnly keeps only the entities",
  "tied to a User or EmpEmployment. With entitySet it returns the schema plus employeeLink and query guidance",
  "(suggested $filter, $orderby for effective-dated objects, warnings, and a ready query_entity example).",
  "Always query the custom entity as the root with $filter and $top; expanding it from User returns the whole child collection.",
  "locale selects the language of the guidance warnings (the user's language, e.g. es_ES).",
].join(" ");

const inspectCustomMdfSchema = z
  .object({
    environment: environmentArg,
    entitySet: z
      .string()
      .min(1)
      .optional()
      .describe("Specific Custom MDF entity set (e.g. 'cust_EmployeeEquipment'). If omitted, lists all Custom MDF entities."),
    employeeLinkedOnly: z
      .boolean()
      .optional()
      .describe("When listing, keep only entities linked to User or EmpEmployment. Default: false."),
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
    top: z.number().int().optional(),
    skip: z.number().int().optional(),
    cursor: z.string().optional(),
    inlinecount: z.enum(["allpages"]).optional(),
  })
  .strict();

const batchGetSchema = z
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

export interface ServerDeps {
  /** Injectable fetch (tests capture requests / fake responses). */
  fetchImpl?: FetchImpl;
  /** Overrides the config file path (tests). */
  configPath?: string;
  /** Injectable log sink (defaults to stderr). */
  logSink?: LogSink;
  /** Injectable clock for the metadata TTL cache (tests). */
  now?: () => number;
  /** Receives the loose-config-permissions warning (defaults to stderr). */
  onConfigWarning?: (message: string) => void;
  /** Overrides the cache directory for metadata (tests/prod). */
  cacheDir?: string;
  /** Explicitly disables or enables disk cache (tests/prod). */
  disableDiskCache?: boolean;
  /** Environment variables read for SF_DEFAULT_LOCALE (defaults to process.env; tests). */
  env?: NodeJS.ProcessEnv;
}

interface ToolOutcome {
  structured: Record<string, unknown>;
  text: string;
  recordCount?: number;
}

function resolveEnvironment(
  environments: Record<string, EnvironmentConfig>,
  requested: string | undefined,
  allowImplicit = false,
): { alias: string; env: EnvironmentConfig } {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    // Inline mode synthesizes exactly one environment; only then may a call
    // omit `environment` (FR-49/D-49). A config.json keeps D-02/FR-02.
    const aliases = Object.keys(environments);
    if (allowImplicit && aliases.length === 1) {
      const alias = aliases[0]!;
      return { alias, env: environments[alias]! };
    }
    throw new SanitizedError(
      "ENVIRONMENT_REQUIRED",
      "an environment must be explicitly provided; no environment is ever selected implicitly",
    );
  }
  const env = environments[requested];
  if (env === undefined) {
    throw new SanitizedError(
      "ENVIRONMENT_UNKNOWN",
      `environment "${requested}" is not configured; use list_environments to see the configured environments`,
    );
  }
  return { alias: requested, env };
}

interface QueryEntityArgs {
  environment?: string;
  entityPath: string;
  filter?: string;
  orderby?: string;
  select?: string;
  expand?: string;
  top?: number;
  skip?: number;
  cursor?: string;
  inlinecount?: "allpages";
  output?: "json" | "xml";
}

/** Option fields the cursor binding covers (shared by query_entity and batch_get items). */
type CursorOptionsSource = Pick<
  QueryEntityArgs,
  "filter" | "orderby" | "select" | "expand" | "top" | "inlinecount" | "output"
>;

/**
 * Canonical option subset the cursor binding covers (D-27): the options that
 * shape the query result. Deliberately excludes `skip` and `cursor` itself.
 * Only explicitly provided keys are included; callers must repeat the same
 * arguments for a cursor to validate.
 */
function cursorBindingOptions(args: CursorOptionsSource): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (args.filter !== undefined) {
    options.filter = args.filter;
  }
  if (args.orderby !== undefined) {
    options.orderby = args.orderby;
  }
  if (args.select !== undefined) {
    options.select = args.select;
  }
  if (args.expand !== undefined) {
    options.expand = args.expand;
  }
  if (args.top !== undefined) {
    options.top = args.top;
  }
  if (args.inlinecount !== undefined) {
    options.inlinecount = args.inlinecount;
  }
  // `output` has a default: omitted and explicit "json" are the same binding.
  options.output = args.output ?? "json";
  return options;
}

/**
 * Build the continuation cursor for a next URL, when a usable $skiptoken can
 * be extracted. Returns undefined when continuation cannot be established —
 * it is never invented (FR-25).
 */
function encodeContinuationCursor(
  env: string,
  entityPath: string,
  options: Record<string, unknown>,
  nextUrl: string,
): string | undefined {
  const skiptoken = extractSkiptoken(nextUrl);
  if (skiptoken === null) {
    return undefined;
  }
  return defaultCursorCodec.encode({ v: CURSOR_VERSION, env, path: entityPath, options, skiptoken });
}

export function createMcpServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer(
    { name: "ssff-mcp", version: "0.1.0" },
    { instructions: "Read-only MCP server for SAP SuccessFactors OData v2. Name the environment explicitly; in inline mode (a single configured environment) it may be omitted." },
  );
  const log: Logger = makeLogger(deps.logSink);
  const fetchImpl = deps.fetchImpl;
  const envVars = deps.env ?? process.env;
  const metadataService = new MetadataService({
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    cacheDir: deps.cacheDir,
    disableDiskCache: deps.disableDiskCache,
  });

  /** Freshly loaded config per tool call: environments + optional allowlist + inline flag. */
  interface FreshConfig {
    environments: Record<string, EnvironmentConfig>;
    entityAllowlist?: AllowlistEntry[];
    defaultLocale?: string;
    inline?: boolean;
  }

  async function loadFreshConfig(resolveSecretsFor?: string | null): Promise<FreshConfig> {
    const config = await loadConfig({
      configPath: deps.configPath,
      onWarning: deps.onConfigWarning,
      resolveSecretsFor,
    });
    return {
      environments: config.environments,
      entityAllowlist: config.entityAllowlist,
      defaultLocale: config.defaultLocale,
      inline: config.inline,
    };
  }

  async function executeTool(
    tool: string,
    environment: string | undefined,
    fn: () => Promise<ToolOutcome>,
  ): Promise<CallToolResult> {
    const startedAt = Date.now();
    try {
      const outcome = await fn();
      log({
        tool,
        environment,
        outcome: "ok",
        durationMs: Date.now() - startedAt,
        recordCount: outcome.recordCount,
      });
      return {
        content: [{ type: "text", text: outcome.text }],
        structuredContent: outcome.structured,
      };
    } catch (error) {
      const sanitized = toSanitizedError(error);
      log({
        tool,
        environment,
        outcome: "error",
        code: sanitized.code,
        durationMs: Date.now() - startedAt,
      });
      const payload: Record<string, unknown> = { code: sanitized.code, message: sanitized.message };
      if (sanitized.httpStatus !== undefined) {
        payload.httpStatus = sanitized.httpStatus;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true,
      };
    }
  }

  server.registerTool(
    "list_environments",
    {
      title: "List configured environments",
      description:
        "Lists the environments configured for this server (aliases and auth type only; no URLs or credentials). Takes no arguments.",
      inputSchema: listEnvironmentsSchema,
    },
    async () =>
      await executeTool("list_environments", undefined, async () => {
        const { environments } = await loadFreshConfig(null);
        const list = Object.keys(environments)
          .sort()
          .map((alias) => ({ alias, authType: environments[alias]!.auth.type }));
        const structured = { environments: list };
        return { structured, text: JSON.stringify(structured, null, 2) };
      }),
  );

  server.registerTool(
    "inspect_custom_mdf",
    {
      title: "Inspect Custom MDF objects",
      description: INSPECT_CUSTOM_MDF_DESCRIPTION,
      inputSchema: inspectCustomMdfSchema,
    },
    async (args) =>
      await executeTool("inspect_custom_mdf", args.environment, async () => {
        const { environments, entityAllowlist, defaultLocale, inline } = await loadFreshConfig(args.environment);
        const { alias, env } = resolveEnvironment(environments, args.environment, inline);
        const target: EnvTarget = envTargetFor(env, alias);
        const locale = resolveLocale({ tool: args.locale, config: defaultLocale, env: envVars.SF_DEFAULT_LOCALE });

        if (args.entitySet !== undefined) {
          // employeeLinkedOnly only filters the listing; rejecting it here avoids
          // silently ignoring an explicitly provided option.
          if (args.employeeLinkedOnly === true) {
            throw new SanitizedError(
              "OPTION_INVALID",
              "employeeLinkedOnly only applies to the entity listing; omit entitySet or drop the option",
            );
          }
          const details = await metadataService.getCustomMdfDetails(target, alias, args.entitySet, entityAllowlist, locale);
          if (details === undefined) {
            throw new SanitizedError("RESOURCE_NOT_FOUND", "the entity set is not a Custom MDF object of this environment");
          }
          const structured = details as unknown as Record<string, unknown>;
          return { structured, text: JSON.stringify(structured) };
        }

        const entities = await metadataService.listCustomMdf(target, alias, entityAllowlist, args.employeeLinkedOnly === true);
        const structured: Record<string, unknown> = {
          environment: alias,
          locale,
          totalCount: entities.length,
          employeeLinkedCount: entities.filter((entity) => isEmployeeLinkedType(entity.linkType)).length,
          entities,
        };
        return { structured, text: JSON.stringify(structured), recordCount: entities.length };
      }),
  );

  server.registerTool(
    "query_entity",
    {
      title: "Query OData v2 entity data",
      description: QUERY_ENTITY_DESCRIPTION,
      inputSchema: queryEntitySchema,
    },
    async (args) =>
      await executeTool("query_entity", args.environment, async () => {
        const { environments, entityAllowlist, inline } = await loadFreshConfig(args.environment);
        const { alias, env } = resolveEnvironment(environments, args.environment, inline);

        const output = args.output ?? "json";

        // Cursor and skip are mutually exclusive: continuation is exclusively
        // cursor-based (D-27).
        if (args.cursor !== undefined && args.skip !== undefined) {
          throw new SanitizedError(
            "OPTION_INVALID",
            "skip cannot be combined with cursor; pass the cursor alone to continue",
          );
        }

        // Validate shape and bounds BEFORE any dispatch.
        const validatedPath = validateEntityPath(args.entityPath);

        // Allowlist enforcement (FR-28/D-30): checked after path validation
        // but BEFORE any network call or metadata classification. Only the
        // FIRST segment's entity set is checked; navigation segments after
        // an allowed first segment are not re-checked. v2 is the only active
        // protocol in this phase, so entries restricted to ["v4"] are denied
        // (DS-P2-03). Generic message: the path is never echoed.
        if (!isEntityAllowed(entityAllowlist, validatedPath.firstSegmentName)) {
          throw new SanitizedError(
            "ENTITY_NOT_ALLOWED",
            "the entity is not permitted by the configured entityAllowlist",
          );
        }

        // Cursor verification is pre-dispatch by construction: signature plus
        // binding against the CURRENT call (same env, path, canonical options).
        const bindingOptions = cursorBindingOptions(args);
        let skiptoken: string | undefined;
        if (args.cursor !== undefined) {
          const payload = defaultCursorCodec.decode(args.cursor, {
            env: alias,
            path: args.entityPath,
            options: bindingOptions,
          });
          skiptoken = payload.skiptoken;
        }

        const { pathAndQuery, topClamped } = buildQuery(args.entityPath, {
          filter: args.filter,
          orderby: args.orderby,
          select: args.select,
          expand: args.expand,
          top: args.top,
          skip: args.skip,
          inlinecount: args.inlinecount,
          skiptoken,
        });

        const target: EnvTarget = envTargetFor(env, alias);
        const verdict = await metadataService.classifyFirstSegment(target, alias, validatedPath.firstSegmentName);
        if (verdict.kind === "function-import") {
          throw new SanitizedError(
            "FUNCTION_IMPORT_UNSUPPORTED",
            "custom service operations / function imports are not supported in the MVP",
          );
        }
        if (verdict.kind === "unknown") {
          throw new SanitizedError("PATH_INVALID", "unknown entity set");
        }

        // Exactly one fetch per call; next links are never followed.
        const result = await dispatchGet(target, pathAndQuery, {
          // Entity data in XML is Atom: SF answers 406 to `application/xml` there
          // (that media type is only valid for $metadata).
          accept: output === "xml" ? "application/atom+xml" : "application/json",
          timeoutMs: QUERY_TOOL_TIMEOUT_MS,
          fetchImpl,
          now: deps.now,
        });

        if (output === "xml") {
          // Raw service body, native fields, no normalization (D-32). XML
          // cannot be truncated safely, so the ceiling is a hard rejection.
          const paging = extractXmlPaging(result.body);
          if (paging.entryCount > RECORD_CEILING) {
            throw new SanitizedError("RESPONSE_INVALID", `xml response exceeds the ${RECORD_CEILING}-record ceiling`);
          }
          const structured: Record<string, unknown> = {
            environment: alias,
            path: args.entityPath,
            contentType: "xml",
            hasMore: paging.hasMore,
          };
          if (paging.totalCount !== null) {
            structured.totalCount = paging.totalCount;
          }
          if (paging.hasMore && paging.nextUrl !== null) {
            const cursor = encodeContinuationCursor(alias, args.entityPath, bindingOptions, paging.nextUrl);
            if (cursor !== undefined) {
              structured.cursor = cursor;
            }
          }
          // DS-P2-06: raw body minus the next-link href. Paging/cursor were
          // derived from the ORIGINAL href above; the returned text must never
          // expose the service URL or the raw $skiptoken.
          const xmlText = sanitizeXmlNextLinks(result.body);
          if (exceedsResponseCap(xmlText)) {
            throw responseTooLargeError(xmlText);
          }
          return { structured, text: xmlText };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(result.body);
        } catch {
          throw new SanitizedError("RESPONSE_INVALID", "the service response is not valid JSON");
        }
        const unwrapped = unwrapODataV2(parsed);

        const structured: Record<string, unknown> = {
          environment: alias,
          path: args.entityPath,
          recordCount: unwrapped.records.length,
          records: unwrapped.records,
          hasMore: unwrapped.hasMore,
        };
        if (topClamped) {
          structured.topClamped = true;
        }
        if (unwrapped.truncatedToCeiling) {
          structured.truncatedToCeiling = true;
        }
        if (unwrapped.totalCount !== null) {
          structured.totalCount = unwrapped.totalCount;
        }
        if (unwrapped.hasMore && unwrapped.nextUrl !== null) {
          // Cursor only when a real $skiptoken exists; the __next URL itself
          // never leaves the process.
          const cursor = encodeContinuationCursor(alias, args.entityPath, bindingOptions, unwrapped.nextUrl);
          if (cursor !== undefined) {
            structured.cursor = cursor;
          }
        }
        const text = JSON.stringify(structured);
        // Size guard (D-75): only what is returned to the model is measured.
        if (exceedsResponseCap(text)) {
          throw responseTooLargeError(text);
        }
        return {
          structured,
          text,
          recordCount: unwrapped.records.length,
        };
      }),
  );

  server.registerTool(
    "batch_get",
    {
      title: "Batch multiple OData v2 GETs (read-only $batch)",
      description: BATCH_GET_DESCRIPTION,
      inputSchema: batchGetSchema,
    },
    async (args) =>
      await executeTool("batch_get", args.environment, async () => {
        const { environments, entityAllowlist, inline } = await loadFreshConfig(args.environment);
        const { alias, env } = resolveEnvironment(environments, args.environment, inline);

        const output = args.output ?? "json";
        const target: EnvTarget = envTargetFor(env, alias);

        // Pass 1 — pure preflight for EVERY item (no network at all):
        // path grammar, allowlist, cursor+skip exclusivity, cursor binding
        // decode and option bounds/query build (FR-29).
        interface PlannedItem {
          entityPath: string;
          firstSegmentName: string;
          pathAndQuery: string;
          bindingOptions: Record<string, unknown>;
          topClamped: boolean;
        }
        const planned: PlannedItem[] = [];
        for (const item of args.requests) {
          if (item.cursor !== undefined && item.skip !== undefined) {
            throw new SanitizedError(
              "OPTION_INVALID",
              "skip cannot be combined with cursor; pass the cursor alone to continue",
            );
          }
          const validatedPath = validateEntityPath(item.entityPath);
          if (!isEntityAllowed(entityAllowlist, validatedPath.firstSegmentName)) {
            throw new SanitizedError(
              "ENTITY_NOT_ALLOWED",
              "the entity is not permitted by the configured entityAllowlist",
            );
          }
          const bindingOptions = cursorBindingOptions({ ...item, output });
          let skiptoken: string | undefined;
          if (item.cursor !== undefined) {
            const payload = defaultCursorCodec.decode(item.cursor, {
              env: alias,
              path: item.entityPath,
              options: bindingOptions,
            });
            skiptoken = payload.skiptoken;
          }
          const { pathAndQuery, topClamped } = buildQuery(item.entityPath, {
            filter: item.filter,
            orderby: item.orderby,
            select: item.select,
            expand: item.expand,
            top: item.top,
            skip: item.skip,
            inlinecount: item.inlinecount,
            skiptoken,
          });
          planned.push({
            entityPath: item.entityPath,
            firstSegmentName: validatedPath.firstSegmentName,
            pathAndQuery,
            bindingOptions,
            topClamped,
          });
        }

        // Pass 2 — metadata classification (the only allowed pre-batch GET):
        // function imports and unknown entity sets reject the whole batch.
        // Deduplicated; cached by the metadata service's TTL cache.
        const classified = new Set<string>();
        for (const item of planned) {
          if (classified.has(item.firstSegmentName)) {
            continue;
          }
          classified.add(item.firstSegmentName);
          const verdict = await metadataService.classifyFirstSegment(target, alias, item.firstSegmentName);
          if (verdict.kind === "function-import") {
            throw new SanitizedError(
              "FUNCTION_IMPORT_UNSUPPORTED",
              "custom service operations / function imports are not supported in the MVP",
            );
          }
          if (verdict.kind === "unknown") {
            throw new SanitizedError("PATH_INVALID", "unknown entity set");
          }
        }

        // One fixed $batch POST, GET-only envelope (D-28/DS-P2-04).
        const responses = await executeBatchGet({
          env: target,
          output,
          timeoutMs: BATCH_TOOL_TIMEOUT_MS,
          requests: planned.map((item) => ({ url: item.pathAndQuery })),
          fetchImpl,
          now: deps.now,
        });

        // Per-item results in input order (FR-30). Embedded non-2xx parts
        // become sanitized per-item errors; raw error bodies never leave.
        const results: Array<Record<string, unknown>> = [];
        let recordsReturned = 0;
        // Per-request size guard (D-75/FR-86): each inner response is measured on
        // its own, never the batch as a whole. What is measured is the serialized
        // per-item result, which is what actually reaches the model (an XML body
        // is JSON-escaped inside the batch payload). An oversized part becomes a
        // sanitized per-item failure and stops counting toward the aggregate ceiling.
        const pushGuarded = (entry: Record<string, unknown>, index: number, path: string): void => {
          const measured = JSON.stringify(entry);
          if (entry.success === true && exceedsResponseCap(measured)) {
            const error = responseTooLargeError(measured);
            recordsReturned -= typeof entry.recordCount === "number" ? entry.recordCount : 0;
            results.push({
              index,
              path,
              success: false,
              httpStatus: entry.httpStatus,
              error: { code: error.code, message: error.message },
            });
            return;
          }
          results.push(entry);
        };
        for (const [index, response] of responses.entries()) {
          const item = planned[index]!;
          const entry: Record<string, unknown> = { index, path: item.entityPath };
          const httpStatus = Number(response.code);
          const ok = response.success && Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus <= 299;

          if (!ok) {
            entry.success = false;
            if (Number.isInteger(httpStatus)) {
              entry.httpStatus = httpStatus;
            }
            entry.error = sanitizeEmbeddedFailure(response.data, Number.isInteger(httpStatus) ? httpStatus : undefined);
            results.push(entry);
            continue;
          }

          entry.success = true;
          entry.httpStatus = httpStatus;

          if (output === "xml") {
            if (typeof response.data !== "string") {
              entry.success = false;
              entry.error = {
                code: "RESPONSE_INVALID",
                message: "the service response body is not readable",
              };
              results.push(entry);
              continue;
            }
            const paging = extractXmlPaging(response.data);
            recordsReturned += paging.entryCount;
            // XML cannot be truncated safely: an aggregate above the ceiling
            // rejects the whole response sanitized (DS-P2-01).
            if (recordsReturned > RECORD_CEILING) {
              throw new SanitizedError(
                "RESPONSE_INVALID",
                `batch xml response exceeds the ${RECORD_CEILING}-record ceiling`,
              );
            }
            entry.contentType = "xml";
            entry.recordCount = paging.entryCount;
            // DS-P2-06: raw body minus the next-link href. The per-item
            // paging/cursor above were derived from the ORIGINAL body.
            entry.body = sanitizeXmlNextLinks(response.data);
            entry.hasMore = paging.hasMore;
            if (paging.totalCount !== null) {
              entry.totalCount = paging.totalCount;
            }
            if (paging.hasMore && paging.nextUrl !== null) {
              const cursor = encodeContinuationCursor(alias, item.entityPath, item.bindingOptions, paging.nextUrl);
              if (cursor !== undefined) {
                entry.cursor = cursor;
              }
            }
            pushGuarded(entry, index, item.entityPath);
            continue;
          }

          let unwrapped;
          try {
            unwrapped = unwrapODataV2(response.data);
          } catch {
            entry.success = false;
            entry.error = {
              code: "RESPONSE_INVALID",
              message: "the service response is not an OData v2 JSON document",
            };
            results.push(entry);
            continue;
          }
          let records = unwrapped.records;
          let truncatedToCeiling = unwrapped.truncatedToCeiling;
          const remaining = RECORD_CEILING - recordsReturned;
          if (records.length > remaining) {
            records = records.slice(0, Math.max(remaining, 0));
            truncatedToCeiling = true;
          }
          recordsReturned += records.length;
          entry.recordCount = records.length;
          entry.records = records;
          entry.hasMore = unwrapped.hasMore;
          if (item.topClamped) {
            entry.topClamped = true;
          }
          if (truncatedToCeiling) {
            entry.truncatedToCeiling = true;
          }
          if (unwrapped.totalCount !== null) {
            entry.totalCount = unwrapped.totalCount;
          }
          if (unwrapped.hasMore && unwrapped.nextUrl !== null) {
            const cursor = encodeContinuationCursor(alias, item.entityPath, item.bindingOptions, unwrapped.nextUrl);
            if (cursor !== undefined) {
              entry.cursor = cursor;
            }
          }
          pushGuarded(entry, index, item.entityPath);
        }

        const structured: Record<string, unknown> = {
          environment: alias,
          output,
          results,
        };
        return {
          structured,
          text: JSON.stringify(structured),
          recordCount: recordsReturned,
        };
      }),
  );

  // --- MCP Resources (FR-36..FR-40, D-33..D-35, D-40) -----------------------

  server.resource(
    "sf_overview",
    new ResourceTemplate("sf://{environment}/overview", {
      list: async () => {
        let conf;
        try {
          conf = await loadFreshConfig(null);
        } catch {
          return { resources: [] };
        }
        return {
          resources: Object.keys(conf.environments).map((alias) => ({
            uri: `sf://${alias}/overview`,
            name: `${alias}_overview`,
            mimeType: "application/json",
            description: `Environment overview for alias "${alias}"`,
          })),
        };
      },
    }),
    async (uri, { environment }) => {
      const { environments, entityAllowlist, inline } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      const target = envTargetFor(resolved.env);
      const parsed = await metadataService.getParsedMetadata(target, resolved.alias);

      const overview = {
        environment: resolved.alias,
        baseUrl: resolved.env.baseUrl,
        authType: resolved.env.auth.type,
        totalEntitySets: parsed.entitySets.length,
        functionImportsCount: parsed.functionImports.length,
        allowlistConfigured: entityAllowlist !== undefined,
        allowlistDeniedAll: entityAllowlist !== undefined && entityAllowlist.length === 0,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(overview, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "sf_entities",
    new ResourceTemplate("sf://{environment}/entities", {
      list: async () => {
        let conf;
        try {
          conf = await loadFreshConfig(null);
        } catch {
          return { resources: [] };
        }
        return {
          resources: Object.keys(conf.environments).map((alias) => ({
            uri: `sf://${alias}/entities`,
            name: `${alias}_entities`,
            mimeType: "application/json",
            description: `Entity catalog for alias "${alias}"`,
          })),
        };
      },
    }),
    async (uri, { environment }) => {
      const { environments, entityAllowlist, inline } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      const target = envTargetFor(resolved.env);
      const parsed = await metadataService.getParsedMetadata(target, resolved.alias);

      let allowedSets = parsed.entitySets;
      if (entityAllowlist !== undefined) {
        allowedSets = allowedSets.filter((name) => isEntityAllowed(entityAllowlist, name));
      }

      const entityList = allowedSets.map((name) => {
        const schema = parsed.entitySchemas[name];
        const isCustom = isCustomMdfEntity(name);
        return {
          name,
          entityType: schema?.entityType ?? name,
          isCustom,
          isEmployeeLinked:
            isCustom && schema !== undefined
              ? isEmployeeLinkedType(classifyEmployeeLink(schema, parsed.entitySchemas).type)
              : false,
          isEffectiveDated: schema !== undefined && effectiveDateKey(schema) !== undefined,
          keyProperties: schema?.keys ?? [],
        };
      });

      const catalog = {
        environment: resolved.alias,
        totalCount: entityList.length,
        entities: entityList,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(catalog, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "sf_entity_schema",
    new ResourceTemplate("sf://{environment}/entities/{entitySet}", { list: undefined }),
    async (uri, { environment, entitySet }) => {
      const { environments, entityAllowlist, defaultLocale, inline } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      const entityName = entitySet as string;

      if (entityAllowlist !== undefined && !isEntityAllowed(entityAllowlist, entityName)) {
        throw new SanitizedError(
          "ENTITY_NOT_ALLOWED",
          `ENTITY_NOT_ALLOWED: entity "${entityName}" is not permitted by the configured allowlist`,
        );
      }

      const target = envTargetFor(resolved.env);
      const schema = await metadataService.getEntitySchema(target, resolved.alias, entityName);
      if (!schema) {
        throw new SanitizedError(
          "RESOURCE_NOT_FOUND",
          `RESOURCE_NOT_FOUND: entity "${entityName}" not found in metadata for environment "${resolved.alias}"`,
        );
      }

      // Custom MDF entities get additive MDF fields (FR-72); every other entity
      // keeps the plain schema contract. Resources take no parameters, so the
      // locale uses levels 2-4 only (D-70).
      const payload = isCustomMdfEntity(entityName)
        ? ((await metadataService.getCustomMdfDetails(
            target,
            resolved.alias,
            entityName,
            entityAllowlist,
            resolveLocale({ config: defaultLocale, env: envVars.SF_DEFAULT_LOCALE }),
          )) ?? schema)
        : schema;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "sf_mdf_custom",
    new ResourceTemplate("sf://{environment}/mdf/custom", {
      list: async () => {
        let conf;
        try {
          conf = await loadFreshConfig(null);
        } catch {
          return { resources: [] };
        }
        return {
          resources: Object.keys(conf.environments).map((alias) => ({
            uri: `sf://${alias}/mdf/custom`,
            name: `${alias}_mdf_custom`,
            mimeType: "application/json",
            description: `Custom MDF catalog for alias "${alias}"`,
          })),
        };
      },
    }),
    async (uri, { environment }) => {
      const { environments, entityAllowlist, inline } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      const target = envTargetFor(resolved.env);
      // Zero-network (D-62): classified from the cached $metadata; allowlist-filtered (D-68).
      const entities = await metadataService.listCustomMdf(target, resolved.alias, entityAllowlist);
      const body = {
        environment: resolved.alias,
        totalCount: entities.length,
        employeeLinkedCount: entities.filter((entity) => isEmployeeLinkedType(entity.linkType)).length,
        entities,
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }],
      };
    },
  );

  return server;
}
