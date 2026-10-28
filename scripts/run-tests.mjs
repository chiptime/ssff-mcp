#!/usr/bin/env node
// Runs the compiled test files with the built-in test runner.
//
// `node --test dist/test/` accepts a directory on Node 20 and on recent Node
// releases, but Node 22 treats it as a module path; shell globs are not
// expanded on Windows either. Listing the files explicitly works everywhere.
// Extra arguments are forwarded to `node --test` (e.g. --test-reporter=spec).

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const dir = path.join("dist", "test");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(dir, name));

if (files.length === 0) {
  console.error("no compiled test files found in dist/test; run the build first");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
