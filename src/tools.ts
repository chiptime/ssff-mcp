/**
 * MCP tool registrations: list_environments, get_metadata, query_entity.
 *
 * Contract enforced here:
 * - Explicit environment per request, fail-closed (ENVIRONMENT_REQUIRED /
 *   ENVIRONMENT_UNKNOWN; never an implicit pick, never a retry elsewhere).
 * - Configuration is re-read and re-validated on EVERY tool call.
 * - Only GET is ever dispatched; entity paths are validated against the
 *   tenant metadata before dispatch (function imports rejected).
 * - Errors are returned as sanitized `{ code, message }` isError results.
 * - Every call produces one stderr JSON log line with metadata only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isEntityAllowed, type AllowlistEntry } from "./allowlist.js";
import { loadConfig, type EnvironmentConfig } from "./config.js";
import { CURSOR_VERSION, defaultCursorCodec } from "./cursor.js";
import { SanitizedError, toSanitizedError } from "./errors.js";
import { dispatchGet, envTargetFor, type EnvTarget, type FetchImpl } from "./http.js";
import { makeLogger, type LogSink, type Logger } from "./logger.js";
import { MetadataService } from "./metadata.js";
import {
  buildQuery,
  extractSkiptoken,
  extractXmlPaging,
  RECORD_CEILING,
  unwrapODataV2,
  validateEntityPath,
} from "./odata.js";

const METADATA_TOOL_TIMEOUT_MS = 60_000;
const QUERY_TOOL_TIMEOUT_MS = 30_000;

export const GET_METADATA_DESCRIPTION = [
  "Retrieves the raw OData v2 $metadata XML document for the selected environment.",
  "WARNING: the full metadata document can be very large (thousands of entity types);",
  "prefer query_entity for targeted data and use this tool only when the schema itself is needed.",
].join(" ");

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

const environmentArg = z.string().optional();

const getMetadataSchema = z
  .object({
    environment: environmentArg,
  })
  .strict();

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
}

interface ToolOutcome {
  structured: Record<string, unknown>;
  text: string;
  recordCount?: number;
}

function resolveEnvironment(
  environments: Record<string, EnvironmentConfig>,
  requested: string | undefined,
): { alias: string; env: EnvironmentConfig } {
  if (typeof requested !== "string" || requested.trim().length === 0) {
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

/**
 * Canonical option subset the cursor binding covers (D-27): the options that
 * shape the query result. Deliberately excludes `skip` and `cursor` itself.
 * Only explicitly provided keys are included; callers must repeat the same
 * arguments for a cursor to validate.
 */
function cursorBindingOptions(args: QueryEntityArgs): Record<string, unknown> {
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
    { instructions: "Read-only MCP server for SAP SuccessFactors OData v2. Every request must name its environment explicitly." },
  );
  const log: Logger = makeLogger(deps.logSink);
  const metadataService = new MetadataService({ fetchImpl: deps.fetchImpl, now: deps.now });
  const fetchImpl = deps.fetchImpl;

  /** Freshly loaded config per tool call: environments + optional allowlist. */
  interface FreshConfig {
    environments: Record<string, EnvironmentConfig>;
    entityAllowlist?: AllowlistEntry[];
  }

  async function loadFreshConfig(): Promise<FreshConfig> {
    const config = await loadConfig({ configPath: deps.configPath, onWarning: deps.onConfigWarning });
    if (config.entityAllowlist === undefined) {
      return { environments: config.environments };
    }
    return { environments: config.environments, entityAllowlist: config.entityAllowlist };
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
        const { environments } = await loadFreshConfig();
        const list = Object.keys(environments)
          .sort()
          .map((alias) => ({ alias, authType: environments[alias]!.auth.type }));
        const structured = { environments: list };
        return { structured, text: JSON.stringify(structured, null, 2) };
      }),
  );

  server.registerTool(
    "get_metadata",
    {
      title: "Get OData v2 $metadata",
      description: GET_METADATA_DESCRIPTION,
      inputSchema: getMetadataSchema,
    },
    async (args) =>
      await executeTool("get_metadata", args.environment, async () => {
        const { environments } = await loadFreshConfig();
        const { alias, env } = resolveEnvironment(environments, args.environment);
        // Always fresh from the source; the metadata cache is never used here.
        const result = await dispatchGet(envTargetFor(env, alias), "$metadata", {
          accept: "application/xml",
          timeoutMs: METADATA_TOOL_TIMEOUT_MS,
          fetchImpl,
          now: deps.now,
        });
        return {
          structured: { environment: alias, contentType: "xml" },
          text: result.body,
        };
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
        const { environments, entityAllowlist } = await loadFreshConfig();
        const { alias, env } = resolveEnvironment(environments, args.environment);

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
          return { structured, text: result.body };
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
        return {
          structured,
          text: JSON.stringify(structured),
          recordCount: unwrapped.records.length,
        };
      }),
  );

  return server;
}
