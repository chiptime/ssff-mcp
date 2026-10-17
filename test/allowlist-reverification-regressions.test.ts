import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseExpand } from "../src/expand.js";

/**
 * Regressions found by an independent re-verification of the navigation/expand
 * enforcement. Both were introduced by the strict parsing that closed the
 * `$select` bypasses; neither may survive as a legitimate-query regression.
 */

test("S6/S8 and O2: a plain $select list accepts whitespace around its commas", () => {
  for (const expand of [
    "manager($select=a,b)",
    "manager($select=a, b)",
    "manager($select=a ,b)",
    "manager($select= a , b )",
    "manager($select=cust_employeeId , cust_costCenter_1)",
  ]) {
    assert.deepEqual(parseExpand(expand), { ok: true, routes: [["manager"]] }, expand);
  }
});

test("whitespace is tolerated around separators in every position", () => {
  assert.deepEqual(parseExpand(" a , b / c "), { ok: true, routes: [["a"], ["b", "c"]] });
  assert.deepEqual(parseExpand("a( $select = x , y ; $expand = b )"), {
    ok: true,
    routes: [["a"], ["a", "b"]],
  });
});

test("B4/D-112: every $levels mention states that it is rejected", () => {
  const prd = readFileSync(
    new URL("../../PRD-feature-allowlist-vectors.md", import.meta.url),
    "utf8",
  );
  assert.ok(prd.includes("`$levels` NO se soporta"));
  const mentions = prd.split("\n").filter((line) => line.includes("$levels"));
  assert.ok(mentions.length > 0, "expected the PRD to address $levels");
  for (const line of mentions) {
    // Mentioning it is fine; claiming support is not. Every mention must say so.
    assert.match(line, /NO se soporta|Rechaza|se rechaza/, line);
  }
});
