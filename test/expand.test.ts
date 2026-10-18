import test from "node:test";
import assert from "node:assert/strict";
import { parseExpand } from "../src/expand.js";

function routes(raw: string): string[][] {
  const parsed = parseExpand(raw);
  assert.ok(parsed.ok, `expected "${raw}" to parse, got: ${parsed.ok ? "" : parsed.reason}`);
  return parsed.routes;
}

function rejected(raw: string): string {
  const parsed = parseExpand(raw);
  assert.equal(parsed.ok, false, `expected "${raw}" to be rejected`);
  return parsed.ok ? "" : parsed.reason;
}

test("a single navigation becomes one route", () => {
  assert.deepEqual(routes("empInfo"), [["empInfo"]]);
});

test("a comma list becomes one route per navigation", () => {
  assert.deepEqual(routes("empInfo,countryNav"), [["empInfo"], ["countryNav"]]);
});

test("a slash path becomes ONE route with both hops", () => {
  assert.deepEqual(routes("empInfo/jobInfoNav"), [["empInfo", "jobInfoNav"]]);
});

test("spaces around separators are tolerated", () => {
  assert.deepEqual(routes(" empInfo , countryNav / xNav "), [["empInfo"], ["countryNav", "xNav"]]);
});

test("$select sub-options are skipped, not interpreted", () => {
  assert.deepEqual(routes("empInfo($select=userId,startDate)"), [["empInfo"]]);
});

test("a nested $expand contributes routes anchored at the parent", () => {
  assert.deepEqual(routes("empInfo($expand=jobInfoNav)"), [["empInfo"], ["empInfo", "jobInfoNav"]]);
});

test("nested $expand combines with a deeper base path", () => {
  assert.deepEqual(routes("empInfo($expand=jobInfoNav,jobInfoNav/x)"), [
    ["empInfo"],
    ["empInfo", "jobInfoNav"],
    ["empInfo", "jobInfoNav", "x"],
  ]);
});

test("$select and $expand can be combined with a semicolon", () => {
  assert.deepEqual(routes("empInfo($select=userId;$expand=jobInfoNav)"), [
    ["empInfo"],
    ["empInfo", "jobInfoNav"],
  ]);
});

test("an empty value yields no routes", () => {
  assert.deepEqual(routes(""), []);
  assert.deepEqual(routes("   "), []);
});

test("$filter inside expand is rejected: it belongs to the filter vector", () => {
  assert.match(rejected("empInfo($filter=userId eq '1')"), /unsupported expand option/);
});

test("$orderby inside expand is rejected", () => {
  assert.match(rejected("empInfo($orderby=userId)"), /unsupported expand option/);
});

test("a wildcard is rejected", () => {
  assert.match(rejected("*"), /expected a navigation property name/);
});

test("trailing junk is rejected", () => {
  assert.match(rejected("empInfo)"), /unexpected/);
});

test("an unterminated option is rejected", () => {
  assert.match(rejected("empInfo($select=userId"), /unterminated|expected/);
});

test("a trailing comma is rejected", () => {
  assert.match(rejected("empInfo,"), /expected a navigation property name/);
});
