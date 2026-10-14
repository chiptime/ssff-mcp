/**
 * `ssff-mcp cache invalidate <alias>` — drops the cached `$metadata` of one
 * environment, or all of them with `--all`.
 *
 * Spec: PRD-feature-metadata-cache-invalidation.md (D-78/D-79, FR-92..FR-98).
 *
 * This runs in its own process, so it can only delete the disk cache. The
 * running MCP server notices on its next metadata read, because
 * `MetadataService` stops trusting its in-memory entry once the file is gone
 * (FR-95). Nothing here touches SuccessFactors: no network, ever (FR-97).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { defaultCacheDir } from "../metadata.js";

export interface CacheInvalidateDeps {
  configPath?: string;
  cacheDir?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

/** Must match `MetadataService`'s naming exactly. */
function cacheFileFor(cacheDir: string, alias: string): string {
  return path.join(cacheDir, `metadata-${encodeURIComponent(alias)}.json`);
}

/** Exit codes: 0 success, 1 config unreadable, 2 usage error (FR-98). */
export async function runCacheInvalidate(
  alias: string | undefined,
  all: boolean,
  deps: CacheInvalidateDeps = {},
): Promise<number> {
  const out = deps.stdout ?? ((message: string) => process.stdout.write(message));
  const err = deps.stderr ?? ((message: string) => process.stderr.write(message));

  let configured: string[];
  try {
    const config = await loadConfig({ configPath: deps.configPath });
    configured = Object.keys(config.environments).sort();
  } catch {
    err("ssff-mcp: the configuration could not be read; nothing was invalidated\n");
    return 1;
  }

  if (!all && alias === undefined) {
    err("ssff-mcp: cache invalidate needs an environment alias, or --all\n");
    return 2;
  }
  // Fail-closed: an unknown alias deletes nothing (FR-94).
  if (!all && alias !== undefined && !configured.includes(alias)) {
    err(`ssff-mcp: unknown environment "${alias}"; configured: ${configured.join(", ") || "(none)"}\n`);
    return 2;
  }

  const cacheDir = deps.cacheDir ?? defaultCacheDir();
  for (const target of all ? configured : [alias as string]) {
    try {
      await fs.rm(cacheFileFor(cacheDir, target));
      out(`invalidated ${target} (${cacheDir})\n`);
    } catch {
      // Already absent: idempotent, still a success.
      out(`nothing to invalidate for ${target} (${cacheDir})\n`);
    }
  }
  out("the running server reloads on its next metadata read\n");
  return 0;
}
