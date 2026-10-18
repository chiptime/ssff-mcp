import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli/init.js";
import { sha256Hex } from "../src/tenancy.js";

test("serve flags are parsed in both value forms and local no-args stays local", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "serve" });
  assert.deepEqual(parseCliArgs(["serve", "--port=9090", "--host", "127.0.0.1", "--config", "/config.json"]),
    { kind: "serve-http", port: 9090, host: "127.0.0.1", configPath: "/config.json" });
});

test("serve rejects invalid, duplicate, missing and unknown options instead of silently ignoring them", () => {
  for (const args of [["--port", "bad"], ["--port"], ["--port", "-1"], ["--host"],
    ["--config="], ["--port", "8080", "--port", "9090"], ["--typo", "x"], ["unexpected"]]) {
    assert.equal(parseCliArgs(["serve", ...args]).kind, "unknown", args.join(" "));
  }
});

test("key hash reads stdin, prints only the digest and never echoes the key", () => {
  const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
  const secret = "test-key-not-for-logs";
  const result = spawnSync(process.execPath, [cli, "key", "hash"], {
    input: `${secret}\n`, encoding: "utf8", env: { ...process.env, PORT: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${sha256Hex(secret)}\n`);
  assert.ok(!result.stderr.includes(secret));
  const empty = spawnSync(process.execPath, [cli, "key", "hash"], { input: "", encoding: "utf8" });
  assert.equal(empty.status, 2);
});
