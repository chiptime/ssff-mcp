/**
 * `ssff-mcp init` CLI (FR-51 / D-51): argv dispatch, config building and
 * safe on-disk writes (atomic temp+rename, mode 0600, `.bak` backup).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { autocompleteMultiselect, cancel, confirm, intro, isCancel, note, outro, password, select, spinner, text } from "@clack/prompts";
import { defaultConfigPath, normalizeBaseUrl, type EnvironmentConfig } from "../config.js";
import { CLIENTS, renderClientBlock, type ClientId } from "./clients.js";
import { discoverEntities } from "./discovery.js";

export type CliCommand =
  | { kind: "serve" }
  | { kind: "init" }
  | { kind: "cache-invalidate"; alias?: string; all: boolean }
  | { kind: "help" }
  | { kind: "unknown"; arg: string };

export interface ConfigAnswers {
  authType: "basic" | "oauth";
  alias: string;
  baseUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
  companyId?: string;
  userId?: string;
  tokenUrl?: string;
  privateKey?: string;
  allowlist?: string[];
}

export interface RunInitDeps {
  isTTY?: boolean;
  configPath?: string;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const first = argv[0];
  if (first === undefined) {
    return { kind: "serve" };
  }
  if (first === "init") {
    return { kind: "init" };
  }
  if (first === "cache") {
    const action = argv[1];
    if (action === "invalidate") {
      const rest = argv.slice(2);
      if (rest.includes("--all")) {
        return { kind: "cache-invalidate", all: true };
      }
      const alias = rest.find((value) => !value.startsWith("-"));
      return { kind: "cache-invalidate", all: false, alias };
    }
    return { kind: "unknown", arg: `cache ${action ?? ""}`.trim() };
  }
  if (first === "help" || first === "--help" || first === "-h") {
    return { kind: "help" };
  }
  return { kind: "unknown", arg: first };
}

export function buildConfigFromAnswers(answers: ConfigAnswers): Record<string, unknown> {
  const auth =
    answers.authType === "basic"
      ? { type: "basic", username: answers.username ?? "", password: answers.password ?? "" }
      : {
          type: "oauth",
          clientId: answers.clientId ?? "",
          companyId: answers.companyId ?? "",
          userId: answers.userId ?? "",
          privateKey: answers.privateKey ?? "",
          tokenUrl: answers.tokenUrl ?? "",
        };
  const environment: Record<string, unknown> = { baseUrl: answers.baseUrl, auth };
  // The allowlist is per environment (FR-28/D-30): an empty selection is still
  // an explicit configuration and is written as a deny-all for this environment.
  if (answers.allowlist !== undefined) {
    environment.entityAllowlist = answers.allowlist.map((entity) => ({ entity }));
  }
  return {
    environments: { [answers.alias]: environment },
    defaultEnvironment: null,
  };
}

/** Write `contents` to `filePath` atomically: temp file (0600) + rename, no TOCTOU window. */
export async function writeConfigAtomic(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/** Copy an existing config to `<file>.bak`; returns the backup path, or undefined when absent. */
export async function backupExisting(filePath: string): Promise<string | undefined> {
  try {
    await fs.access(filePath);
  } catch {
    return undefined;
  }
  const bak = `${filePath}.bak`;
  await fs.copyFile(filePath, bak);
  return bak;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Materialize the internal EnvironmentConfig from wizard answers (used for live discovery). */
function environmentFromAnswers(answers: ConfigAnswers): EnvironmentConfig {
  const baseUrl = normalizeBaseUrl(answers.baseUrl);
  if (answers.authType === "basic") {
    return {
      baseUrl,
      auth: { type: "basic", username: answers.username ?? "", password: answers.password ?? "" },
    };
  }
  const tokenUrl = (answers.tokenUrl ?? "").replace(/\/+$/, "");
  const idpUrl = tokenUrl.length > 0 ? `${new URL(tokenUrl).origin}/oauth/idp` : "";
  return {
    baseUrl,
    auth: {
      type: "oauth",
      clientId: answers.clientId ?? "",
      companyId: answers.companyId ?? "",
      userId: answers.userId ?? "",
      privateKey: (answers.privateKey ?? "").replace(/\\n/g, "\n"),
      tokenUrl,
      idpUrl,
    },
  };
}

/**
 * Live discovery with retry (FR-52/FR-53). Returns the selected entities, `[]`
 * when the tenant exposes none, or undefined when the user cancels.
 */
async function runDiscoveryWithRetry(
  environment: EnvironmentConfig,
  alias: string,
): Promise<string[] | undefined> {
  for (;;) {
    const spin = spinner();
    spin.start("Connecting to SuccessFactors and fetching the entity catalog...");
    try {
      const entities = await discoverEntities({ environment, alias });
      spin.stop(`Entity catalog retrieved (${entities.length} entity sets)`);
      if (entities.length === 0) {
        note("No entity sets were returned; the allowlist will not be restricted.");
        return [];
      }
      const selected = await autocompleteMultiselect({
        message: "Select allowed entities (type to filter)",
        options: entities.map((name) => ({ value: name, label: name })),
        required: false,
      });
      if (isCancel(selected)) {
        return undefined;
      }
      return selected as string[];
    } catch (error) {
      spin.stop("Connection failed");
      const message = error instanceof Error ? error.message : String(error);
      const retry = await confirm({ message: `Discovery failed: ${message}. Retry?`, initialValue: true });
      if (isCancel(retry) || retry !== true) {
        return undefined;
      }
    }
  }
}

/** Interactive answer collection (T3 basic/OAuth; discovery and allowlist are T4). */
async function collectAnswers(): Promise<{ answers: ConfigAnswers; client: ClientId } | undefined> {
  const authType = await select({
    message: "Authentication type",
    options: [
      { value: "basic", label: "Basic Auth" },
      { value: "oauth", label: "OAuth 2.0" },
    ],
  });
  if (isCancel(authType)) {
    return undefined;
  }

  const alias = await text({ message: "Environment alias", defaultValue: "prod", placeholder: "prod" });
  if (isCancel(alias)) {
    return undefined;
  }

  const baseUrl = await text({
    message: "Tenant base URL (https, no trailing slash)",
    placeholder: "https://api2.successfactors.eu",
    validate: (value) => {
      if (!value) {
        return "base URL is required";
      }
      try {
        const url = new URL(value);
        if (url.protocol !== "https:") {
          return "must use the https scheme";
        }
      } catch {
        return "must be a valid absolute URL";
      }
      if (value.endsWith("/")) {
        return "remove the trailing slash";
      }
      return undefined;
    },
  });
  if (isCancel(baseUrl)) {
    return undefined;
  }

  const answers: ConfigAnswers = {
    authType: authType as "basic" | "oauth",
    alias: (alias as string).trim() || "prod",
    baseUrl: (baseUrl as string).trim(),
  };

  if (answers.authType === "basic") {
    const username = await text({ message: "API username", placeholder: "user@companyId" });
    if (isCancel(username)) {
      return undefined;
    }
    const pw = await password({ message: "API password" });
    if (isCancel(pw)) {
      return undefined;
    }
    answers.username = username as string;
    answers.password = pw as string;
  } else {
    const clientId = await text({ message: "OAuth client id (API key)" });
    if (isCancel(clientId)) {
      return undefined;
    }
    const companyId = await text({ message: "Company id" });
    if (isCancel(companyId)) {
      return undefined;
    }
    const userId = await text({ message: "Technical user id (WITHOUT the @companyId suffix)" });
    if (isCancel(userId)) {
      return undefined;
    }
    const tokenUrl = await text({
      message: "Token URL",
      placeholder: "https://api2.successfactors.eu/oauth/token",
    });
    if (isCancel(tokenUrl)) {
      return undefined;
    }
    const privateKey = await text({
      message: "RSA private key (PEM; use \\n escapes if pasted on a single line)",
    });
    if (isCancel(privateKey)) {
      return undefined;
    }
    answers.clientId = clientId as string;
    answers.companyId = companyId as string;
    answers.userId = userId as string;
    answers.tokenUrl = tokenUrl as string;
    answers.privateKey = privateKey as string;
  }

  const restrict = await confirm({ message: "Restrict access with an entity allowlist?", initialValue: false });
  if (isCancel(restrict)) {
    return undefined;
  }
  if (restrict === true) {
    const entities = await runDiscoveryWithRetry(environmentFromAnswers(answers), answers.alias);
    if (entities === undefined) {
      return undefined;
    }
    if (entities.length > 0) {
      answers.allowlist = entities;
    }
  }

  const client = await select({
    message: "Generate the configuration block for which client?",
    options: [
      ...CLIENTS.map((descriptor) => ({ value: descriptor.id, label: descriptor.label })),
      { value: "none", label: "None" },
    ],
  });
  if (isCancel(client)) {
    return undefined;
  }
  return { answers, client: client as ClientId };
}

export async function runInit(deps: RunInitDeps = {}): Promise<number> {
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const stderr = deps.stderr ?? ((message: string) => process.stderr.write(message));
  const stdout = deps.stdout ?? ((message: string) => process.stdout.write(message));
  const configPath = deps.configPath ?? defaultConfigPath();

  if (!isTTY) {
    stderr("ssff-mcp init requires an interactive terminal (TTY); run it directly in your shell\n");
    return 2;
  }

  intro("ssff-mcp init");
  const collected = await collectAnswers();
  if (collected === undefined) {
    cancel("Cancelled; nothing was written");
    return 130;
  }

  if (await fileExists(configPath)) {
    const ok = await confirm({ message: `${configPath} exists; overwrite it (a .bak backup will be kept)?` });
    if (isCancel(ok) || ok !== true) {
      cancel("Cancelled; the existing configuration was left untouched");
      return 130;
    }
    await backupExisting(configPath);
  }

  const config = buildConfigFromAnswers(collected.answers);
  await writeConfigAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const descriptor = CLIENTS.find((candidate) => candidate.id === collected.client);
  if (descriptor !== undefined) {
    const block = renderClientBlock(collected.client, { env: {} });
    stdout(`\nConfiguration written to ${configPath}\n\nAdd this block to ${descriptor.configPath}:\n\n${block}\n`);
  } else {
    stdout(`\nConfiguration written to ${configPath}\n`);
  }
  outro("Done");
  return 0;
}
