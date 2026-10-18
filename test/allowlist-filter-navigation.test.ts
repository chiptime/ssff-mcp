import test from "node:test";
import assert from "node:assert/strict";
import { expressionReferences } from "../src/allowlist-navigation.js";

/**
 * A denied entity must be unreachable through ANY query option, so references are
 * extracted per IDENTIFIER rather than per pattern: a path (`A/B`) is walked, and
 * a bare identifier matters when it happens to be a NavigationProperty
 * (`$select=empInfo`, `$filter=empInfo ne null`).
 *
 * Operators (`eq`, `ne`, `and`, …) are identifier-shaped too. They are reported
 * and then ignored by the checker, because they are never navigation names.
 */

function pathsOf(raw: string): string[][] {
  return expressionReferences(raw).flatMap((reference) =>
    reference.kind === "path" ? [reference.segments] : [],
  );
}

function namesOf(raw: string): string[] {
  return expressionReferences(raw).flatMap((reference) =>
    reference.kind === "name" ? [reference.name] : [],
  );
}

test("a plain scalar field is reported as a bare name, never as a path", () => {
  assert.ok(namesOf("userId eq '1'").includes("userId"));
  assert.deepEqual(pathsOf("userId eq '1'"), []);
});

test("a bare navigation is reported, so $select and bare filters can be checked", () => {
  assert.ok(namesOf("empInfo ne null").includes("empInfo"));
  assert.ok(namesOf("userId,empInfo").includes("userId"));
  assert.ok(namesOf("userId,empInfo").includes("empInfo"));
});

test("the production navigation shapes are reported as paths", () => {
  assert.deepEqual(pathsOf("externalCodeNav/userId eq '1'"), [["externalCodeNav", "userId"]]);
  assert.deepEqual(pathsOf("cust_centro/externalCode eq 'C'"), [["cust_centro", "externalCode"]]);
});

test("a deeper path keeps every segment", () => {
  assert.deepEqual(pathsOf("job/manager/id eq '1'"), [["job", "manager", "id"]]);
});

test("a slash inside a quoted literal is not a path", () => {
  assert.deepEqual(pathsOf("userId eq 'a/b'"), []);
  assert.deepEqual(pathsOf("userId eq 'it''s/a'"), []);
  assert.ok(namesOf("userId eq 'a/b'").includes("userId"));
  assert.ok(!namesOf("userId eq 'a/b'").includes("a"));
});

test("every predicate is inspected, not just the first", () => {
  assert.deepEqual(pathsOf("externalCodeNav/userId eq '1' and cust_centro/externalCode eq 'C'"), [
    ["externalCodeNav", "userId"],
    ["cust_centro", "externalCode"],
  ]);
  assert.deepEqual(pathsOf("userId eq '1' or externalCodeNav/userId eq '2'"), [
    ["externalCodeNav", "userId"],
  ]);
});

test("functions and operators are not mistaken for paths", () => {
  assert.deepEqual(pathsOf("substringof('x',externalCodeNav/userId) eq true"), [
    ["externalCodeNav", "userId"],
  ]);
  assert.deepEqual(pathsOf(""), []);
});

test("whitespace around the slash is still treated as a path", () => {
  // OData v2 rejects this form, but checking it beats ignoring it.
  assert.deepEqual(pathsOf("externalCodeNav / userId eq '1'"), [["externalCodeNav", "userId"]]);
  assert.deepEqual(pathsOf("externalCodeNav/ userId eq '1'"), [["externalCodeNav", "userId"]]);
  assert.deepEqual(pathsOf("externalCodeNav /userId eq '1'"), [["externalCodeNav", "userId"]]);
});
