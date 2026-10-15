#!/usr/bin/env node
/**
 * Regenerates the "tools" section of docs/tools.md from src/tool-doc.ts.
 *
 * Usage: pnpm docs:gen  (builds first, then runs this)
 * The committed docs/tools.md must match this output;
 * test/docs-tools-sync.test.ts fails when it drifts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { replaceToolsSection } from "../dist/src/tool-doc.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(root, "docs", "tools.md");

const original = readFileSync(docPath, "utf8");
const updated = replaceToolsSection(original);

if (updated === original) {
  console.log("docs/tools.md is already up to date");
} else {
  writeFileSync(docPath, updated);
  console.log(`updated ${path.relative(root, docPath)}`);
}
