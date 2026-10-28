/**
 * Published type declarations (odd/tasks/catalog-readiness.md, S3): the
 * package advertises a small, type-only contract — the config file shape and
 * the tool argument shapes — that a consumer can `import type` and compile,
 * while the CLI entry point stays the only runtime surface.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// dist/test/<file>.js -> repository root
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Manifest {
  types?: string;
  main?: string;
  exports?: unknown;
  bin?: Record<string, string>;
  files?: string[];
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf-8")) as Manifest;
}

const CONSUMER = `import type {
  BatchGetArguments,
  ConfigFile,
  FlatConfigFile,
  InspectEntityArguments,
  ListEnvironmentsArguments,
  QueryEntityArguments,
  ResolvePicklistArguments,
  SecretProvider,
  TenantsConfigFile,
} from "ssff-mcp";

const secret: SecretProvider = { fromEnv: "SF_PASSWORD" };

const flat: FlatConfigFile = {
  environments: {
    prod: {
      baseUrl: "https://api4.successfactors.com",
      auth: { type: "basic", username: "apiuser@company", password: secret },
      entityAllowlist: [{ entity: "User", fields: ["userId"] }],
    },
  },
  defaultLocale: "es_ES",
};

const tenants: TenantsConfigFile = {
  tenants: {
    acme: {
      environments: {
        dev: {
          dataCenter: "DC4",
          auth: { type: "oauth", clientId: "c", companyId: "acme", userId: "u", privateKey: { fromCommand: ["pass", "sf"] } },
        },
      },
    },
  },
};

const either: ConfigFile[] = [flat, tenants];

const query: QueryEntityArguments = { environment: "prod", entityPath: "EmpJob", select: "userId", top: 5, asOfDate: "2026-01-01" };
const batch: BatchGetArguments = { requests: [{ entityPath: "User" }, query] , output: "json" };
const inspect: InspectEntityArguments = { entitySet: "EmpJob" };
const list: ListEnvironmentsArguments = {};
const picklist: ResolvePicklistArguments = { picklistId: "maritalStatus" };

// The types are real contracts, not \`any\`: each line below must be rejected.
// @ts-expect-error unknown auth type
const badAuth: FlatConfigFile = { environments: { p: { baseUrl: "https://x", auth: { type: "token", username: "u", password: "p" } } } };
// @ts-expect-error entityPath is required
const badQuery: QueryEntityArguments = { environment: "prod" };
// @ts-expect-error output is json or xml only
const badBatch: BatchGetArguments = { requests: [{ entityPath: "User" }], output: "csv" };

export { either, batch, inspect, list, picklist, badAuth, badQuery, badBatch };
`;

async function compileConsumer(moduleResolution: "nodenext" | "bundler"): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-types-consumer-"));
  try {
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.symlink(ROOT, path.join(dir, "node_modules", "ssff-mcp"), "junction");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
    await fs.writeFile(path.join(dir, "consumer.ts"), CONSUMER);
    const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
    const args = [
      tsc, "--noEmit", "--strict", "--skipLibCheck", "false", "--target", "ES2022",
      "--module", moduleResolution === "nodenext" ? "nodenext" : "esnext",
      "--moduleResolution", moduleResolution, "--types", "node",
      "--typeRoots", path.join(ROOT, "node_modules", "@types"),
      path.join(dir, "consumer.ts"),
    ];
    try {
      await execFileAsync(process.execPath, args, { cwd: dir });
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      assert.fail(`consumer did not compile with ${moduleResolution}:\n${stdout ?? ""}${stderr ?? ""}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("package.json advertises a types entry that exists and ships inside the published files", async () => {
  const pkg = await manifest();
  assert.equal(pkg.types, "dist/src/types.d.ts");
  await fs.access(path.join(ROOT, pkg.types!));
  assert.ok(pkg.files?.includes("dist/src"), "declarations live under the published dist/src");
});

test("the CLI stays the only runtime surface: bin unchanged, no main or exports map", async () => {
  const pkg = await manifest();
  assert.deepEqual(pkg.bin, { "ssff-mcp": "dist/src/index.js" });
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.exports, undefined, "an exports map would break existing deep imports");
});

test("the types module is type-only: importing it has no runtime exports or side effects", async () => {
  const mod = (await import(pathToFileURL(path.join(ROOT, "dist", "src", "types.js")).href)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(mod), []);
});

test("a consumer can import type the config and tool argument contracts and compile (nodenext)", async () => {
  await compileConsumer("nodenext");
});

test("a consumer can import type the config and tool argument contracts and compile (bundler)", async () => {
  await compileConsumer("bundler");
});
