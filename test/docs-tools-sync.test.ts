/**
 * Keeps docs/tools.md in sync with the tool catalog.
 *
 * The tool names, titles, descriptions and argument tables are a generated
 * artifact of src/tool-catalog.ts; this fails when the committed document has
 * drifted (for example, after renaming a tool or adding an argument). Fix with
 * `pnpm docs:gen`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS_MARKER_END, TOOLS_MARKER_START, replaceToolsSection } from "../src/tool-doc.js";
import { TOOL_CATALOG } from "../src/tool-catalog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const docPath = path.join(repoRoot, "docs", "tools.md");

function readDoc(): string {
  return readFileSync(docPath, "utf8");
}

test("docs/tools.md is present and carries the generation markers", () => {
  const doc = readDoc();
  assert.ok(doc.includes(TOOLS_MARKER_START), "missing START marker");
  assert.ok(doc.includes(TOOLS_MARKER_END), "missing END marker");
  assert.ok(doc.indexOf(TOOLS_MARKER_START) < doc.indexOf(TOOLS_MARKER_END), "markers are out of order");
});

test("docs/tools.md matches the generated tools section (run `pnpm docs:gen`)", () => {
  const doc = readDoc();
  assert.equal(doc, replaceToolsSection(doc), "docs/tools.md is stale; run `pnpm docs:gen`");
});

test("every catalogued tool is documented with its arguments", () => {
  const doc = readDoc();
  for (const tool of TOOL_CATALOG) {
    assert.ok(doc.includes(`### \`${tool.name}\``), `docs/tools.md is missing the tool "${tool.name}"`);
  }
});

test("exactly the catalogued tools are documented (no stale tool names)", () => {
  const documented = [...readDoc().matchAll(/^### `([a-z_]+)`$/gm)].map((match) => match[1]);
  assert.deepEqual(documented, TOOL_CATALOG.map((tool) => tool.name));
});
