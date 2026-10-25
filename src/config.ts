/**
 * Configuration loading and strict validation for
 * `~/.config/ssff-mcp/config.json`.
 *
 * - The path is fixed (resolved via os.homedir()); XDG_CONFIG_HOME is
 *   deliberately NOT honored.
 * - The file is re-read and re-validated on every tool call (stateless).
 * - `defaultEnvironment` must be null/absent: implicit environment selection
 *   is forbidden, so any non-null value is a CONFIG_INVALID error.
 * - Errors never include the resolved absolute path (no $HOME leak); the
 *   literal tilde form is used instead.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AllowlistEntry } from "./allowlist.js";
import {
  hasCredentialCollision,
  type HostedAuthDirectory,
  type LocalRole,
  type LocalTenantAuth,
  type LocalUser,
} from "./local-auth.js";
import { SanitizedError } from "./errors.js";
import { resolveDataCenter, SAP_DATA_CENTERS } from "./datacenters.js";

const execFileAsync = promisify(execFile);

export type { AllowlistEntry, AllowlistProtocol } from "./allowlist.js";

/** Literal tilde form used in every user-facing message. */
export const CONFIG_TILDE_PATH = "~/.config/ssff-mcp/config.json";

export const CONFIG_TEMPLATE_NAME = "config.template.json";

export interface BasicAuthConfig {
  type: "basic";
  username: string;
  password: string;
}

export interface OAuthAuthConfig {
  type: "oauth";
  /** OAuth2 client API key from the SF Admin Center registration. */
  clientId: string;
  /** Tenant company id (sent to the token endpoint as company_id). */
  companyId: string;
  /** Technical user id WITHOUT the @companyId suffix. */
  userId: string;
  /** RSA private key exported from SF Admin (inline plaintext; D-24 tradeoff). */
  privateKey: string;
  /** Fixed token endpoint (https). */
  tokenUrl: string;
  /** SAP IdP helper endpoint; derived from tokenUrl origin when absent. */
  idpUrl: string;
}

export type AuthConfig = BasicAuthConfig | OAuthAuthConfig;

export interface EnvironmentConfig {
  /** Normalized base URL: https origin + optional path prefix, no trailing slash. */
  baseUrl: string;
  /** Canonical data center identifier (FR-109/FR-115, e.g. "DC2", "DC4", "DC55"). */
  dataCenter?: string;
  auth: AuthConfig;
  /**
   * Entity allowlist for THIS environment (FR-28/D-30). It only NARROWS: absent
   * or empty means no narrowing, so everything the tenant account can read is
   * reachable.
   */
  entityAllowlist?: AllowlistEntry[];
  /**
   * Entities ALWAYS denied in this environment, whatever the allowlist says.
   * Wins over `entityAllowlist`; used to subtract from a base inherited at
   * tenant level.
   */
  entityDenylist?: AllowlistEntry[];
}

export interface SsffConfig {
  /**
   * Identifier of the tenant this config was resolved from (D-118/D-119):
   * the declared id in the tenants shape, "default" for the migrated flat
   * shape and inline mode. Namespaces the metadata cache (D-121); the engine
   * itself never reads it.
   */
  tenantId?: string;
  environments: Record<string, EnvironmentConfig>;
  /** Preferred language for guidance prose (FR-76); absent when not configured. */
  defaultLocale?: string;
  /** Cap, in bytes, for what is returned to the model (D-75/FR-86); absent when not configured. */
  maxResponseBytes?: number;
  /**
   * True when the config was synthesized from inline SF_* environment
   * variables (no config.json). Only in this mode may a tool call omit
   * `environment` (FR-49/D-49); a config.json always keeps D-02/FR-02.
   */
  inline?: boolean;
}

export const secretProviderSchema = z.union([
  z.string().min(1),
  z.object({ fromEnv: z.string().min(1) }).strict(),
  z.object({ fromCommand: z.array(z.string().min(1)).min(1) }).strict(),
]);

export type SecretProvider = z.infer<typeof secretProviderSchema>;

const basicAuthSchema = z
  .object({
    type: z.literal("basic"),
    username: z.string().min(1),
    password: secretProviderSchema,
  })
  .strict();

const oauthAuthSchema = z
  .object({
    type: z.literal("oauth"),
    clientId: z.string().min(1),
    companyId: z.string().min(1),
    // The Basic-Auth habit is user@companyId; the IdP helper wants the bare user id.
    userId: z
      .string()
      .min(1)
      .refine((value) => !value.includes("@"), {
        message: "oauth userId is the technical user id WITHOUT the @companyId suffix",
      }),
    privateKey: secretProviderSchema,
    tokenUrl: z.string().min(1).optional(),
    idpUrl: z.string().min(1).optional(),
  })
  .strict();

const authSchema = z.discriminatedUnion("type", [basicAuthSchema, oauthAuthSchema]);

// OData entity set name (case-sensitive exact match; no predicates here).
const ENTITY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const allowlistProtocolsSchema = z
  .array(z.enum(["v2", "v4"]))
  .min(1, "protocols must be a non-empty array")
  .refine((values) => new Set(values).size === values.length, {
    message: "protocols must not contain duplicates",
  });

const fieldNamesSchema = z
  .array(
    z.string().regex(ENTITY_NAME_PATTERN, {
      message: "fields must be property names matching ^[A-Za-z_][A-Za-z0-9_]*$",
    }),
  )
  .refine((values) => new Set(values).size === values.length, {
    message: "fields must not contain duplicates",
  });

/** Duplicate entities are ambiguous (which protocols/fields apply?) => rejected. */
function rejectDuplicateEntities(field: "entityAllowlist" | "entityDenylist") {
  return (entries: Array<{ entity: string }>, ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();
    for (const [index, item] of entries.entries()) {
      if (seen.has(item.entity)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "entity"],
          message: `${field} contains a duplicate entity entry for "${item.entity}"`,
        });
      }
      seen.add(item.entity);
    }
  };
}

// `fields` exists ONLY on the allowlist: a property denylist would add a second,
// ambiguous precedence rule on top of the entity denylist.
const entityAllowlistSchema = z
  .array(
    z
      .object({
        entity: z.string().regex(ENTITY_NAME_PATTERN, {
          message: "entityAllowlist entity must be an OData entity set name matching ^[A-Za-z_][A-Za-z0-9_]*$",
        }),
        protocols: allowlistProtocolsSchema.optional(),
        fields: fieldNamesSchema.optional(),
      })
      .strict(),
  )
  .superRefine(rejectDuplicateEntities("entityAllowlist"));

const entityDenylistSchema = z
  .array(
    z
      .object({
        entity: z.string().regex(ENTITY_NAME_PATTERN, {
          message: "entityDenylist entity must be an OData entity set name matching ^[A-Za-z_][A-Za-z0-9_]*$",
        }),
        protocols: allowlistProtocolsSchema.optional(),
      })
      .strict(),
  )
  .superRefine(rejectDuplicateEntities("entityDenylist"));

const environmentSchema = z
  .object({
    dataCenter: z.string().trim().optional(),
    baseUrl: z.string().min(1).optional(),
    auth: authSchema,
    // Per-environment narrowing (FR-28/D-30). Absent OR empty means no
    // narrowing: the environment reaches whatever the tenant account can read.
    entityAllowlist: entityAllowlistSchema.optional(),
    // Always denied in this environment, whatever the allowlist says.
    entityDenylist: entityDenylistSchema.optional(),
    // D-120: per-environment API key (sha-256 hex digest). A key declared here
    // reaches ONLY this environment; consumed by `ssff-mcp serve`, ignored by
    // stdio. Absent => the tenant-level key (or no key) applies.
    apiKeyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, {
        message: "apiKeyHash must be the sha-256 hex digest of the key (64 hex characters)",
      })
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.baseUrl && !data.dataCenter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: 'environment must define at least "baseUrl" or "dataCenter"',
      });
      return;
    }
    if (data.dataCenter !== undefined) {
      const resolved = resolveDataCenter(data.dataCenter);
      if (!resolved && !data.baseUrl) {
        const supported = Object.keys(SAP_DATA_CENTERS).join(", ");
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataCenter"],
          message: `unknown dataCenter "${data.dataCenter}"; supported data centers: ${supported}`,
        });
      }
    }
  });

const aliasSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "environment alias must be a non-empty string",
});

/** A4: the Windows ACL warning is informative, so one per process is enough. */
let windowsAclWarningEmitted = false;

/** D-119: the legacy-shape migration warning is informative; once per process. */
let legacyShapeWarningEmitted = false;

// Global settings shared by both config shapes. `defaultLocale`: lax BCP-47
// (`es`, `es_ES`, `es-ES`) — the format is validated, not whether a catalog
// exists for it (an untranslated locale falls back to en_US at use time).
const defaultLocaleSchema = z
  .string()
  .regex(/^[A-Za-z]{2}([-_][A-Za-z]{2})?$/, {
    message: "defaultLocale must be a language or language_REGION code such as es or es_ES",
  })
  .optional();

// Optional cap, in bytes, for what is returned to the model (D-75/FR-86).
// Positive integer; absent falls back to SF_MAX_RESPONSE_BYTES, then 256 KiB.
const maxResponseBytesSchema = z.number().int().positive().optional();

/** Legacy flat shape (auto-migrates to a single "default" tenant, D-119). */
const configSchema = z
  .object({
    environments: z.record(aliasSchema, environmentSchema),
    // Implicit environment selection is forbidden: null/absent only.
    defaultEnvironment: z.null().optional(),
    defaultLocale: defaultLocaleSchema,
    maxResponseBytes: maxResponseBytesSchema,
  })
  .strict();

const tenantIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "tenant id must be a non-empty string",
});

// --- Fixed local MCP users with personal tokens (S1–S3, S6,
// odd/tasks/local-user-tokens.md). Interim Phase 1: no IAS, no issuer/subject
// fields, no SSFF credentials on user records; SHA-256 hashes are suitable
// only because tokens are generated high-entropy random values, never
// user-chosen passwords. ---

const localRoleNameSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "role name must be a non-empty string",
});

const localUserIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "user id must be a non-empty string",
});

const localTokenIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "token id must be a non-empty string",
});

/**
 * One personal token record (S2/S3): hash-only storage. `expiresAt` is
 * REQUIRED and must be an ISO 8601 date-time WITH timezone (Z or offset). An
 * expired date is VALID config that simply never authenticates, so expiry
 * needs no rotation downtime.
 */
const localTokenSchema = z
  .object({
    id: localTokenIdSchema,
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, {
        message: "hash must be the lowercase sha-256 hex digest of the token (64 hex characters)",
      }),
    expiresAt: z.string().datetime({
      offset: true,
      message:
        "expiresAt must be an ISO 8601 date-time with timezone, for example 2030-06-01T00:00:00Z or 2030-06-01T04:00:00+02:00",
    }),
    revoked: z.boolean().optional(),
  })
  .strict();

/** Role environments: mandatory, non-empty, duplicate-free aliases of the SAME tenant. */
const localRoleEnvironmentsSchema = z
  .array(aliasSchema)
  .min(1, "role environments must declare at least one environment alias")
  .refine((values) => new Set(values).size === values.length, {
    message: "role environments must not contain duplicates",
  });

/** A tenant-local role (S1): explicit environment reach; entity lists only narrow. */
const localRoleSchema = z
  .object({
    environments: localRoleEnvironmentsSchema,
    entityAllowlist: entityAllowlistSchema.optional(),
    entityDenylist: entityDenylistSchema.optional(),
  })
  .strict();

/** Reject duplicate token ids within one user (rotation names records by id). */
function rejectDuplicateTokenIds(tokens: Array<{ id: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (seen.has(token.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "id"],
        message: `duplicate token id "${token.id}"`,
      });
    }
    seen.add(token.id);
  }
}

/**
 * A fixed local user (S1): exactly one explicitly declared role and personal
 * token records. `enabled` defaults to true; `tokens` is required and may be
 * empty (the revoke-all form, S3). Strict: user records carry NO SSFF
 * credentials and no IAS identity fields.
 */
const localUserSchema = z
  .object({
    role: localRoleNameSchema,
    enabled: z.boolean().optional(),
    tokens: z.array(localTokenSchema).superRefine(rejectDuplicateTokenIds),
  })
  .strict();

/**
 * One tenant (D-119): its environments plus tenant-level defaults. The lists
 * are the BASE for every environment; a per-environment list REPLACES it
 * (never merges). `apiKeyHash` is the client-wide key (reaches every
 * environment); per-environment keys narrow it to that environment (D-120).
 * `roles`/`users` are the optional local-auth keys (S1–S3): both absent keeps
 * the pre-local-auth behavior; roles may exist with no users (no principal
 * means no access).
 */
const tenantSchema = z
  .object({
    apiKeyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, {
        message: "apiKeyHash must be the sha-256 hex digest of the key (64 hex characters)",
      })
      .optional(),
    entityAllowlist: entityAllowlistSchema.optional(),
    entityDenylist: entityDenylistSchema.optional(),
    environments: z.record(aliasSchema, environmentSchema),
    roles: z.record(localRoleNameSchema, localRoleSchema).optional(),
    users: z.record(localUserIdSchema, localUserSchema).optional(),
  })
  .strict()
  .superRefine((tenant, ctx) => {
    if (tenant.roles === undefined && tenant.users === undefined) {
      return;
    }
    // Cross-field rules local to one tenant: role envs must be declared here,
    // and every user role must exist (there is no default role, S1).
    const aliases = new Set(Object.keys(tenant.environments));
    for (const [roleName, role] of Object.entries(tenant.roles ?? {})) {
      for (const alias of role.environments) {
        if (!aliases.has(alias)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["roles", roleName, "environments"],
            message: `role "${roleName}" references environment "${alias}" which the tenant does not declare`,
          });
        }
      }
    }
    const roleNames = new Set(Object.keys(tenant.roles ?? {}));
    for (const [userId, user] of Object.entries(tenant.users ?? {})) {
      if (!roleNames.has(user.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["users", userId, "role"],
          message: `user "${userId}" references role "${user.role}" which is not defined`,
        });
      }
    }
  });

/** Multi-tenant shape (PRD-feature-multitenant-hosting D-119). */
const tenantsFormSchema = z
  .object({
    tenants: z.record(tenantIdSchema, tenantSchema).refine((map) => Object.keys(map).length > 0, {
      message: "tenants must declare at least one tenant",
    }),
    defaultEnvironment: z.null().optional(),
    defaultLocale: defaultLocaleSchema,
    maxResponseBytes: maxResponseBytesSchema,
  })
  .strict();

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "ssff-mcp", "config.json");
}

/**
 * Validate and normalize a configured https endpoint URL (baseUrl, tokenUrl, idpUrl).
 * Rules: absolute https URL, hostname present, no userinfo, no query, no fragment.
 */
function validateHttpsUrl(raw: string, fieldLabel: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SanitizedError("CONFIG_INVALID", `environment ${fieldLabel} must be a valid absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new SanitizedError("CONFIG_INVALID", `environment ${fieldLabel} must use the https scheme`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new SanitizedError("CONFIG_INVALID", `environment ${fieldLabel} must not contain credentials (userinfo)`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new SanitizedError("CONFIG_INVALID", `environment ${fieldLabel} must not contain a query string or fragment`);
  }
  return url;
}

/**
 * Validate and normalize a configured baseUrl.
 * A path prefix is allowed; trailing slashes are trimmed.
 */
export function normalizeBaseUrl(raw: string): string {
  return validateHttpsUrl(raw, "baseUrl").toString().replace(/\/+$/, "");
}

/** Validate oauth endpoint fields and derive tokenUrl / idpUrl from baseUrl origin when absent. */
function materializeOAuthAuth(
  auth: z.infer<typeof oauthAuthSchema>,
  resolvedPrivateKey: string,
  effectiveBaseUrl: string,
): OAuthAuthConfig {
  const rawTokenUrl = auth.tokenUrl ?? `${effectiveBaseUrl}/oauth/token`;
  const tokenUrl = validateHttpsUrl(rawTokenUrl, "tokenUrl").toString().replace(/\/+$/, "");
  const idpUrl =
    auth.idpUrl !== undefined
      ? validateHttpsUrl(auth.idpUrl, "idpUrl").toString().replace(/\/+$/, "")
      : `${new URL(tokenUrl).origin}/oauth/idp`;
  return {
    type: "oauth",
    clientId: auth.clientId,
    companyId: auth.companyId,
    userId: auth.userId,
    privateKey: resolvedPrivateKey,
    tokenUrl,
    idpUrl,
  };
}

export const SECRET_COMMAND_TIMEOUT_MS = 5000;

export interface SecretResolverOptions {
  env?: NodeJS.ProcessEnv;
  execCommand?: (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
}

export async function resolveSecret(
  secret: SecretProvider,
  options: SecretResolverOptions = {},
): Promise<string> {
  if (typeof secret === "string") {
    return secret;
  }

  if ("fromEnv" in secret) {
    const envObj = options.env ?? process.env;
    const value = envObj[secret.fromEnv];
    if (value === undefined || value.length === 0) {
      throw new SanitizedError(
        "CONFIG_SECRET_MISSING",
        `environment variable "${secret.fromEnv}" for secret is not defined or is empty`,
      );
    }
    return value;
  }

  if ("fromCommand" in secret) {
    const [file, ...args] = secret.fromCommand;
    const execFn =
      options.execCommand ??
      (async (cmdFile, cmdArgs, cmdOpts) => {
        return await execFileAsync(cmdFile, cmdArgs, {
          timeout: cmdOpts.timeout,
          shell: false,
          windowsHide: true,
        });
      });

    let stdout: string;
    try {
      const res = await execFn(file, args, { timeout: SECRET_COMMAND_TIMEOUT_MS });
      stdout = res.stdout;
    } catch (err: unknown) {
      const error = err as { killed?: boolean; code?: string | number } | undefined;
      if (error?.killed || error?.code === "ETIMEDOUT") {
        throw new SanitizedError(
          "CONFIG_SECRET_TIMEOUT",
          `command for resolving secret timed out after ${SECRET_COMMAND_TIMEOUT_MS}ms`,
        );
      }
      throw new SanitizedError(
        "CONFIG_SECRET_COMMAND_FAILED",
        "command for resolving secret failed",
      );
    }

    const trimmed = stdout.replace(/\r?\n$/, "");
    if (trimmed.trim().length === 0) {
      throw new SanitizedError(
        "CONFIG_SECRET_COMMAND_FAILED",
        "command for resolving secret produced empty output",
      );
    }
    return trimmed;
  }

  throw new SanitizedError("CONFIG_INVALID", "unrecognized secret provider shape");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${location}${issue.message}`;
    })
    .join("; ");
}

export interface LoadConfigOptions {
  /** Override the config file location (used by tests). */
  configPath?: string;
  /** Injectable file reader (used by tests). */
  readFile?: (filePath: string) => Promise<string>;
  /** Injectable stat for the permissions warning (used by tests). */
  statFile?: (filePath: string) => Promise<{ mode: number }>;
  /** Receives the loose-permissions warning (defaults to stderr). */
  onWarning?: (message: string) => void;
  /** Platform override for permission checking (used by tests). */
  platform?: NodeJS.Platform;
  /** Environment source for inline mode (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Options for secret resolution (used by tests). */
  secretOptions?: SecretResolverOptions;
  /**
   * Lazy secret resolution (D-42): undefined => resolve every environment
   * (default), null => resolve none, string => resolve only that alias.
   * Skipped environments carry an empty secret and must never be used.
   */
  resolveSecretsFor?: string | null;
  /**
   * Pin the resolution to ONE tenant (D-118): the hosted mode resolves the
   * tenant at the edge and then loads only that tenant's slice, even when the
   * file declares several. Undefined => the stdio rule (exactly one tenant).
   */
  tenantId?: string;
}

interface StatLike {
  mode: number;
}

async function defaultStat(filePath: string): Promise<StatLike> {
  return await fs.stat(filePath);
}

/** True when `value` is a plain object (not null, not an array) with its own `key`. */
function hasOwnKey(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

/** Trimmed non-empty value, or undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Raw non-empty secret value (never trimmed: leading/trailing chars may be significant). */
function present(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize an inline PEM: unescape literal `\n`, or decode a base64-wrapped PEM. */
function normalizeInlinePem(raw: string): string {
  if (raw.includes("-----BEGIN")) {
    return raw.replace(/\\n/g, "\n");
  }
  const decoded = Buffer.from(raw, "base64").toString("utf-8");
  if (decoded.includes("-----BEGIN")) {
    return decoded;
  }
  return raw.replace(/\\n/g, "\n");
}

/** Parse a comma-separated inline entity list (no protocols; trim, drop empties, reject duplicates). */
function parseInlineAllowlist(raw: string | undefined, field: string): AllowlistEntry[] | undefined {
  const value = nonEmpty(raw);
  if (value === undefined) {
    return undefined;
  }
  const entities = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (entities.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const entries: AllowlistEntry[] = [];
  for (const entity of entities) {
    if (!ENTITY_NAME_PATTERN.test(entity)) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        `${field} entity "${entity}" must be an OData entity set name matching ^[A-Za-z_][A-Za-z0-9_]*$`,
      );
    }
    if (seen.has(entity)) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        `${field} contains a duplicate entity entry for "${entity}"`,
      );
    }
    seen.add(entity);
    entries.push({ entity });
  }
  return entries;
}

/** True when inline mode is being requested (SF_BASE_URL or SF_DATACENTER present). */
function inlineRequested(env: NodeJS.ProcessEnv): boolean {
  return nonEmpty(env.SF_BASE_URL) !== undefined || nonEmpty(env.SF_DATACENTER) !== undefined;
}

/**
 * Synthesize a single environment from SF_* process env vars (FR-48/D-45, FR-114/D-88).
 * Used only when no config.json exists; a present file always wins.
 */
function synthesizeInlineConfig(env: NodeJS.ProcessEnv): SsffConfig {
  const rawBaseUrl = nonEmpty(env.SF_BASE_URL);
  const rawDataCenter = nonEmpty(env.SF_DATACENTER);
  const password = present(env.SF_PASSWORD);
  const privateKey = present(env.SF_PRIVATE_KEY);

  let effectiveBaseUrl: string | undefined;
  let canonicalDc: string | undefined;

  if (rawBaseUrl !== undefined) {
    effectiveBaseUrl = normalizeBaseUrl(rawBaseUrl);
    if (rawDataCenter !== undefined) {
      const resolvedDc = resolveDataCenter(rawDataCenter);
      if (resolvedDc !== undefined) {
        canonicalDc = resolvedDc.code;
      }
    }
  } else if (rawDataCenter !== undefined) {
    const resolvedDc = resolveDataCenter(rawDataCenter);
    if (resolvedDc === undefined) {
      const supported = Object.keys(SAP_DATA_CENTERS).join(", ");
      throw new SanitizedError(
        "CONFIG_INVALID",
        `unknown SF_DATACENTER "${rawDataCenter}"; supported data centers: ${supported}`,
      );
    }
    effectiveBaseUrl = resolvedDc.apiBaseUrl;
    canonicalDc = resolvedDc.code;
  }

  if (effectiveBaseUrl === undefined || (password === undefined && privateKey === undefined)) {
    throw new SanitizedError(
      "CONFIG_MISSING",
      `configuration file not found at ${CONFIG_TILDE_PATH}; inline mode requires SF_BASE_URL or SF_DATACENTER plus SF_PASSWORD or SF_PRIVATE_KEY, or copy ${CONFIG_TEMPLATE_NAME} from the ssff-mcp repository to that exact path and fill in the placeholders`,
    );
  }

  const alias = nonEmpty(env.SF_ENVIRONMENT) ?? "default";

  let auth: AuthConfig;
  if (privateKey !== undefined) {
    const clientId = nonEmpty(env.SF_CLIENT_ID);
    const companyId = nonEmpty(env.SF_COMPANY_ID);
    const userId = nonEmpty(env.SF_USER_ID);
    const tokenUrl = nonEmpty(env.SF_TOKEN_URL);
    if (clientId === undefined || companyId === undefined || userId === undefined) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        "inline OAuth requires SF_CLIENT_ID, SF_COMPANY_ID, SF_USER_ID alongside SF_PRIVATE_KEY",
      );
    }
    if (userId.includes("@")) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        "SF_USER_ID must be the technical user id WITHOUT the @companyId suffix",
      );
    }
    const normalizedKey = normalizeInlinePem(privateKey);
    auth = materializeOAuthAuth(
      {
        type: "oauth",
        clientId,
        companyId,
        userId,
        privateKey: normalizedKey,
        tokenUrl,
        idpUrl: nonEmpty(env.SF_IDP_URL),
      },
      normalizedKey,
      effectiveBaseUrl,
    );
  } else {
    const username = nonEmpty(env.SF_USERNAME);
    if (username === undefined) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        "inline basic auth requires SF_USERNAME alongside SF_BASE_URL (or SF_DATACENTER) and SF_PASSWORD",
      );
    }
    auth = { type: "basic", username, password: password! };
  }

  // Inline mode synthesizes exactly one environment, so the inline lists become
  // that environment's lists (FR-28/D-30).
  const entityAllowlist = parseInlineAllowlist(env.SF_ENTITY_ALLOWLIST, "SF_ENTITY_ALLOWLIST");
  const entityDenylist = parseInlineAllowlist(env.SF_ENTITY_DENYLIST, "SF_ENTITY_DENYLIST");
  const inlineEnvironment: EnvironmentConfig = {
    baseUrl: effectiveBaseUrl,
    ...(canonicalDc !== undefined ? { dataCenter: canonicalDc } : {}),
    auth,
  };
  if (entityAllowlist !== undefined) {
    inlineEnvironment.entityAllowlist = entityAllowlist;
  }
  if (entityDenylist !== undefined) {
    inlineEnvironment.entityDenylist = entityDenylist;
  }
  return { tenantId: "default", environments: { [alias]: inlineEnvironment }, inline: true };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<SsffConfig> {
  const filePath = options.configPath ?? defaultConfigPath();
  const readFile = options.readFile ?? ((p: string) => fs.readFile(p, "utf-8"));
  const statFile = options.statFile ?? defaultStat;
  const onWarning = options.onWarning ?? ((message: string) => process.stderr.write(`${message}\n`));
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  let raw: string;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return synthesizeInlineConfig(env);
    }
    throw new SanitizedError("CONFIG_INVALID", `configuration file at ${CONFIG_TILDE_PATH} could not be read`);
  }

  // Permission check: warning only, never a failure.
  try {
    const stats = await statFile(filePath);
    if (platform === "win32") {
      // Once per process: the config is re-read on every tool call, so this
      // would otherwise repeat on each one (A4, PRD-phase3-handoff §4).
      if (!windowsAclWarningEmitted) {
        windowsAclWarningEmitted = true;
        onWarning(
          `ssff-mcp warning: running on Windows; ensure access to ${filePath} is restricted using Windows ACLs`,
        );
      }
    } else if ((stats.mode & 0o077) !== 0) {
      onWarning(
        `ssff-mcp warning: permissions of ${filePath} are broader than owner-only; recommend chmod 600 ${filePath}`,
      );
    }
  } catch {
    // Stat is best-effort; the read already succeeded.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SanitizedError("CONFIG_INVALID", `configuration file at ${CONFIG_TILDE_PATH} is not valid JSON`);
  }

  // The allowlist is per environment (FR-28/D-30). A root-level key is a
  // migration leftover: reject it naming the field and the fix, instead of
  // letting zod report a generic "unrecognized key".
  if (hasOwnKey(parsed, "entityAllowlist")) {
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} is invalid: "entityAllowlist" is no longer supported at the top level; define it inside each environment as environments.<alias>.entityAllowlist`,
    );
  }

  // Shape detection (D-119): the tenants shape wins only when present; the
  // flat shape auto-migrates to a single "default" tenant. Both at once is
  // ambiguous and rejected fail-closed.
  const usingTenantsShape = hasOwnKey(parsed, "tenants");
  if (usingTenantsShape && hasOwnKey(parsed, "environments")) {
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} is invalid: "environments" and "tenants" together is ambiguous; keep the flat shape OR move everything under "tenants"`,
    );
  }

  let tenantId: string;
  let tenantEnvironments: Record<string, z.infer<typeof environmentSchema>>;
  let tenantAllowlist: AllowlistEntry[] | undefined;
  let tenantDenylist: AllowlistEntry[] | undefined;
  let globalLocale: string | undefined;
  let globalMaxBytes: number | undefined;

  if (usingTenantsShape) {
    const parsedTenants = tenantsFormSchema.safeParse(parsed);
    if (!parsedTenants.success) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        `configuration file at ${CONFIG_TILDE_PATH} is invalid: ${sanitizeIssueText(formatIssues(parsedTenants.error))}`,
      );
    }
    const ids = Object.keys(parsedTenants.data.tenants);
    if (options.tenantId !== undefined) {
      // Hosted mode (D-118): the edge already resolved the tenant; load only
      // its slice, regardless of how many the file declares.
      const pinned = parsedTenants.data.tenants[options.tenantId];
      if (pinned === undefined) {
        throw new SanitizedError(
          "CONFIG_INVALID",
          `configuration file at ${CONFIG_TILDE_PATH} does not declare tenant "${options.tenantId}"`,
        );
      }
      tenantId = options.tenantId;
      tenantEnvironments = pinned.environments;
      tenantAllowlist = pinned.entityAllowlist;
      tenantDenylist = pinned.entityDenylist;
      globalLocale = parsedTenants.data.defaultLocale;
      globalMaxBytes = parsedTenants.data.maxResponseBytes;
    } else if (ids.length > 1) {
      // stdio resolves exactly one tenant (D-118); several require `serve`.
      throw new SanitizedError(
        "CONFIG_INVALID",
        `configuration file at ${CONFIG_TILDE_PATH} declares ${ids.length} tenants; this mode resolves exactly one tenant and multiple tenants are served by ssff-mcp serve`,
      );
    } else {
      tenantId = ids[0]!;
      const tenant = parsedTenants.data.tenants[tenantId]!;
      tenantEnvironments = tenant.environments;
      tenantAllowlist = tenant.entityAllowlist;
      tenantDenylist = tenant.entityDenylist;
      globalLocale = parsedTenants.data.defaultLocale;
      globalMaxBytes = parsedTenants.data.maxResponseBytes;
    }
  } else {
    const parsedFlat = configSchema.safeParse(parsed);
    if (!parsedFlat.success) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        `configuration file at ${CONFIG_TILDE_PATH} is invalid: ${sanitizeIssueText(formatIssues(parsedFlat.error))}`,
      );
    }
    tenantId = "default";
    if (options.tenantId !== undefined && options.tenantId !== "default") {
      throw new SanitizedError(
        "CONFIG_INVALID",
        `configuration file at ${CONFIG_TILDE_PATH} does not declare tenant "${options.tenantId}"`,
      );
    }
    tenantEnvironments = parsedFlat.data.environments;
    tenantAllowlist = undefined;
    tenantDenylist = undefined;
    globalLocale = parsedFlat.data.defaultLocale;
    globalMaxBytes = parsedFlat.data.maxResponseBytes;
    if (!legacyShapeWarningEmitted) {
      legacyShapeWarningEmitted = true;
      onWarning(
        `ssff-mcp warning: configuration file at ${CONFIG_TILDE_PATH} uses the legacy flat shape; treating it as a single tenant "default" — wrap it under "tenants" to adopt the multi-tenant shape`,
      );
    }
  }

  const environments: Record<string, EnvironmentConfig> = {};
  const shouldResolve = (alias: string) =>
    options.resolveSecretsFor === undefined || options.resolveSecretsFor === alias;

  for (const [alias, env] of Object.entries(tenantEnvironments)) {
    const resolve = shouldResolve(alias);

    const resolvedDc = env.dataCenter !== undefined ? resolveDataCenter(env.dataCenter) : undefined;
    let effectiveBaseUrl: string;

    if (env.baseUrl !== undefined) {
      effectiveBaseUrl = normalizeBaseUrl(env.baseUrl);
      if (resolvedDc !== undefined && effectiveBaseUrl !== resolvedDc.apiBaseUrl) {
        onWarning(
          `ssff-mcp warning: environment "${alias}" baseUrl "${effectiveBaseUrl}" differs from dataCenter "${env.dataCenter}" default "${resolvedDc.apiBaseUrl}"; baseUrl takes precedence`,
        );
      }
    } else if (resolvedDc !== undefined) {
      effectiveBaseUrl = resolvedDc.apiBaseUrl;
    } else {
      throw new SanitizedError(
        "CONFIG_INVALID",
        `environment "${alias}" must define at least "baseUrl" or "dataCenter"`,
      );
    }

    const canonicalDc = resolvedDc !== undefined ? resolvedDc.code : (env.dataCenter !== undefined ? env.dataCenter.toUpperCase() : undefined);

    if (env.auth.type === "basic") {
      const password = resolve
        ? await resolveSecret(env.auth.password, options.secretOptions)
        : "";
      environments[alias] = {
        baseUrl: effectiveBaseUrl,
        ...(canonicalDc !== undefined ? { dataCenter: canonicalDc } : {}),
        auth: { type: "basic", username: env.auth.username, password },
      };
    } else {
      const privateKey = resolve
        ? await resolveSecret(env.auth.privateKey, options.secretOptions)
        : "";
      environments[alias] = {
        baseUrl: effectiveBaseUrl,
        ...(canonicalDc !== undefined ? { dataCenter: canonicalDc } : {}),
        auth: materializeOAuthAuth(env.auth, privateKey, effectiveBaseUrl),
      };
    }
    // Lists resolve as: per-environment override, else tenant base (D-119).
    // Both keys stay ABSENT when neither configures them. An empty allowlist
    // is preserved as-is: it narrows nothing (it is NOT a deny-all).
    const allowlist = env.entityAllowlist ?? tenantAllowlist;
    const denylist = env.entityDenylist ?? tenantDenylist;
    if (allowlist !== undefined) {
      environments[alias]!.entityAllowlist = allowlist;
    }
    if (denylist !== undefined) {
      environments[alias]!.entityDenylist = denylist;
    }
  }
  const config: SsffConfig = { tenantId, environments };
  if (globalLocale !== undefined) {
    config.defaultLocale = globalLocale;
  }
  if (globalMaxBytes !== undefined) {
    config.maxResponseBytes = globalMaxBytes;
  }

  // A present config.json always wins; make a silently-ignored inline mode explicit.
  if (inlineRequested(env)) {
    onWarning(
      `ssff-mcp warning: inline SF_* environment variables are set but ${CONFIG_TILDE_PATH} exists and takes precedence; inline mode is ignored`,
    );
  }

  return config;
}

/** Collapse whitespace and clamp length of zod issue text (bounded, no body echo). */
function sanitizeIssueText(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 500);
}

/**
 * The key directory for the hosted mode (D-120): tenantId → its key material,
 * WITHOUT resolving any secret. A flat (legacy) file declares no keys, so it
 * yields an empty directory — every hosted request then fails closed at the
 * edge with a pointed message instead of silently authenticating.
 */
export async function loadTenantKeyDirectory(
  options: Pick<LoadConfigOptions, "configPath" | "readFile"> = {},
): Promise<Record<string, { apiKeyHash?: string; environments: Record<string, string | undefined> }>> {
  const filePath = options.configPath ?? defaultConfigPath();
  const readFile = options.readFile ?? ((p: string) => fs.readFile(p, "utf-8"));

  let raw: string;
  try {
    raw = await readFile(filePath);
  } catch {
    throw new SanitizedError("CONFIG_INVALID", `configuration file at ${CONFIG_TILDE_PATH} could not be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SanitizedError("CONFIG_INVALID", `configuration file at ${CONFIG_TILDE_PATH} is not valid JSON`);
  }
  if (!hasOwnKey(parsed, "tenants")) {
    // Flat shape: no hosted keys exist. Fail closed with guidance.
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} has no "tenants" level; hosted mode requires tenants with apiKeyHash`,
    );
  }
  const result = tenantsFormSchema.safeParse(parsed);
  if (!result.success) {
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} is invalid: ${sanitizeIssueText(formatIssues(result.error))}`,
    );
  }
  return projectTenantKeys(result.data.tenants);
}

/** The parsed `tenants` map of the hosted shape. */
type TenantsFormData = z.infer<typeof tenantsFormSchema>["tenants"];

/**
 * tenantId → key material, WITHOUT resolving any secret. Shared by
 * `loadTenantKeyDirectory` and `loadHostedAuthDirectory` so both project the
 * legacy slice identically.
 */
function projectTenantKeys(
  tenants: TenantsFormData,
): Record<string, { apiKeyHash?: string; environments: Record<string, string | undefined> }> {
  const directory: Record<string, { apiKeyHash?: string; environments: Record<string, string | undefined> }> = {};
  for (const [id, tenant] of Object.entries(tenants)) {
    const environments: Record<string, string | undefined> = {};
    for (const [alias, env] of Object.entries(tenant.environments)) {
      environments[alias] = env.apiKeyHash;
    }
    const entry: { apiKeyHash?: string; environments: Record<string, string | undefined> } = { environments };
    if (tenant.apiKeyHash !== undefined) {
      entry.apiKeyHash = tenant.apiKeyHash;
    }
    directory[id] = entry;
  }
  return directory;
}

/**
 * Project one parsed tenant's local auth (S1–S3) into its runtime shape,
 * applying the documented defaults: `enabled` → true, `revoked` → false.
 * Roles and users stay absent-when-absent (empty records), and environment
 * aliases are sorted for deterministic scope intersection.
 */
function toLocalTenantAuth(tenant: {
  environments: Record<string, z.infer<typeof environmentSchema>>;
  roles?: Record<string, z.infer<typeof localRoleSchema>>;
  users?: Record<string, z.infer<typeof localUserSchema>>;
}): LocalTenantAuth {
  const roles: Record<string, LocalRole> = {};
  for (const [name, role] of Object.entries(tenant.roles ?? {})) {
    const projected: LocalRole = { environments: [...role.environments] };
    if (role.entityAllowlist !== undefined) {
      projected.entityAllowlist = role.entityAllowlist;
    }
    if (role.entityDenylist !== undefined) {
      projected.entityDenylist = role.entityDenylist;
    }
    roles[name] = projected;
  }
  const users: Record<string, LocalUser> = {};
  for (const [id, user] of Object.entries(tenant.users ?? {})) {
    users[id] = {
      role: user.role,
      enabled: user.enabled ?? true,
      tokens: user.tokens.map((token) => ({
        id: token.id,
        hash: token.hash,
        expiresAt: token.expiresAt,
        revoked: token.revoked ?? false,
      })),
    };
  }
  return { roles, users, environments: Object.keys(tenant.environments).sort() };
}

/**
 * The whole hosted auth snapshot (S1–S3): reads ONE raw JSON config snapshot
 * and validates both credential spaces WITHOUT resolving any SSFF secret and
 * without network access. The legacy slice matches `loadTenantKeyDirectory`
 * exactly; the local slice carries roles, users and tokens (hashes only).
 *
 * Fail-closed collision gate: ANY duplicated credential hash — a named token
 * hash twice (within one user, across users or across tenants) or a named
 * hash colliding with a legacy key digest — is a CONFIG_INVALID, even when
 * the records are expired, revoked or disabled: a rejected named token must
 * never gain access through another record sharing its hash. Legacy-vs-
 * legacy duplicates keep the existing resolveTenant ambiguity semantics.
 */
export async function loadHostedAuthDirectory(
  options: Pick<LoadConfigOptions, "configPath" | "readFile"> = {},
): Promise<HostedAuthDirectory> {
  const filePath = options.configPath ?? defaultConfigPath();
  const readFile = options.readFile ?? ((p: string) => fs.readFile(p, "utf-8"));

  let raw: string;
  try {
    raw = await readFile(filePath);
  } catch {
    throw new SanitizedError("CONFIG_INVALID", `configuration file at ${CONFIG_TILDE_PATH} could not be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SanitizedError("CONFIG_INVALID", `configuration file at ${CONFIG_TILDE_PATH} is not valid JSON`);
  }
  // Same shape rule as loadTenantKeyDirectory (identical message): the flat
  // shape declares no hosted credentials at all, so it fails closed here too.
  if (!hasOwnKey(parsed, "tenants")) {
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} has no "tenants" level; hosted mode requires tenants with apiKeyHash`,
    );
  }
  const result = tenantsFormSchema.safeParse(parsed);
  if (!result.success) {
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} is invalid: ${sanitizeIssueText(formatIssues(result.error))}`,
    );
  }

  const legacyKeys = projectTenantKeys(result.data.tenants);
  const tenants: Record<string, LocalTenantAuth> = {};
  for (const [id, tenant] of Object.entries(result.data.tenants)) {
    tenants[id] = toLocalTenantAuth(tenant);
  }
  const directory: HostedAuthDirectory = { legacyKeys, tenants, rawConfig: raw };
  if (hasCredentialCollision(directory)) {
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} is invalid: local auth token hashes must be unique across users and tenants and must not collide with legacy API key hashes`,
    );
  }
  return directory;
}
