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
import { SanitizedError } from "./errors.js";

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
  auth: AuthConfig;
}

export interface SsffConfig {
  environments: Record<string, EnvironmentConfig>;
  /**
   * Entity allowlist (FR-28/D-30). The key is ABSENT when no allowlist is
   * configured (no restriction). An empty array IS a configured allowlist
   * and means deny-all (fail-closed).
   */
  entityAllowlist?: AllowlistEntry[];
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
    tokenUrl: z.string().min(1),
    idpUrl: z.string().min(1).optional(),
  })
  .strict();

const authSchema = z.discriminatedUnion("type", [basicAuthSchema, oauthAuthSchema]);

const environmentSchema = z
  .object({
    baseUrl: z.string().min(1),
    auth: authSchema,
  })
  .strict();

const aliasSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "environment alias must be a non-empty string",
});

// OData entity set name (case-sensitive exact match; no predicates here).
const ENTITY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const allowlistProtocolsSchema = z
  .array(z.enum(["v2", "v4"]))
  .min(1, "entityAllowlist protocols must be a non-empty array")
  .refine((protocols) => new Set(protocols).size === protocols.length, {
    message: "entityAllowlist protocols must not contain duplicates",
  });

const allowlistEntrySchema = z
  .object({
    entity: z.string().regex(ENTITY_NAME_PATTERN, {
      message: "entityAllowlist entity must be an OData entity set name matching ^[A-Za-z_][A-Za-z0-9_]*$",
    }),
    protocols: allowlistProtocolsSchema.optional(),
  })
  .strict();

// Duplicate entities are ambiguous (which protocols apply?) => rejected.
const entityAllowlistSchema = z.array(allowlistEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.entity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "entity"],
        message: `entityAllowlist contains a duplicate entity entry for "${entry.entity}"`,
      });
    }
    seen.add(entry.entity);
  }
});

const configSchema = z
  .object({
    environments: z.record(aliasSchema, environmentSchema),
    // Implicit environment selection is forbidden: null/absent only.
    defaultEnvironment: z.null().optional(),
    // Optional entity allowlist (FR-28/D-30): absent => no restriction.
    entityAllowlist: entityAllowlistSchema.optional(),
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

/** Validate oauth endpoint fields and derive idpUrl from the tokenUrl origin when absent. */
function materializeOAuthAuth(
  auth: z.infer<typeof oauthAuthSchema>,
  resolvedPrivateKey: string,
): OAuthAuthConfig {
  const tokenUrl = validateHttpsUrl(auth.tokenUrl, "tokenUrl").toString().replace(/\/+$/, "");
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
}

interface StatLike {
  mode: number;
}

async function defaultStat(filePath: string): Promise<StatLike> {
  return await fs.stat(filePath);
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

/** Parse SF_ENTITY_ALLOWLIST into allowlist entries (no protocols; trim, drop empties, reject duplicates). */
function parseInlineAllowlist(raw: string | undefined): AllowlistEntry[] | undefined {
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
        `SF_ENTITY_ALLOWLIST entity "${entity}" must be an OData entity set name matching ^[A-Za-z_][A-Za-z0-9_]*$`,
      );
    }
    if (seen.has(entity)) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        `SF_ENTITY_ALLOWLIST contains a duplicate entity entry for "${entity}"`,
      );
    }
    seen.add(entity);
    entries.push({ entity });
  }
  return entries;
}

/** True when inline mode is being requested (SF_BASE_URL present). */
function inlineRequested(env: NodeJS.ProcessEnv): boolean {
  return nonEmpty(env.SF_BASE_URL) !== undefined;
}

/**
 * Synthesize a single environment from SF_* process env vars (FR-48/D-45).
 * Used only when no config.json exists; a present file always wins.
 */
function synthesizeInlineConfig(env: NodeJS.ProcessEnv): SsffConfig {
  const baseUrl = nonEmpty(env.SF_BASE_URL);
  const password = present(env.SF_PASSWORD);
  const privateKey = present(env.SF_PRIVATE_KEY);

  if (baseUrl === undefined || (password === undefined && privateKey === undefined)) {
    throw new SanitizedError(
      "CONFIG_MISSING",
      `configuration file not found at ${CONFIG_TILDE_PATH}; inline mode requires SF_BASE_URL plus SF_PASSWORD or SF_PRIVATE_KEY, or copy ${CONFIG_TEMPLATE_NAME} from the ssff-mcp repository to that exact path and fill in the placeholders`,
    );
  }

  const alias = nonEmpty(env.SF_ENVIRONMENT) ?? "default";
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  let auth: AuthConfig;
  if (privateKey !== undefined) {
    const clientId = nonEmpty(env.SF_CLIENT_ID);
    const companyId = nonEmpty(env.SF_COMPANY_ID);
    const userId = nonEmpty(env.SF_USER_ID);
    const tokenUrl = nonEmpty(env.SF_TOKEN_URL);
    if (clientId === undefined || companyId === undefined || userId === undefined || tokenUrl === undefined) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        "inline OAuth requires SF_CLIENT_ID, SF_COMPANY_ID, SF_USER_ID and SF_TOKEN_URL alongside SF_PRIVATE_KEY",
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
    );
  } else {
    const username = nonEmpty(env.SF_USERNAME);
    if (username === undefined) {
      throw new SanitizedError(
        "CONFIG_INVALID",
        "inline basic auth requires SF_USERNAME alongside SF_BASE_URL and SF_PASSWORD",
      );
    }
    auth = { type: "basic", username, password: password! };
  }

  const entityAllowlist = parseInlineAllowlist(env.SF_ENTITY_ALLOWLIST);
  const environments: Record<string, EnvironmentConfig> = {
    [alias]: { baseUrl: normalizedBaseUrl, auth },
  };
  return entityAllowlist === undefined
    ? { environments, inline: true }
    : { environments, entityAllowlist, inline: true };
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
      onWarning(
        `ssff-mcp warning: running on Windows; ensure access to ${CONFIG_TILDE_PATH} is restricted using Windows ACLs`,
      );
    } else if ((stats.mode & 0o077) !== 0) {
      onWarning(
        `ssff-mcp warning: permissions of ${CONFIG_TILDE_PATH} are broader than owner-only; recommend chmod 600 ${CONFIG_TILDE_PATH}`,
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

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new SanitizedError(
      "CONFIG_INVALID",
      `configuration file at ${CONFIG_TILDE_PATH} is invalid: ${sanitizeIssueText(formatIssues(result.error))}`,
    );
  }

  const environments: Record<string, EnvironmentConfig> = {};
  const shouldResolve = (alias: string) =>
    options.resolveSecretsFor === undefined || options.resolveSecretsFor === alias;

  for (const [alias, env] of Object.entries(result.data.environments)) {
    const resolve = shouldResolve(alias);
    if (env.auth.type === "basic") {
      const password = resolve
        ? await resolveSecret(env.auth.password, options.secretOptions)
        : "";
      environments[alias] = {
        baseUrl: normalizeBaseUrl(env.baseUrl),
        auth: { type: "basic", username: env.auth.username, password },
      };
    } else {
      const privateKey = resolve
        ? await resolveSecret(env.auth.privateKey, options.secretOptions)
        : "";
      environments[alias] = {
        baseUrl: normalizeBaseUrl(env.baseUrl),
        auth: materializeOAuthAuth(env.auth, privateKey),
      };
    }
  }
  // entityAllowlist stays absent (key not set) when not configured; an empty
  // array is a configured deny-all allowlist and is preserved as-is.
  const config: SsffConfig =
    result.data.entityAllowlist === undefined
      ? { environments }
      : { environments, entityAllowlist: result.data.entityAllowlist };

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
