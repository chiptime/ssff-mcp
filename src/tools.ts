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
import { loadConfig, type EnvironmentConfig } from "./config.js";
import { SanitizedError, toSanitizedError } from "./errors.js";
import { dispatchGet, envTargetFor, type EnvTarget, type FetchImpl } from "./http.js";
import { makeLogger, type LogSink, type Logger } from "./logger.js";
import { MetadataService } from "./metadata.js";
import { buildQuery, unwrapODataV2, validateEntityPath } from "./odata.js";

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
  "filter -> $filter, orderby -> $orderby, select -> $select, expand -> $expand, top -> $top, skip -> $skip.",
  "Ceiling: at most 1000 records and exactly one OData page are returned per call;",
  "next links are never followed automatically (hasMore indicates a next page exists).",
  "Continuation in this MVP means re-issuing an explicit call with skip;",
  "note SAP cautions that client-side $top/$skip paging can lose or duplicate records at volume",
  "(cursor-based continuation is planned for Phase 2).",
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

export function createMcpServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer(
    { name: "ssff-mcp", version: "0.1.0" },
    { instructions: "Read-only MCP server for SAP SuccessFactors OData v2. Every request must name its environment explicitly." },
  );
  const log: Logger = makeLogger(deps.logSink);
  const metadataService = new MetadataService({ fetchImpl: deps.fetchImpl, now: deps.now });
  const fetchImpl = deps.fetchImpl;

  async function loadFreshConfig(): Promise<Record<string, EnvironmentConfig>> {
    const config = await loadConfig({ configPath: deps.configPath, onWarning: deps.onConfigWarning });
    return config.environments;
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
        const environments = await loadFreshConfig();
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
        const environments = await loadFreshConfig();
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
        const environments = await loadFreshConfig();
        const { alias, env } = resolveEnvironment(environments, args.environment);

        // Validate shape and bounds BEFORE any dispatch.
        const validatedPath = validateEntityPath(args.entityPath);
        const { pathAndQuery, topClamped } = buildQuery(args.entityPath, {
          filter: args.filter,
          orderby: args.orderby,
          select: args.select,
          expand: args.expand,
          top: args.top,
          skip: args.skip,
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

        const result = await dispatchGet(target, pathAndQuery, {
          accept: "application/json",
          timeoutMs: QUERY_TOOL_TIMEOUT_MS,
          fetchImpl,
          now: deps.now,
        });

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
        return {
          structured,
          text: JSON.stringify(structured),
          recordCount: unwrapped.records.length,
        };
      }),
  );

  return server;
}
