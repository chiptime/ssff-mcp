/**
 * Tenant resolution for the hosted (multi-tenant) mode — D-120/FR-158/FR-159
 * of PRD-feature-multitenant-hosting.md.
 *
 * Pure logic, no I/O: the HTTP edge (Bloque 2, `ssff-mcp serve`) builds the
 * key directory from the parsed config, hashes nothing itself and turns a
 * `null` resolution into a 401.
 *
 * Semantics (the "innermost wins" rule the project settled on):
 * - Keys are stored as sha-256 hex digests and compared in constant time.
 * - A per-ENVIRONMENT key reaches only that environment.
 * - A TENANT-level key reaches every environment of that tenant.
 * - Fail-closed: absent/unknown keys resolve to `null`. There is never a
 *   default tenant.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** The key material of one tenant, projected from its config. */
export interface TenantKeys {
  /** Client-wide key digest: reaches every environment of the tenant. */
  apiKeyHash?: string;
  /** Environment alias → per-environment key digest (`undefined` = no key). */
  environments: Record<string, string | undefined>;
}

/** tenantId → key material. */
export type TenantKeyDirectory = Record<string, TenantKeys>;

export interface TenantResolution {
  tenantId: string;
  /** Environment aliases this key may invoke; sorted for determinism. */
  allowedEnvironments: string[];
}

/** sha-256 hex digest of a secret (also used by the future `key hash` helper). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time equality of two hex digests (length mismatch => false). */
function digestEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function resolveTenant(
  directory: TenantKeyDirectory,
  presentedKey: string | undefined,
): TenantResolution | null {
  if (typeof presentedKey !== "string" || presentedKey.length === 0) {
    return null;
  }
  const digest = sha256Hex(presentedKey);

  // Sorted iteration: same directory shape always resolves the same way.
  for (const tenantId of Object.keys(directory).sort()) {
    const tenant = directory[tenantId];
    if (tenant === undefined) {
      continue;
    }
    const aliases = Object.keys(tenant.environments).sort();

    // Innermost first: a per-environment key is more specific than the
    // client-wide one and wins when both would match.
    for (const alias of aliases) {
      const environmentDigest = tenant.environments[alias];
      if (environmentDigest !== undefined && digestEquals(environmentDigest, digest)) {
        return { tenantId, allowedEnvironments: [alias] };
      }
    }

    if (tenant.apiKeyHash !== undefined && digestEquals(tenant.apiKeyHash, digest)) {
      return { tenantId, allowedEnvironments: aliases };
    }
  }

  return null;
}
