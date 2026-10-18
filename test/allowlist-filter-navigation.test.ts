import test from "node:test";
import assert from "node:assert/strict";
import { navigationPathsInExpression } from "../src/allowlist-navigation.js";

/**
 * `$filter`/`$orderby` can reference a navigation (`navProp/field`). The
 * production-verified shapes are narrow — `externalCodeNav/userId eq '<id>'` and
 * `cust_centro/externalCode eq '<id>'` — so the extractor targets exactly that:
 * `name/name[...]` sequences outside quoted literals, with the final property
 * dropped because it is not a navigation.
 */

test("a plain scalar field yields no navigation route", () => {
  assert.deepEqual(navigationPathsInExpression("userId eq '1'"), []);
  assert.deepEqual(navigationPathsInExpression("externalCode eq 'X'"), []);
});

test("the production navigation shapes yield their leading navigation", () => {
  assert.deepEqual(navigationPathsInExpression("externalCodeNav/userId eq '1'"), [["externalCodeNav"]]);
  assert.deepEqual(navigationPathsInExpression("cust_centro/externalCode eq 'C'"), [["cust_centro"]]);
});

test("a deeper path keeps every hop except the final property", () => {
  assert.deepEqual(navigationPathsInExpression("job/manager/id eq '1'"), [["job", "manager"]]);
});

test("a slash inside a quoted literal is not a navigation", () => {
  assert.deepEqual(navigationPathsInExpression("userId eq 'a/b'"), []);
  assert.deepEqual(navigationPathsInExpression("userId eq 'it''s/a'"), []);
});

test("every predicate is inspected, not just the first", () => {
  assert.deepEqual(
    navigationPathsInExpression("externalCodeNav/userId eq '1' and cust_centro/externalCode eq 'C'"),
    [["externalCodeNav"], ["cust_centro"]],
  );
  assert.deepEqual(
    navigationPathsInExpression("userId eq '1' or externalCodeNav/userId eq '2'"),
    [["externalCodeNav"]],
  );
});

test("operators and functions are not mistaken for paths", () => {
  assert.deepEqual(navigationPathsInExpression("substringof('x',userId) eq true"), []);
  assert.deepEqual(navigationPathsInExpression(""), []);
});

test("orderby expressions work the same way", () => {
  assert.deepEqual(navigationPathsInExpression("externalCodeNav/userId desc"), [["externalCodeNav"]]);
});
