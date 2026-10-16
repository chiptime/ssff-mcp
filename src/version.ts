/**
 * The single source of truth for the version this server advertises.
 *
 * It is read from the shipped `package.json` at runtime rather than imported:
 * `resolveJsonModule` is not enabled, and enabling it would pull the manifest
 * into the TypeScript emit graph and add a second `package.json` under `dist/`.
 *
 * `PACKAGE_VERSION` falls back to `"unknown"` when the manifest cannot be read,
 * so a packaging accident degrades visibly instead of crashing the server.
 */

import { readFileSync } from "node:fs";

function readPackageVersion(): string | undefined {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Package version, for example `0.4.0`; `"unknown"` when the manifest is unreadable. */
export const PACKAGE_VERSION: string = readPackageVersion() ?? "unknown";
