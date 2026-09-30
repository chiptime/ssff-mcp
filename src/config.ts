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
import { SanitizedError } from "./errors.js";

/** Literal tilde form used in every user-facing message. */
export const CONFIG_TILDE_PATH = "~/.config/ssff-mcp/config.json";

export const CONFIG_TEMPLATE_NAME = "config.template.json";

export interface BasicAuthConfig {
  type: "basic";
  username: string;
  password: string;
}

export interface EnvironmentConfig {
  /** Normalized base URL: https origin + optional path prefix, no trailing slash. */
  baseUrl: string;
  auth: BasicAuthConfig;
}

export interface SsffConfig {
  environments: Record<string, EnvironmentConfig>;
}

const authSchema = z
  .object({
    type: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

const environmentSchema = z
  .object({
    baseUrl: z.string().min(1),
    auth: authSchema,
  })
  .strict();

const aliasSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "environment alias must be a non-empty string",
});

const configSchema = z
  .object({
    environments: z.record(aliasSchema, environmentSchema),
    // Implicit environment selection is forbidden: null/absent only.
    defaultEnvironment: z.null().optional(),
  })
  .strict();

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "ssff-mcp", "config.json");
}

/**
 * Validate and normalize a configured baseUrl.
 * Rules: absolute https URL, hostname present, no userinfo, no query, no
 * fragment; a path prefix is allowed; trailing slashes are trimmed.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SanitizedError("CONFIG_INVALID", "environment baseUrl must be a valid absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new SanitizedError("CONFIG_INVALID", "environment baseUrl must use the https scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SanitizedError("CONFIG_INVALID", "environment baseUrl must not contain credentials (userinfo)");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new SanitizedError("CONFIG_INVALID", "environment baseUrl must not contain a query string or fragment");
  }
  return url.toString().replace(/\/+$/, "");
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
      auth: { type: "basic", username: env.auth.username, password: env.auth.password },
    };
  }
  return { environments };
}

/** Collapse whitespace and clamp length of zod issue text (bounded, no body echo). */
function sanitizeIssueText(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 500);
}
