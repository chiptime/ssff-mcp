/**
 * scripts/run-tests.mjs: the cross-Node test entry point used by `pnpm test`
 * and CI. It must forward arguments and never hide a failure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("the compiled-test runner forwards arguments and preserves failure statuses", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "ssff-mcp-runner-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, "dist", "test"), { recursive: true });
  const runner = fileURLToPath(new URL("../../scripts/run-tests.mjs", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [runner, ...args], { cwd, encoding: "utf8" });

  const empty = run();
  assert.equal(empty.status, 1);
  assert.equal(empty.stderr.trim(), "no compiled test files found in dist/test; run the build first");

  const fixture = path.join(cwd, "dist", "test", "probe.test.js");
  writeFileSync(fixture, 'throw new Error("INJECTED");');
  const failed = run("--test-reporter=tap");
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /TAP version/);
  assert.match(failed.stdout, /INJECTED/);

  writeFileSync(fixture, "");
  assert.equal(run().status, 0);

  const option = "--invalid-runner-probe";
  const direct = spawnSync(process.execPath, ["--test", option]);
  assert.notEqual(direct.status, 0);
  assert.equal(run(option).status, direct.status);
});
