import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli/init.js";
import { sha256Hex } from "../src/tenancy.js";

// The compiled CLI this suite exercises (dist/test/ -> dist/src/index.js).
const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Scratch HOME so the subprocesses never touch the developer's real config.
const home = mkdtempSync(join(tmpdir(), "ssff-keygen-"));
const env = { ...process.env, HOME: home, PORT: "" };

after(() => {
  rmSync(home, { recursive: true, force: true });
});

interface GenerateOutput {
  token: string;
  tokenHash: string;
}

function runGenerate(): GenerateOutput {
  const result = spawnSync(process.execPath, [cli, "key", "generate"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as GenerateOutput;
}

test("key generate prints exactly one JSON line with a 32-byte base64url token and its sha-256 hash", () => {
  const result = spawnSync(process.execPath, [cli, "key", "generate"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  // Exactly one line of stdout, newline-terminated: the secret appears once.
  assert.equal(result.stdout.split("\n").length, 2);
  const parsed = JSON.parse(result.stdout) as GenerateOutput;
  assert.deepEqual(Object.keys(parsed), ["token", "tokenHash"]);
  // Shape: ssff_pat_ + base64url(32 random bytes) = 43 unpadded characters.
  assert.match(parsed.token, /^ssff_pat_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(parsed.token.slice("ssff_pat_".length), "base64url").length, 32);
  assert.equal(parsed.tokenHash, sha256Hex(parsed.token));
});

test("two generations never repeat: tokens and hashes differ", () => {
  const first = runGenerate();
  const second = runGenerate();
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, second.tokenHash);
});

test("generated token hashes identically through the public key-hash command", () => {
  const { token, tokenHash } = runGenerate();
  const hashed = spawnSync(process.execPath, [cli, "key", "hash"], {
    input: token, encoding: "utf8", env,
  });
  assert.equal(hashed.status, 0, hashed.stderr);
  assert.equal(hashed.stdout, `${tokenHash}\n`);
});

test("key generate rejects every unexpected flag or argument without generating a token", () => {
  for (const args of [["--json"], ["extra"], ["--length", "64"], ["-x"], ["--", "-x"]]) {
    const result = spawnSync(process.execPath, [cli, "key", ...args], { encoding: "utf8", env });
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.match(result.stderr, /unknown command "key"/, args.join(" "));
  }
});

test("key hash stays stdin-only with unchanged digest and whitespace/error behavior", () => {
  const ok = spawnSync(process.execPath, [cli, "key", "hash"], {
    input: "legacy-key\n", encoding: "utf8", env,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${sha256Hex("legacy-key")}\n`);
  const padded = spawnSync(process.execPath, [cli, "key", "hash"], {
    input: " legacy-key \n", encoding: "utf8", env,
  });
  assert.equal(padded.status, 2);
  assert.match(padded.stderr, /without surrounding whitespace/);
  const empty = spawnSync(process.execPath, [cli, "key", "hash"], { input: "", encoding: "utf8", env });
  assert.equal(empty.status, 2);
});

test("parseCliArgs accepts exactly `key generate` and `key hash`; everything else stays unknown", () => {
  assert.deepEqual(parseCliArgs(["key", "generate"]), { kind: "key-generate" });
  assert.deepEqual(parseCliArgs(["key", "hash"]), { kind: "key-hash" });
  for (const args of [["key"], ["key", "generate", "x"], ["key", "generate", "--foo"],
    ["key", "hash", "x"], ["key", "hash", "generate"], ["key", "bogus"]]) {
    assert.equal(parseCliArgs(args).kind, "unknown", args.join(" "));
  }
});
