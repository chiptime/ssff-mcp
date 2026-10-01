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

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AllowlistEntry } from "./allowlist.js";
import { SanitizedError } from "./errors.js";

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
}

const basicAuthSchema = z
  .object({
    type: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1),
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
    privateKey: z.string().min(1),
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
    privateKey: auth.privateKey,
    tokenUrl,
    idpUrl,
  };
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
}

interface StatLike {
  mode: number;
}

async function defaultStat(filePath: string): Promise<StatLike> {
  return await fs.stat(filePath);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<SsffConfig> {
  const filePath = options.configPath ?? defaultConfigPath();
  const readFile = options.readFile ?? ((p: string) => fs.readFile(p, "utf-8"));
  const statFile = options.statFile ?? defaultStat;
  const onWarning = options.onWarning ?? ((message: string) => process.stderr.write(`${message}\n`));

  let raw: string;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new SanitizedError(
        "CONFIG_MISSING",
        `configuration file not found at ${CONFIG_TILDE_PATH}; copy ${CONFIG_TEMPLATE_NAME} from the ssff-mcp repository to that exact path and fill in the placeholders`,
      );
    }
    throw new SanitizedError("CONFIG_INVALID", `configuration file at ${CONFIG_TILDE_PATH} could not be read`);
  }

  // Permission check: warning only, never a failure.
  try {
    const stats = await statFile(filePath);
    if ((stats.mode & 0o077) !== 0) {
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
  for (const [alias, env] of Object.entries(result.data.environments)) {
    environments[alias] = {
      baseUrl: normalizeBaseUrl(env.baseUrl),
      auth:
        env.auth.type === "basic"
          ? { type: "basic", username: env.auth.username, password: env.auth.password }
          : materializeOAuthAuth(env.auth),
    };
  }
  // entityAllowlist stays absent (key not set) when not configured; an empty
  // array is a configured deny-all allowlist and is preserved as-is.
  if (result.data.entityAllowlist === undefined) {
    return { environments };
  }
  return { environments, entityAllowlist: result.data.entityAllowlist };
}

/** Collapse whitespace and clamp length of zod issue text (bounded, no body echo). */
function sanitizeIssueText(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 500);
}
