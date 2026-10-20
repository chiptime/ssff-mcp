/**
 * S3 (PRD-feature-multitenant-hosting.md, FR-161/D-121): the $metadata disk
 * cache is namespaced by tenant. Two tenants sharing an environment alias
 * ("prod") must never share a cache entry — on disk or across instances.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MetadataService,
  METADATA_TTL_MS,
  METADATA_DISK_TTL_MS,
  type MetadataServiceOptions,
} from "../src/metadata.js";
import { envTargetFor } from "../src/http.js";
import { recordingFetch, xmlResponse, SAMPLE_METADATA_XML } from "./helpers.js";
import { runCacheInvalidate } from "../src/cli/cache.js";

const ENV = envTargetFor({
  baseUrl: "https://acme.example.com",
  auth: { type: "basic" as const, username: "u", password: "p" },
});

async function tempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("two tenants sharing an alias never share cache entries", async () => {
  const cacheDir = await tempDir("ssff-tenant-cache-");
  let fetches = 0;
  const { fetch } = recordingFetch(() => {
    fetches += 1;
    return xmlResponse(SAMPLE_METADATA_XML);
  });
  let clock = 1_000_000;
  const base = {
    fetchImpl: fetch,
    now: () => clock,
    cacheDir,
    ttlMs: METADATA_TTL_MS,
    diskTtlMs: METADATA_DISK_TTL_MS,
  };

  const acme = new MetadataService({ ...base, tenantId: "acme" } as MetadataServiceOptions);
  const globex = new MetadataService({ ...base, tenantId: "globex" } as MetadataServiceOptions);

  await acme.getParsedMetadata(ENV, "prod");
  await globex.getParsedMetadata(ENV, "prod");
  // One fetch per tenant: globex must NOT reuse acme's entry.
  assert.equal(fetches, 2);

  // Files are namespaced per tenant; the legacy shared name is not used.
  const acmeFile = JSON.parse(
    await fs.readFile(path.join(cacheDir, "metadata-acme-prod.json"), "utf8"),
  ) as { fetchedAt: number };
  assert.equal(typeof acmeFile.fetchedAt, "number");
  await assert.rejects(() => fs.readFile(path.join(cacheDir, "metadata-prod.json"), "utf8"));

  // A brand-new instance of tenant acme reuses ONLY acme's file.
  const acmeAgain = new MetadataService({ ...base, tenantId: "acme" } as MetadataServiceOptions);
  await acmeAgain.getParsedMetadata(ENV, "prod");
  assert.equal(fetches, 2);
});

test("an omitted tenantId falls back to the default namespace", async () => {
  const cacheDir = await tempDir("ssff-tenant-cache-default-");
  let fetches = 0;
  const { fetch } = recordingFetch(() => {
    fetches += 1;
    return xmlResponse(SAMPLE_METADATA_XML);
  });
  const service = new MetadataService({ fetchImpl: fetch, now: () => 1_000_000, cacheDir });
  await service.getParsedMetadata(ENV, "prod");
  assert.equal(fetches, 1);
  await fs.access(path.join(cacheDir, "metadata-default-prod.json"));
});

test("cache invalidate deletes the tenant-scoped file and only that one", async () => {
  const dir = await tempDir("ssff-tenant-invalidate-");
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      tenants: {
        acme: {
          environments: {
            dev: { baseUrl: "https://acme.example.com", auth: { type: "basic", username: "u", password: "p" } },
          },
        },
      },
    }),
    "utf8",
  );
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, "metadata-acme-dev.json"), "{}", "utf8");
  await fs.writeFile(path.join(cacheDir, "metadata-other-dev.json"), "{}", "utf8");

  const out: string[] = [];
  const code = await runCacheInvalidate("dev", false, {
    configPath,
    cacheDir,
    stdout: (m) => out.push(m),
  });
  assert.equal(code, 0);
  // acme's entry is gone; another tenant's same-alias entry is untouched.
  await assert.rejects(() => fs.access(path.join(cacheDir, "metadata-acme-dev.json")));
  await fs.access(path.join(cacheDir, "metadata-other-dev.json"));
  assert.ok(out.some((line) => line.includes("invalidated dev")));
});

const MULTI_TENANT_CONFIG = {
  tenants: {
    acme: {
      environments: {
        dev: { baseUrl: "https://acme.example.com", auth: { type: "basic", username: "u", password: "p" } },
      },
    },
    globex: {
      environments: {
        dev: { baseUrl: "https://globex.example.com", auth: { type: "basic", username: "u", password: "p" } },
      },
    },
  },
};

test("--tenant invalidates one tenant's entry of a multi-tenant config", async () => {
  const dir = await tempDir("ssff-tenant-invalidate-pinned-");
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify(MULTI_TENANT_CONFIG), "utf8");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, "metadata-acme-dev.json"), "{}", "utf8");
  await fs.writeFile(path.join(cacheDir, "metadata-globex-dev.json"), "{}", "utf8");

  const out: string[] = [];
  const code = await runCacheInvalidate("dev", false, { configPath, cacheDir, stdout: (m) => out.push(m) }, "globex");
  assert.equal(code, 0);
  await assert.rejects(() => fs.access(path.join(cacheDir, "metadata-globex-dev.json")));
  await fs.access(path.join(cacheDir, "metadata-acme-dev.json"));
  assert.ok(out.some((line) => line.includes("invalidated dev")));
});

test("multi-tenant config without --tenant reports the real cause and the hint", async () => {
  const dir = await tempDir("ssff-tenant-invalidate-hint-");
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify(MULTI_TENANT_CONFIG), "utf8");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, "metadata-acme-dev.json"), "{}", "utf8");

  const errs: string[] = [];
  const code = await runCacheInvalidate("dev", false, { configPath, cacheDir, stderr: (m) => errs.push(m) });
  assert.equal(code, 1);
  // Nothing was deleted...
  await fs.access(path.join(cacheDir, "metadata-acme-dev.json"));
  // ...the underlying cause is visible, and the remediation is named.
  assert.ok(errs.some((line) => line.includes("declares 2 tenants")));
  assert.ok(errs.some((line) => line.includes("--tenant")));
});

test("an unknown --tenant is named in the error", async () => {
  const dir = await tempDir("ssff-tenant-invalidate-unknown-");
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify(MULTI_TENANT_CONFIG), "utf8");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(cacheDir);

  const errs: string[] = [];
  const code = await runCacheInvalidate("dev", false, { configPath, cacheDir, stderr: (m) => errs.push(m) }, "nope");
  assert.equal(code, 1);
  assert.ok(errs.some((line) => line.includes('does not declare tenant "nope"')));
});

test("cache invalidate never needs secret resolution", async () => {
  const dir = await tempDir("ssff-tenant-invalidate-nosecrets-");
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      environments: {
        dev: {
          baseUrl: "https://acme.example.com",
          auth: { type: "basic", username: "u", password: { fromEnv: "SSFF_UAT_MISSING_SECRET_VAR" } },
        },
      },
    }),
    "utf8",
  );
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, "metadata-default-dev.json"), "{}", "utf8");

  const out: string[] = [];
  const code = await runCacheInvalidate("dev", false, { configPath, cacheDir, stdout: (m) => out.push(m) });
  assert.equal(code, 0);
  await assert.rejects(() => fs.access(path.join(cacheDir, "metadata-default-dev.json")));
  assert.ok(out.some((line) => line.includes("invalidated dev")));
});
