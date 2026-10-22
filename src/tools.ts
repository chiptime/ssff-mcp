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
import { executeBatchGet, sanitizeEmbeddedFailure } from "./batch.js";
import { isEntityPermitted, permittedFieldsFor } from "./allowlist.js";
import {
  checkExpandRoutes,
  checkExpandSelections,
  checkExpressionReferences,
  checkNavigationPath,
  entitySetOfSegment,
  expressionReferences,
  hasEncodedStructure,
  type ExpressionReference,
  type NavigationLookup,
} from "./allowlist-navigation.js";
import { parseExpand } from "./expand.js";
import {
  allowedProperties,
  assertPropertyPermitted,
  FieldNotPermittedError,
  filterSchemaProperties,
  redactValue,
  type SchemaLookup,
} from "./fields.js";
import { PACKAGE_VERSION } from "./version.js";
import { loadConfig, type EnvironmentConfig } from "./config.js";
import { CURSOR_VERSION, defaultCursorCodec } from "./cursor.js";
import { SanitizedError, toSanitizedError } from "./errors.js";
import { dispatchGet, envTargetFor, type EnvTarget, type FetchImpl } from "./http.js";
import { resolveLocale } from "./i18n.js";
import { makeLogger, type LogSink, type Logger } from "./logger.js";
import { isCustomMdfEntity, isEmployeeLinkedType } from "./mdf.js";
import { MetadataService, type EntitySchema } from "./metadata.js";
import { PicklistService, resolvePicklistLocale, planPicklistExpansion, type PicklistExpansionPlan } from "./picklists.js";
import { exceedsResponseCap, responseTooLargeError, resolveMaxResponseBytes } from "./size-guard.js";
import {
  buildQuery,
  extractSkiptoken,
  extractXmlPaging,
  RECORD_CEILING,
  sanitizeXmlNextLinks,
  unwrapODataV2,
  validateEntityPath,
} from "./odata.js";
import {
  TOOL_CATALOG,
  batchGetSchema,
  inspectEntitySchema,
  listEnvironmentsSchema,
  queryEntitySchema,
  resolvePicklistSchema,
} from "./tool-catalog.js";

const QUERY_TOOL_TIMEOUT_MS = 30_000;
const BATCH_TOOL_TIMEOUT_MS = 120_000;

/** Look up a tool's name/title/description from the single-source catalog. */
function toolEntry(name: string): { name: string; title: string; description: string } {
  const entry = TOOL_CATALOG.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`tool not present in the catalog: ${name}`);
  }
  return { name: entry.name, title: entry.title, description: entry.description };
}
// Tool definitions live in ./tool-catalog.ts (single source for registration and
// for the generated docs/tools.md). The input schemas keep their concrete types
// so the handlers stay fully typed.

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
  /** Optional injectable picklist service (tests/prod). */
  picklistService?: PicklistService;
  /** Environment variables read for SF_DEFAULT_LOCALE (defaults to process.env; tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * Tenant the edge resolved (hosted mode, D-118): pins `loadConfig` to that
   * tenant's slice. Undefined => the stdio rule (exactly one tenant).
   */
  tenantId?: string;
  /**
   * Environment scope granted by the presented key (hosted mode, D-120/FR-160).
   * The engine stays tenant-agnostic: it only enforces this optional alias
   * scope, fail-closed, before any network request.
   */
  allowedEnvironments?: string[];
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
  fromDate?: string;
  toDate?: string;
  asOfDate?: string;
  top?: number;
  skip?: number;
  cursor?: string;
  inlinecount?: "allpages";
  output?: "json" | "xml";
}

/** Option fields the cursor binding covers (shared by query_entity and batch_get items). */
type CursorOptionsSource = Pick<
  QueryEntityArgs,
  | "filter"
  | "orderby"
  | "select"
  | "expand"
  | "fromDate"
  | "toDate"
  | "asOfDate"
  | "top"
  | "inlinecount"
  | "output"
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
  // The effective-dating window shapes the result, so the cursor binds it too.
  if (args.fromDate !== undefined) {
    options.fromDate = args.fromDate;
  }
  if (args.toDate !== undefined) {
    options.toDate = args.toDate;
  }
  if (args.asOfDate !== undefined) {
    options.asOfDate = args.asOfDate;
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
  tenantId?: string,
): string | undefined {
  const skiptoken = extractSkiptoken(nextUrl);
  if (skiptoken === null) {
    return undefined;
  }
  return defaultCursorCodec.encode({ v: CURSOR_VERSION, env, path: entityPath, options, skiptoken,
    ...(tenantId === undefined || tenantId === "default" ? {} : { tenantId }) });
}

export function createMcpServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer(
    { name: "ssff-mcp", version: PACKAGE_VERSION },
    { instructions: "Read-only MCP server for SAP SuccessFactors OData v2. Name the environment explicitly; in inline mode (a single configured environment) it may be omitted." },
  );
  const log: Logger = makeLogger(deps.logSink);
  const fetchImpl = deps.fetchImpl;
  const envVars = deps.env ?? process.env;
  const metadataServices = new Map<string, MetadataService>();
  /**
   * One MetadataService per tenant (D-121/FR-161): disk cache and in-memory
   * entries are namespaced by tenant and never shared. stdio resolves exactly
   * one tenant per process; the hosted mode will own its own instances.
   */
  function metadataServiceFor(tenantId: string | undefined): MetadataService {
    const key = tenantId ?? "default";
    let service = metadataServices.get(key);
    if (service === undefined) {
      service = new MetadataService({
        fetchImpl: deps.fetchImpl,
        now: deps.now,
        cacheDir: deps.cacheDir,
        disableDiskCache: deps.disableDiskCache,
        tenantId: key,
      });
      metadataServices.set(key, service);
    }
    return service;
  }

  const picklistServices = new Map<string, PicklistService>();
  function picklistServiceFor(tenantId: string | undefined): PicklistService {
    if (deps.picklistService !== undefined) {
      return deps.picklistService;
    }
    const key = tenantId ?? "default";
    let service = picklistServices.get(key);
    if (service === undefined) {
      service = new PicklistService({
        fetchImpl: deps.fetchImpl,
        now: deps.now,
        cacheDir: deps.cacheDir,
        disableDiskCache: deps.disableDiskCache,
        tenantId: key,
      });
      picklistServices.set(key, service);
    }
    return service;
  }

  /** Freshly loaded config per tool call: environments (each with its own allowlist) + inline flag. */
  interface FreshConfig {
    environments: Record<string, EnvironmentConfig>;
    defaultLocale?: string;
    inline?: boolean;
    /** Tenant the config resolved from; namespaces the metadata cache (D-121). */
    tenantId?: string;
    capBytes: number;
  }

  async function loadFreshConfig(resolveSecretsFor?: string | null): Promise<FreshConfig> {
    // FR-160 (fail-closed, before any network request): in the hosted mode the
    // presented key grants an explicit environment scope; an alias outside it
    // is rejected even though the tenant configures it. The parameter doubles
    // as the requested alias (tools and resources pass it through).
    if (
      deps.allowedEnvironments !== undefined &&
      typeof resolveSecretsFor === "string" &&
      resolveSecretsFor.length > 0 &&
      !deps.allowedEnvironments.includes(resolveSecretsFor)
    ) {
      throw new SanitizedError(
        "ENVIRONMENT_NOT_ALLOWED",
        `environment "${resolveSecretsFor}" is not permitted for this key; permitted: ${deps.allowedEnvironments.join(", ") || "(none)"}`,
      );
    }
    const config = await loadConfig({
      configPath: deps.configPath,
      onWarning: deps.onConfigWarning,
      resolveSecretsFor,
      tenantId: deps.tenantId,
    });
    // A mounted file may change while other sessions are in flight. Keep the
    // response cap request-local rather than mutating module-global state.
    const environments = deps.allowedEnvironments === undefined ? config.environments :
      Object.fromEntries(Object.entries(config.environments)
        .filter(([alias]) => deps.allowedEnvironments!.includes(alias)));
    return {
      environments,
      defaultLocale: config.defaultLocale,
      inline: config.inline,
      tenantId: config.tenantId,
      capBytes: resolveMaxResponseBytes(config.maxResponseBytes),
    };
  }

  /** Resolve a NavigationProperty to the entity set it points at, from cached metadata. */
  const navigationLookupFor =
    (target: EnvTarget, alias: string, tenantId: string | undefined): NavigationLookup =>
    async (fromEntitySet, navigationName) => {
      const schema = await metadataServiceFor(tenantId).getEntitySchema(target, alias, fromEntitySet);
      return schema?.navigationProperties.find((p) => p.name === navigationName)?.targetEntitySet;
    };

  /** Schema lookup bound to an environment, for the field policy. */
  const schemaLookupFor =
    (target: EnvTarget, alias: string, tenantId: string | undefined): SchemaLookup =>
    (entitySet) => metadataServiceFor(tenantId).getEntitySchema(target, alias, entitySet);

  /** Map a FieldNotPermittedError to the sanitized ENTITY_NOT_ALLOWED payload. */
  function toEntityNotAllowed(cause: unknown): SanitizedError {
    if (cause instanceof FieldNotPermittedError) {
      return new SanitizedError("ENTITY_NOT_ALLOWED", cause.message);
    }
    throw cause;
  }

  /**
   * Field-level granularity: every property named by an option must be permitted
   * (`fields` on the allowlist entry) for the entity it belongs to. A path's
   * final segment belongs to the entity the path reaches; a bare name belongs to
   * the base. Navigation properties are skipped: the navigation policy owns them.
   */
  async function enforceFieldPermissions(
    target: EnvTarget,
    alias: string,
    tenantId: string | undefined,
    allowlist: NonNullable<EnvironmentConfig["entityAllowlist"]>,
    baseEntitySet: string,
    references: readonly ExpressionReference[],
    optionName: string,
  ): Promise<void> {
    const lookup = navigationLookupFor(target, alias, tenantId);
    const schemaLookup = schemaLookupFor(target, alias, tenantId);
    for (const reference of references) {
      if (reference.kind === "name") {
        await assertPropertyPermitted(
          allowlist,
          baseEntitySet,
          reference.name,
          schemaLookup,
          optionName,
        );
        continue;
      }
      const owner = await walkToEntity(lookup, baseEntitySet, reference.segments.slice(0, -1));
      if (owner === undefined) {
        continue; // the navigation policy reports unresolvable hops
      }
      await assertPropertyPermitted(
        allowlist,
        owner,
        reference.segments[reference.segments.length - 1]!,
        schemaLookup,
        optionName,
      );
    }
  }

  /** Walk navigations from `base`; undefined when a hop cannot be resolved. */
  async function walkToEntity(
    lookup: NavigationLookup,
    base: string,
    navigations: readonly string[],
  ): Promise<string | undefined> {
    let current = base;
    for (const navigation of navigations) {
      const next = await lookup(current, navigation);
      if (next === undefined) {
        return undefined;
      }
      current = next;
    }
    return current;
  }

  /** The entity set a validated path ends at (its records belong to it). */
  async function entityReachedByPath(
    target: EnvTarget,
    alias: string,
    tenantId: string | undefined,
    segments: readonly string[],
  ): Promise<string | undefined> {
    return await walkToEntity(
      navigationLookupFor(target, alias, tenantId),
      entitySetOfSegment(segments[0] ?? ""),
      segments.slice(1).map(entitySetOfSegment),
    );
  }

  /** True when the reached entity or any $expand destination carries `fields`. */
  async function fieldRestrictionApplies(
    target: EnvTarget,
    alias: string,
    tenantId: string | undefined,
    allowlist: NonNullable<EnvironmentConfig["entityAllowlist"]>,
    segments: readonly string[],
    expand: string | undefined,
  ): Promise<boolean> {
    const lookup = navigationLookupFor(target, alias, tenantId);
    const root = await entityReachedByPath(target, alias, tenantId, segments);
    if (root === undefined) {
      return false;
    }
    if (permittedFieldsFor(allowlist, root) !== undefined) {
      return true;
    }
    if (expand === undefined) {
      return false;
    }
    const parsed = parseExpand(expand);
    if (!parsed.ok) {
      return false; // rejected before dispatch anyway
    }
    for (const route of parsed.routes) {
      let current = root;
      // A slash route expands every intermediate entity too, not only its leaf.
      // Any restricted prefix must force JSON before raw Atom is requested.
      for (const navigation of route) {
        const reached = await lookup(current, navigation);
        if (reached === undefined) {
          return true; // fail closed; normal enforcement rejects this route
        }
        if (permittedFieldsFor(allowlist, reached) !== undefined) {
          return true;
        }
        current = reached;
      }
    }
    return false;
  }

  /** Redact a records payload against the entity the path reached. */
  async function redactRecords(
    target: EnvTarget,
    alias: string,
    tenantId: string | undefined,
    allowlist: NonNullable<EnvironmentConfig["entityAllowlist"]> | undefined,
    segments: readonly string[],
    records: unknown,
  ): Promise<unknown> {
    if (allowlist === undefined) {
      return records;
    }
    const root = await entityReachedByPath(target, alias, tenantId, segments);
    if (root === undefined) {
      return records;
    }
    try {
      return await redactValue(
        records,
        root,
        allowlist,
        schemaLookupFor(target, alias, tenantId),
        navigationLookupFor(target, alias, tenantId),
      );
    } catch (cause) {
      // A configured field list that cannot be enforced refuses the read rather
      // than returning the payload unredacted.
      throw toEntityNotAllowed(cause);
    }
  }

  /** Hide non-permitted properties from a schema payload (keys stay visible). */
  async function redactedSchema<P extends { properties: Array<{ name: string }> }>(
    target: EnvTarget,
    alias: string,
    tenantId: string | undefined,
    allowlist: NonNullable<EnvironmentConfig["entityAllowlist"]> | undefined,
    entitySet: string,
    schema: P,
  ): Promise<P> {
    if (allowlist === undefined) {
      return schema;
    }
    const allowed = await allowedProperties(allowlist, entitySet, schemaLookupFor(target, alias, tenantId));
    return filterSchemaProperties(schema, allowed);
  }

  /**
   * Enforce the navigation and `$expand` vectors (FR-141..FR-146): every hop is
   * resolved to its **target entity set** and checked against the lists, and
   * neither an unresolvable navigation nor an unparseable `$expand` is ever
   * dispatched.
   */
  async function enforceNavigationVectors(
    target: EnvTarget,
    alias: string,
    tenantId: string | undefined,
    env: EnvironmentConfig,
    segments: readonly string[],
    expand: string | undefined,
    filter: string | undefined,
    orderby: string | undefined,
    select: string | undefined,
  ): Promise<void> {
    const lookup = navigationLookupFor(target, alias, tenantId);
    const allowlist = env.entityAllowlist;
    const denylist = env.entityDenylist;

    const pathVerdict = await checkNavigationPath(segments, allowlist, denylist, lookup);
    if (pathVerdict.kind === "denied") {
      throw new SanitizedError(
        "ENTITY_NOT_ALLOWED",
        "a navigation in the entity path is not permitted by the configured entityAllowlist",
      );
    }
    if (pathVerdict.kind === "unresolvable") {
      throw new SanitizedError(
        "NAVIGATION_NOT_ALLOWED",
        "a navigation in the entity path could not be resolved from the cached metadata; if the catalog changed, run `ssff-mcp cache invalidate <alias>` and retry",
      );
    }

    if (expand !== undefined) {
      const parsed = parseExpand(expand);
      if (!parsed.ok) {
        throw new SanitizedError(
          "OPTION_INVALID",
          `expand uses syntax this server cannot verify (${parsed.reason}); it is rejected rather than dispatched unverified`,
        );
      }
      // `$expand` applies to the entity the PATH reached, not to the first segment:
      // resolving from the wrong base both rejects legitimate queries and lets a
      // denied destination through.
      const expandVerdict = await checkExpandRoutes(
        pathVerdict.reached,
        parsed.routes,
        allowlist,
        denylist,
        lookup,
      );
      if (expandVerdict.kind === "denied") {
        throw new SanitizedError(
          "ENTITY_NOT_ALLOWED",
          "an expanded navigation is not permitted by the configured entityAllowlist",
        );
      }
      if (expandVerdict.kind === "unresolvable") {
        throw new SanitizedError(
          "NAVIGATION_NOT_ALLOWED",
          "an expanded navigation could not be resolved from the cached metadata; if the catalog changed, run `ssff-mcp cache invalidate <alias>` and retry",
        );
      }
      // A `$select` inside `$expand` names properties of the expanded entity: one
      // of them may be an association to a denied entity, and it only takes a
      // deferred link to name what the lists exclude.
      const selectionVerdict = await checkExpandSelections(
        pathVerdict.reached,
        parsed.selections,
        allowlist,
        denylist,
        lookup,
      );
      if (selectionVerdict.kind === "denied") {
        throw new SanitizedError(
          "ENTITY_NOT_ALLOWED",
          "a $select inside $expand names an association that is not permitted by the configured entityAllowlist",
        );
      }
      if (selectionVerdict.kind === "unresolvable") {
        throw new SanitizedError(
          "NAVIGATION_NOT_ALLOWED",
          "a $select inside $expand could not be resolved from the cached metadata; if the catalog changed, run `ssff-mcp cache invalidate <alias>` and retry",
        );
      }
      // Field-level granularity inside $expand: each selected property must be
      // permitted for the entity its route reaches.
      const expandSchemaLookup = schemaLookupFor(target, alias, tenantId);
      for (const selection of parsed.selections) {
        const owner = await walkToEntity(lookup, pathVerdict.reached, selection.route);
        if (owner === undefined) {
          continue;
        }
        for (const property of selection.properties) {
          try {
            await assertPropertyPermitted(allowlist, owner, property, expandSchemaLookup, "a $select inside $expand");
          } catch (cause) {
            throw toEntityNotAllowed(cause);
          }
        }
      }
    }

    // A denied entity must be unreachable through ANY option, so filter, orderby
    // and select are all inspected: a path is walked hop by hop, and a bare
    // identifier is rejected when it happens to be a navigation of this entity
    // (`$select=empInfo` names a denied association and is never dispatched).
    for (const [name, expression] of [
      ["filter", filter],
      ["orderby", orderby],
      ["select", select],
    ] as const) {
      if (expression === undefined) {
        continue;
      }
      // The service decodes percent-encoding, so `%65xternalCodeNav` reaches a
      // navigation the identifier scan would never see. Same rule as `$expand`
      // and the entity path: reject rather than dispatch unverified.
      if (hasEncodedStructure(expression)) {
        throw new SanitizedError(
          "OPTION_INVALID",
          `${name} uses percent-encoded characters outside a quoted literal: the service decodes them, so they can hide a reference this server cannot verify`,
        );
      }
      const expressionVerdict = await checkExpressionReferences(
        pathVerdict.reached,
        expressionReferences(expression),
        allowlist,
        denylist,
        lookup,
      );
      if (expressionVerdict.kind === "denied") {
        throw new SanitizedError(
          "ENTITY_NOT_ALLOWED",
          `a navigation referenced by ${name} is not permitted by the configured entityAllowlist`,
        );
      }
      if (expressionVerdict.kind === "unresolvable") {
        throw new SanitizedError(
          "NAVIGATION_NOT_ALLOWED",
          `a navigation referenced by ${name} could not be resolved from the cached metadata; if the catalog changed, run \`ssff-mcp cache invalidate <alias>\` and retry`,
        );
      }
      // Field-level granularity: the same references, checked against the
      // `fields` of the entity each property belongs to.
      try {
        await enforceFieldPermissions(
          target,
          alias,
          tenantId,
          allowlist ?? [],
          pathVerdict.reached,
          expressionReferences(expression),
          name,
        );
      } catch (cause) {
        throw toEntityNotAllowed(cause);
      }
    }
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

  const listEnvironments = toolEntry("list_environments");
  server.registerTool(
    listEnvironments.name,
    {
      title: listEnvironments.title,
      description: listEnvironments.description,
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

  const inspectEntity = toolEntry("inspect_entity");
  server.registerTool(
    inspectEntity.name,
    {
      title: inspectEntity.title,
      description: inspectEntity.description,
      inputSchema: inspectEntitySchema,
    },
    async (args) =>
      await executeTool("inspect_entity", args.environment, async () => {
        const { environments, defaultLocale, inline, tenantId } = await loadFreshConfig(args.environment);
        const { alias, env } = resolveEnvironment(environments, args.environment, inline);
        // The allowlist/denylist are per environment (FR-28/D-30); the denylist wins.
        const entityAllowlist = env.entityAllowlist;
        const entityDenylist = env.entityDenylist;
        const target: EnvTarget = envTargetFor(env, alias, tenantId);
        const locale = resolveLocale({ tool: args.locale, config: defaultLocale, env: envVars.SF_DEFAULT_LOCALE });

        if (args.entitySet !== undefined) {
          // The listing options are meaningless with a single entity; rejected
          // rather than silently ignored.
          if (args.customOnly === true || args.employeeLinkedOnly === true || args.query !== undefined) {
            throw new SanitizedError(
              "OPTION_INVALID",
              "customOnly, employeeLinkedOnly and query only apply to the entity listing; omit entitySet or drop them",
            );
          }
          if (!isEntityPermitted(entityAllowlist, entityDenylist, args.entitySet)) {
            throw new SanitizedError(
              "ENTITY_NOT_ALLOWED",
              `ENTITY_NOT_ALLOWED: entity "${args.entitySet}" is not permitted by the configured allowlist`,
            );
          }
          // Same contract as sf://{env}/entities/{entitySet} (FR-101): Custom MDF
          // entities get additive MDF fields; any other entity keeps the plain schema.
          if (isCustomMdfEntity(args.entitySet)) {
            const details = await metadataServiceFor(tenantId).getCustomMdfDetails(
              target,
              alias,
              args.entitySet,
              entityAllowlist,
              locale,
            );
            if (details !== undefined) {
              // Field granularity: a property you cannot read must not be
              // discoverable in the schema either.
              const visible = await redactedSchema(
                target,
                alias,
                tenantId,
                entityAllowlist,
                args.entitySet,
                details,
              );
              const structured = visible as unknown as Record<string, unknown>;
              return { structured, text: JSON.stringify(structured) };
            }
          }
          const schema = await metadataServiceFor(tenantId).getEntitySchema(target, alias, args.entitySet);
          if (schema === undefined) {
            throw new SanitizedError(
              "RESOURCE_NOT_FOUND",
              "the requested entity set was not found in the metadata of this environment",
            );
          }
          const visible = await redactedSchema(target, alias, tenantId, entityAllowlist, args.entitySet, schema);
          const structured = visible as unknown as Record<string, unknown>;
          return { structured, text: JSON.stringify(structured) };
        }

        if (args.employeeLinkedOnly === true && args.customOnly !== true) {
          throw new SanitizedError("OPTION_INVALID", "employeeLinkedOnly requires customOnly: true");
        }

        if (args.customOnly === true) {
          const listed = await metadataServiceFor(tenantId).listCustomMdf(
            target,
            alias,
            entityAllowlist,
            args.employeeLinkedOnly === true,
          );
          // The metadata service applies the allowlist; the denylist is applied here.
          const entities = listed.filter((entity) => isEntityPermitted(undefined, entityDenylist, entity.name));
          const structured: Record<string, unknown> = {
            environment: alias,
            locale,
            totalCount: entities.length,
            employeeLinkedCount: entities.filter((entity) => isEmployeeLinkedType(entity.linkType)).length,
            entities,
          };
          return { structured, text: JSON.stringify(structured), recordCount: entities.length };
        }

        // Full listing (FR-100): every entity that passes the allowlist and the
        // optional name filter, never truncated.
        const parsed = await metadataServiceFor(tenantId).getParsedMetadata(target, alias);
        const allowed = parsed.entitySets.filter((name) =>
          isEntityPermitted(entityAllowlist, entityDenylist, name),
        );
        const needle = args.query?.toLowerCase();
        const entities = allowed
          .filter((name) => needle === undefined || name.toLowerCase().includes(needle))
          .map((name) => ({ name, isCustom: isCustomMdfEntity(name) }));
        const structured = { environment: alias, totalCount: entities.length, entities };
        return { structured, text: JSON.stringify(structured), recordCount: entities.length };
      }),
  );

  const resolvePicklist = toolEntry("resolve_picklist");
  server.registerTool(
    resolvePicklist.name,
    {
      title: resolvePicklist.title,
      description: resolvePicklist.description,
      inputSchema: resolvePicklistSchema,
    },
    async (args) =>
      await executeTool("resolve_picklist", args.environment, async () => {
        const { environments, defaultLocale, inline, tenantId } = await loadFreshConfig(args.environment);
        const { alias, env } = resolveEnvironment(environments, args.environment, inline);
        const target: EnvTarget = envTargetFor(env, alias, tenantId);
        const locale = resolvePicklistLocale({
          tool: args.locale,
          config: defaultLocale,
          env: envVars.SF_DEFAULT_LOCALE,
        });
        const service = picklistServiceFor(tenantId);
        const forceRefresh = args.forceRefresh === true;

        if (args.query !== undefined && args.query.trim().length > 0) {
          const matches = await service.searchByLabel(
            target,
            alias,
            args.query,
            args.picklistId,
            locale,
            forceRefresh,
          );
          const structured: Record<string, unknown> = {
            ...(args.picklistId ? { picklistId: args.picklistId } : {}),
            matches,
          };
          return { structured, text: JSON.stringify(structured, null, 2), recordCount: matches.length };
        }

        if (args.optionId !== undefined) {
          const optStr = String(args.optionId);
          const res = await service.resolveOption(
            target,
            alias,
            args.picklistId,
            optStr,
            locale,
            forceRefresh,
          );
          if (res.resolved) {
            const structured = {
              found: true,
              option: {
                optionId: optStr,
                picklistId: res.picklistId,
                externalCode: res.externalCode,
                label: res.label,
                locale,
                status: "ACTIVE",
              },
            };
            return { structured, text: JSON.stringify(structured, null, 2), recordCount: 1 };
          }
          const structured = {
            found: false,
            optionId: optStr,
          };
          return { structured, text: JSON.stringify(structured, null, 2), recordCount: 0 };
        }

        if (args.externalCode !== undefined) {
          const extCode = args.externalCode.trim();
          const res = await service.resolveOption(
            target,
            alias,
            args.picklistId,
            extCode,
            locale,
            forceRefresh,
          );
          if (res.resolved) {
            const structured = {
              found: true,
              option: {
                optionId: res.optionId ?? (res.rawValue ?? extCode),
                picklistId: res.picklistId,
                externalCode: res.externalCode,
                label: res.label,
                locale,
                status: "ACTIVE",
              },
            };
            return { structured, text: JSON.stringify(structured, null, 2), recordCount: 1 };
          }
          const structured = {
            found: false,
            ...(args.picklistId ? { picklistId: args.picklistId } : {}),
            externalCode: extCode,
          };
          return { structured, text: JSON.stringify(structured, null, 2), recordCount: 0 };
        }

        if (args.picklistId !== undefined) {
          const options = await service.listOptions(
            target,
            alias,
            args.picklistId,
            locale,
            forceRefresh,
          );
          const structured = {
            picklistId: args.picklistId,
            options,
          };
          return { structured, text: JSON.stringify(structured, null, 2), recordCount: options.length };
        }

        throw new SanitizedError(
          "OPTION_INVALID",
          "at least one of picklistId, optionId, externalCode or query must be provided",
        );
      }),
  );

  const queryEntity = toolEntry("query_entity");
  server.registerTool(
    queryEntity.name,
    {
      title: queryEntity.title,
      description: queryEntity.description,
      inputSchema: queryEntitySchema,
    },
    async (args) =>
      await executeTool("query_entity", args.environment, async () => {
        const { environments, defaultLocale, inline, tenantId, capBytes } = await loadFreshConfig(args.environment);
        const { alias, env } = resolveEnvironment(environments, args.environment, inline);
        // The allowlist/denylist are per environment (FR-28/D-30); the denylist wins.
        const entityAllowlist = env.entityAllowlist;
        const entityDenylist = env.entityDenylist;

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
        // FIRST segment's entity set is checked; navigation segments are resolved
        // and checked separately below, against the same lists. v2 is the only active
        // protocol in this phase, so entries restricted to ["v4"] are denied
        // (DS-P2-03). Generic message: the path is never echoed.
        if (!isEntityPermitted(entityAllowlist, entityDenylist, validatedPath.firstSegmentName)) {
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
            tenantId,
            env: alias,
            path: args.entityPath,
            options: bindingOptions,
          });
          skiptoken = payload.skiptoken;
        }

        let { pathAndQuery, topClamped } = buildQuery(args.entityPath, {
          filter: args.filter,
          orderby: args.orderby,
          select: args.select,
          expand: args.expand,
          fromDate: args.fromDate,
          toDate: args.toDate,
          asOfDate: args.asOfDate,
          top: args.top,
          skip: args.skip,
          inlinecount: args.inlinecount,
          skiptoken,
        });

        const target: EnvTarget = envTargetFor(env, alias, tenantId);
        const verdict = await metadataServiceFor(tenantId).classifyFirstSegment(target, alias, validatedPath.firstSegmentName);
        if (verdict.kind === "function-import") {
          throw new SanitizedError(
            "FUNCTION_IMPORT_UNSUPPORTED",
            "custom service operations / function imports are not supported in the MVP",
          );
        }
        if (verdict.kind === "unknown") {
          throw new SanitizedError("PATH_INVALID", "unknown entity set");
        }

        let entitySchema: EntitySchema | undefined;
        let expansionPlan: PicklistExpansionPlan | undefined;
        if (args.resolvePicklists === true) {
          const reachedEntity = await entityReachedByPath(target, alias, tenantId, validatedPath.segments);
          entitySchema = reachedEntity ? await metadataServiceFor(tenantId).getEntitySchema(target, alias, reachedEntity) : undefined;
          expansionPlan = planPicklistExpansion(entitySchema, args.expand, args.select, args.resolvePicklists);
          if (expansionPlan.sapExpand !== args.expand || expansionPlan.sapSelect !== args.select) {
            const rebuilt = buildQuery(args.entityPath, {
              filter: args.filter,
              orderby: args.orderby,
              select: expansionPlan.sapSelect,
              expand: expansionPlan.sapExpand,
              fromDate: args.fromDate,
              toDate: args.toDate,
              asOfDate: args.asOfDate,
              top: args.top,
              skip: args.skip,
              inlinecount: args.inlinecount,
              skiptoken,
            });
            pathAndQuery = rebuilt.pathAndQuery;
            topClamped = rebuilt.topClamped;
          }
        }

        // Navigation and $expand are resolved against the cached metadata and
        // checked against the same lists (FR-141..FR-146), before any data request.
        await enforceNavigationVectors(
          target,
          alias,
          tenantId,
          env,
          validatedPath.segments,
          expansionPlan !== undefined ? expansionPlan.sapExpand : args.expand,
          args.filter,
          args.orderby,
          expansionPlan !== undefined ? expansionPlan.sapSelect : args.select,
        );

        // Field-level granularity: when any involved entity carries `fields`, the
        // XML output is DOWNGRADED to JSON (with a flag) instead of redacting
        // Atom — decided trade-off, documented in docs/configuration.md.
        const downgradeXml =
          output === "xml" &&
          (await fieldRestrictionApplies(
            target,
            alias,
            tenantId,
            env.entityAllowlist ?? [],
            validatedPath.segments,
            args.expand,
          ));

        // Exactly one fetch per call; next links are never followed.
        const result = await dispatchGet(target, pathAndQuery, {
          // Entity data in XML is Atom: SF answers 406 to `application/xml` there
          // (that media type is only valid for $metadata).
          accept: output === "xml" && !downgradeXml ? "application/atom+xml" : "application/json",
          timeoutMs: QUERY_TOOL_TIMEOUT_MS,
          fetchImpl,
          now: deps.now,
        });

        if (output === "xml" && !downgradeXml) {
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
            const cursor = encodeContinuationCursor(alias, args.entityPath, bindingOptions, paging.nextUrl, tenantId);
            if (cursor !== undefined) {
              structured.cursor = cursor;
            }
          }
          // DS-P2-06: raw body minus the next-link href. Paging/cursor were
          // derived from the ORIGINAL href above; the returned text must never
          // expose the service URL or the raw $skiptoken.
          const xmlText = sanitizeXmlNextLinks(result.body);
          if (exceedsResponseCap(xmlText, capBytes)) {
            throw responseTooLargeError(xmlText, capBytes);
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

        // Field-level granularity: strip what `fields` does not permit. Without
        // this, omitting $select would return every property.
        const redactedRecords = await redactRecords(
          target,
          alias,
          tenantId,
          env.entityAllowlist,
          validatedPath.segments,
          unwrapped.records,
        );

        let finalRecords = redactedRecords;
        if (args.resolvePicklists === true && Array.isArray(finalRecords) && entitySchema) {
          try {
            const locale = resolvePicklistLocale({
              tool: args.locale,
              config: defaultLocale,
              env: envVars.SF_DEFAULT_LOCALE,
            });
            finalRecords = (await picklistServiceFor(tenantId).enrichRecords(
              finalRecords,
              entitySchema,
              target,
              alias,
              locale,
              expansionPlan?.activePicklists,
            )) as unknown[];
          } catch {
            // Fail-safe (D-59 / FR-65): never fail main query on picklist error
          }
        }

        const structured: Record<string, unknown> = {
          environment: alias,
          path: args.entityPath,
          recordCount: unwrapped.records.length,
          records: finalRecords,
          hasMore: unwrapped.hasMore,
        };
        if (downgradeXml) {
          structured.outputDowngraded = true;
        }
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
          const cursor = encodeContinuationCursor(alias, args.entityPath, bindingOptions, unwrapped.nextUrl, tenantId);
          if (cursor !== undefined) {
            structured.cursor = cursor;
          }
        }
        const text = JSON.stringify(structured);
        // Size guard (D-75): only what is returned to the model is measured.
        if (exceedsResponseCap(text, capBytes)) {
          throw responseTooLargeError(text, capBytes);
        }
        return {
          structured,
          text,
          recordCount: unwrapped.records.length,
        };
      }),
  );

  const batchGet = toolEntry("batch_get");
  server.registerTool(
    batchGet.name,
    {
      title: batchGet.title,
      description: batchGet.description,
      inputSchema: batchGetSchema,
    },
    async (args) =>
      await executeTool("batch_get", args.environment, async () => {
        const { environments, defaultLocale, inline, tenantId, capBytes } = await loadFreshConfig(args.environment);
        const { alias, env } = resolveEnvironment(environments, args.environment, inline);
        // The allowlist/denylist are per environment (FR-28/D-30); the denylist wins.
        const entityAllowlist = env.entityAllowlist;
        const entityDenylist = env.entityDenylist;

        const output = args.output ?? "json";
        const target: EnvTarget = envTargetFor(env, alias, tenantId);

        // Pass 1 — pure preflight for EVERY item (no network at all):
        // path grammar, allowlist, cursor+skip exclusivity, cursor binding
        // decode and option bounds/query build (FR-29).
        interface PlannedItem {
          entityPath: string;
          firstSegmentName: string;
          segments: readonly string[];
          expand: string | undefined;
          filter: string | undefined;
          orderby: string | undefined;
          select: string | undefined;
          fromDate?: string;
          toDate?: string;
          asOfDate?: string;
          top?: number;
          skip?: number;
          inlinecount?: "allpages";
          skiptoken?: string;
          resolvePicklists?: boolean;
          activePicklists?: Map<string, Set<string>>;
          schema?: EntitySchema;
          locale?: string;
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
          if (!isEntityPermitted(entityAllowlist, entityDenylist, validatedPath.firstSegmentName)) {
            throw new SanitizedError(
              "ENTITY_NOT_ALLOWED",
              "the entity is not permitted by the configured entityAllowlist",
            );
          }
          const bindingOptions = cursorBindingOptions({ ...item, output });
          let skiptoken: string | undefined;
          if (item.cursor !== undefined) {
            const payload = defaultCursorCodec.decode(item.cursor, {
              tenantId,
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
            fromDate: item.fromDate,
            toDate: item.toDate,
            asOfDate: item.asOfDate,
            top: item.top,
            skip: item.skip,
            inlinecount: item.inlinecount,
            skiptoken,
          });
          planned.push({
            entityPath: item.entityPath,
            firstSegmentName: validatedPath.firstSegmentName,
            segments: validatedPath.segments,
            expand: item.expand,
            filter: item.filter,
            orderby: item.orderby,
            select: item.select,
            fromDate: item.fromDate,
            toDate: item.toDate,
            asOfDate: item.asOfDate,
            top: item.top,
            skip: item.skip,
            inlinecount: item.inlinecount,
            skiptoken,
            resolvePicklists: item.resolvePicklists,
            locale: item.locale,
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
          const verdict = await metadataServiceFor(tenantId).classifyFirstSegment(target, alias, item.firstSegmentName);
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

        // Pass 2b — navigation and $expand, per ITEM (never deduped by root):
        // the same root can carry different navigations or different expands.
        for (const item of planned) {
          if (item.resolvePicklists === true) {
            const reachedEntity = await entityReachedByPath(target, alias, tenantId, item.segments);
            item.schema = reachedEntity ? await metadataServiceFor(tenantId).getEntitySchema(target, alias, reachedEntity) : undefined;
            const expansionPlan = planPicklistExpansion(item.schema, item.expand, item.select, item.resolvePicklists);
            item.activePicklists = expansionPlan.activePicklists;
            if (expansionPlan.sapExpand !== item.expand || expansionPlan.sapSelect !== item.select) {
              item.expand = expansionPlan.sapExpand;
              item.select = expansionPlan.sapSelect;
              const rebuilt = buildQuery(item.entityPath, {
                filter: item.filter,
                orderby: item.orderby,
                select: expansionPlan.sapSelect,
                expand: expansionPlan.sapExpand,
                fromDate: item.fromDate,
                toDate: item.toDate,
                asOfDate: item.asOfDate,
                top: item.top,
                skip: item.skip,
                inlinecount: item.inlinecount,
                skiptoken: item.skiptoken,
              });
              item.pathAndQuery = rebuilt.pathAndQuery;
              item.topClamped = rebuilt.topClamped;
            }
          }

          await enforceNavigationVectors(
            target,
            alias,
            tenantId,
            env,
            item.segments,
            item.expand,
            item.filter,
            item.orderby,
            item.select,
          );
        }

        // Field-level granularity: XML parts are DOWNGRADED to JSON (flagged)
        // when ANY item touches an entity that carries `fields`.
        const downgradeXml =
          output === "xml" &&
          (await (async () => {
            for (const item of planned) {
              if (
                await fieldRestrictionApplies(
                  target,
                  alias,
                  tenantId,
                  env.entityAllowlist ?? [],
                  item.segments,
                  item.expand,
                )
              ) {
                return true;
              }
            }
            return false;
          })());

        // One fixed $batch POST, GET-only envelope (D-28/DS-P2-04).
        const responses = await executeBatchGet({
          env: target,
          output: downgradeXml ? "json" : output,
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
          if (entry.success === true && exceedsResponseCap(measured, capBytes)) {
            const error = responseTooLargeError(measured, capBytes);
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

          if (output === "xml" && !downgradeXml) {
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
              const cursor = encodeContinuationCursor(alias, item.entityPath, item.bindingOptions, paging.nextUrl, tenantId);
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
          let itemRecords = await redactRecords(
            target,
            alias,
            tenantId,
            env.entityAllowlist,
            item.segments,
            records,
          );
          if (item.resolvePicklists === true && Array.isArray(itemRecords) && item.schema) {
            try {
              const locale = resolvePicklistLocale({
                tool: item.locale,
                config: defaultLocale,
                env: envVars.SF_DEFAULT_LOCALE,
              });
              itemRecords = (await picklistServiceFor(tenantId).enrichRecords(
                itemRecords,
                item.schema,
                target,
                alias,
                locale,
                item.activePicklists,
              )) as unknown[];
            } catch {
              // Fail-safe (D-59 / FR-65)
            }
          }
          entry.records = itemRecords;
          if (downgradeXml) {
            entry.outputDowngraded = true;
          }
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
            const cursor = encodeContinuationCursor(alias, item.entityPath, item.bindingOptions, unwrapped.nextUrl, tenantId);
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
      const { environments, inline, tenantId } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      // The allowlist/denylist are per environment (FR-28/D-30); the denylist wins.
      const entityAllowlist = resolved.env.entityAllowlist;
      const entityDenylist = resolved.env.entityDenylist;
      const target = envTargetFor(resolved.env, resolved.alias, tenantId);
      const parsed = await metadataServiceFor(tenantId).getParsedMetadata(target, resolved.alias);

      const overview = {
        environment: resolved.alias,
        baseUrl: resolved.env.baseUrl,
        authType: resolved.env.auth.type,
        totalEntitySets: parsed.entitySets.length,
        functionImportsCount: parsed.functionImports.length,
        allowlistConfigured: entityAllowlist !== undefined && entityAllowlist.length > 0,
        denylistConfigured: entityDenylist !== undefined && entityDenylist.length > 0,
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
      const { environments, inline, tenantId } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      // The allowlist/denylist are per environment (FR-28/D-30); the denylist wins.
      const entityAllowlist = resolved.env.entityAllowlist;
      const entityDenylist = resolved.env.entityDenylist;
      const target = envTargetFor(resolved.env, resolved.alias, tenantId);
      const parsed = await metadataServiceFor(tenantId).getParsedMetadata(target, resolved.alias);

      let allowedSets = parsed.entitySets;
      allowedSets = allowedSets.filter((name) => isEntityPermitted(entityAllowlist, entityDenylist, name));

      // Names only (decision 2026-10-14). Measured against PROD's 658 entities:
      // 142 KB with entityType, isCustom, isEmployeeLinked, isEffectiveDated and
      // keyProperties, versus ~19 KB with names alone. The heavier fields belong
      // to the per-entity detail (sf://{env}/entities/{entitySet}) and to
      // sf://{env}/mdf/custom, so discoverability is preserved.
      const entityList = allowedSets.map((name) => ({ name }));

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
      const { environments, defaultLocale, inline, tenantId } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      // The allowlist/denylist are per environment (FR-28/D-30); the denylist wins.
      const entityAllowlist = resolved.env.entityAllowlist;
      const entityDenylist = resolved.env.entityDenylist;
      const entityName = entitySet as string;

      if (!isEntityPermitted(entityAllowlist, entityDenylist, entityName)) {
        throw new SanitizedError(
          "ENTITY_NOT_ALLOWED",
          `ENTITY_NOT_ALLOWED: entity "${entityName}" is not permitted by the configured allowlist`,
        );
      }

      const target = envTargetFor(resolved.env, resolved.alias, tenantId);
      const schema = await metadataServiceFor(tenantId).getEntitySchema(target, resolved.alias, entityName);
      if (!schema) {
        throw new SanitizedError(
          "RESOURCE_NOT_FOUND",
          `RESOURCE_NOT_FOUND: entity "${entityName}" not found in metadata for environment "${resolved.alias}"`,
        );
      }

      // Custom MDF entities get additive MDF fields (FR-72); every other entity
      // keeps the plain schema contract. Resources take no parameters, so the
      // locale uses levels 2-4 only (D-70).
      const rawPayload = isCustomMdfEntity(entityName)
        ? ((await metadataServiceFor(tenantId).getCustomMdfDetails(
            target,
            resolved.alias,
            entityName,
            entityAllowlist,
            resolveLocale({ config: defaultLocale, env: envVars.SF_DEFAULT_LOCALE }),
          )) ?? schema)
        : schema;
      // Field granularity: a property you cannot read must not be discoverable.
      const payload = await redactedSchema(
        target,
        resolved.alias,
        tenantId,
        entityAllowlist,
        entityName,
        rawPayload,
      );

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
      const { environments, inline, tenantId } = await loadFreshConfig(environment as string);
      const resolved = resolveEnvironment(environments, environment as string, inline);
      // The allowlist/denylist are per environment (FR-28/D-30); the denylist wins.
      const entityAllowlist = resolved.env.entityAllowlist;
      const entityDenylist = resolved.env.entityDenylist;
      const target = envTargetFor(resolved.env, resolved.alias, tenantId);
      // Zero-network (D-62): classified from the cached $metadata; allowlist-filtered (D-68).
      const listed = await metadataServiceFor(tenantId).listCustomMdf(target, resolved.alias, entityAllowlist);
      // The metadata service applies the allowlist; the denylist is applied here.
      const entities = listed.filter((entity) => isEntityPermitted(undefined, entityDenylist, entity.name));
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
