import test from "node:test";
import assert from "node:assert/strict";
import { checkNavigationPath, type NavigationLookup } from "../src/allowlist-navigation.js";
import type { AllowlistEntry } from "../src/allowlist.js";

const allow = (entity: string): AllowlistEntry => ({ entity });

/**
 * A tiny navigation graph, injected so the decision logic is testable without
 * metadata: User -> Payroll (payrollNav) and User -> PicklistOption (countryNav),
 * Payroll -> PayrollDetail (detailNav).
 */
const GRAPH: Record<string, Record<string, string>> = {
  User: { payrollNav: "Payroll", countryNav: "PicklistOption" },
  Payroll: { detailNav: "PayrollDetail" },
};
const lookup: NavigationLookup = async (from, nav) => GRAPH[from]?.[nav];

test("a path with no navigation is permitted and reports the root it stayed on", async () => {
  assert.deepEqual(await checkNavigationPath(["User('1')"], undefined, undefined, lookup), {
    kind: "permitted",
    reached: "User",
  });
});

test("a navigation whose destination is allowed is permitted and reports the destination reached", async () => {
  const verdict = await checkNavigationPath(
    ["User('1')", "countryNav"],
    [allow("User"), allow("PicklistOption")],
    undefined,
    lookup,
  );
  assert.deepEqual(verdict, { kind: "permitted", reached: "PicklistOption" });
});

test("a navigation whose destination is NOT in the allowlist is denied", async () => {
  const verdict = await checkNavigationPath(
    ["User('1')", "payrollNav"],
    [allow("User")],
    undefined,
    lookup,
  );
  assert.deepEqual(verdict, { kind: "denied", entitySet: "Payroll" });
});

test("the denylist wins over the allowlist on a navigation destination", async () => {
  const verdict = await checkNavigationPath(
    ["User('1')", "payrollNav"],
    [allow("User"), allow("Payroll")],
    [allow("Payroll")],
    lookup,
  );
  assert.deepEqual(verdict, { kind: "denied", entitySet: "Payroll" });
});

test("a deeper hop is checked: the chain is walked, not just the first navigation", async () => {
  const verdict = await checkNavigationPath(
    ["User('1')", "payrollNav", "detailNav"],
    [allow("User"), allow("Payroll")],
    undefined,
    lookup,
  );
  assert.deepEqual(verdict, { kind: "denied", entitySet: "PayrollDetail" });
});

test("a chain whose every hop is allowed is permitted and reports where it ended", async () => {
  const verdict = await checkNavigationPath(
    ["User('1')", "payrollNav", "detailNav"],
    [allow("User"), allow("Payroll"), allow("PayrollDetail")],
    undefined,
    lookup,
  );
  assert.deepEqual(verdict, { kind: "permitted", reached: "PayrollDetail" });
});

test("an unresolvable navigation is reported, never passed through", async () => {
  const verdict = await checkNavigationPath(["User('1')", "noExiste"], undefined, undefined, lookup);
  assert.deepEqual(verdict, { kind: "unresolvable", navigationName: "noExiste" });
});

test("key predicates are stripped before resolving every hop", async () => {
  const verdict = await checkNavigationPath(
    ["User('a/b')", "payrollNav", "detailNav"],
    [allow("User")],
    undefined,
    lookup,
  );
  assert.deepEqual(verdict, { kind: "denied", entitySet: "Payroll" });
});

test("an empty allowlist narrows nothing: navigation is permitted", async () => {
  const verdict = await checkNavigationPath(["User('1')", "payrollNav"], [], undefined, lookup);
  assert.deepEqual(verdict, { kind: "permitted", reached: "Payroll" });
});
