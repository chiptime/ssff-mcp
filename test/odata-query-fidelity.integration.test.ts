/**
 * Opt-in integration smoke test for OData query fidelity (spec S8 / FR-85).
 *
 * Reproduces the `IdentificationGetController` catalog and the effective-dating
 * scenarios against the real `TEST_basic` tenant, driving the real MCP tool path
 * (`createMcpServer({})` with the real `fetch`, through the in-memory client).
 * The goal is that every query is *executable*: the pre-fix defects were a 400
 * (`+` instead of `%20`, `%24` option names) and a 404 (missing effective-dating
 * window) before any data could be returned, so row counts are not asserted
 * except where a row is certain to exist.
 *
 * Why it is opt-in: it talks to a live tenant using the developer's own
 * credentials, so it must never run in CI or on a machine without them. It is
 * skipped unless `SSFF_MCP_INTEGRATION=1`, and skipped again (not failed) when
 * `~/.config/ssff-mcp/config.json` cannot be loaded or has no `TEST_basic`.
 *
 * Run it with either:
 *   SSFF_MCP_INTEGRATION=1 pnpm test
 *   SSFF_MCP_INTEGRATION=1 node --test dist/test/odata-query-fidelity.integration.test.js
 *
 * Output hygiene: only the environment alias, record counts, HTTP statuses and
 * sanitized error codes are ever printed; no URLs, hosts, credentials or
 * records.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { callTool, withTestServer, type CallResult, type TestClient } from "./helpers.js";

const ENVIRONMENT = "TEST_basic";
const WORKER_ID = "1000001";
const FLAG_REASON = "opt-in integration test: set SSFF_MCP_INTEGRATION=1 to run against a real tenant";

let probe: Promise<string | undefined> | undefined;

/** Resolves to a skip reason, or undefined when the real tenant is usable. */
function skipReason(): Promise<string | undefined> {
  if (process.env.SSFF_MCP_INTEGRATION !== "1") {
    return Promise.resolve(FLAG_REASON);
  }
  probe ??= (async () => {
    try {
      return await withTestServer({}, async (client) => {
        const result = await callTool(client, "list_environments", {});
        if (result.isError) {
          return "real config could not be loaded (~/.config/ssff-mcp/config.json)";
        }
        const environments = (result.structuredContent as { environments: Array<{ alias: string }> }).environments;
        return environments.some((e) => e.alias === ENVIRONMENT)
          ? undefined
          : `real config has no ${ENVIRONMENT} environment`;
      });
    } catch {
      return "real config could not be loaded (~/.config/ssff-mcp/config.json)";
    }
  })();
  return probe;
}

/** Register a test that skips (with a reason) unless the real tenant is usable. */
function integration(name: string, fn: (client: TestClient) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    const reason = await skipReason();
    if (reason !== undefined) {
      t.skip(reason);
      return;
    }
    await withTestServer({}, fn);
  });
}

/** Assert success; on failure expose only the sanitized code/message/status. */
function assertSucceeded(result: CallResult, label: string): void {
  if (result.isError) {
    const p = result.structuredContent as { code?: string; message?: string; httpStatus?: number };
    assert.fail(`${label} failed: code=${p.code} httpStatus=${p.httpStatus ?? "n/a"} message=${p.message}`);
  }
}

function recordCountOf(result: CallResult): number {
  const count = (result.structuredContent as { recordCount?: unknown }).recordCount;
  assert.equal(typeof count, "number");
  assert.ok((count as number) >= 0);
  return count as number;
}

async function query(client: TestClient, label: string, args: Record<string, unknown>): Promise<number> {
  const result = await callTool(client, "query_entity", { environment: ENVIRONMENT, ...args });
  assertSucceeded(result, label);
  const count = recordCountOf(result);
  console.log(`[integration] ${ENVIRONMENT} ${label}: ok recordCount=${count}`);
  return count;
}

const CATALOG = [
  {
    label: "cust_Documentos_Nacionales",
    entityPath: "cust_Documentos_Nacionales",
    filter: `externalCode eq '${WORKER_ID}'`,
    select: "externalCode",
    top: 5,
  },
  {
    label: "cust_Otros_Requisitos_Obligatorios",
    entityPath: "cust_Otros_Requisitos_Obligatorios",
    filter: `externalCode eq '${WORKER_ID}'`,
    select: "externalCode",
    top: 5,
  },
  {
    label: "PaymentInformationDetailV3",
    entityPath: "PaymentInformationDetailV3",
    filter: `PaymentInformationV3_worker eq '${WORKER_ID}'`,
    select: "externalCode",
    top: 5,
  },
];

for (const { label, ...args } of CATALOG) {
  integration(`catalog: ${label} by worker filter is executable`, async (client) => {
    await query(client, label, args);
  });
}

integration("filter with spaces on a simple entity succeeds (pre-fix 400)", async (client) => {
  await query(client, "User status filter", {
    entityPath: "User",
    filter: "status eq 'f'",
    select: "userId",
    top: 1,
  });
});

integration("effective dating: PerPersonal with fromDate/toDate window returns a row", async (client) => {
  const count = await query(client, "PerPersonal window", {
    entityPath: "PerPersonal",
    filter: `personIdExternal eq '${WORKER_ID}'`,
    select: "personIdExternal",
    fromDate: "1970-01-12",
    toDate: "9999-12-31",
  });
  assert.ok(count >= 1, "expected at least one PerPersonal row for the verified worker");
});

integration("effective dating: historical EmpJob key predicate with window (pre-fix 404)", async (client) => {
  // Transport-level assertion only: the specific historical row may not exist in the tenant.
  await query(client, "EmpJob key predicate window", {
    entityPath: `EmpJob(seqNumber=1L,startDate=datetime'2013-01-01T00:00:00',userId='${WORKER_ID}')`,
    fromDate: "1970-01-12",
    toDate: "9999-12-31",
  });
});

integration("effective dating: asOfDate on PerPersonal succeeds", async (client) => {
  await query(client, "PerPersonal asOfDate", {
    entityPath: "PerPersonal",
    filter: `personIdExternal eq '${WORKER_ID}'`,
    select: "personIdExternal",
    asOfDate: "2020-01-01",
  });
});

integration("batch_get carries the three catalog queries successfully", async (client) => {
  const result = await callTool(client, "batch_get", {
    environment: ENVIRONMENT,
    requests: CATALOG.map(({ label: _label, ...item }) => item),
  });
  assertSucceeded(result, "batch_get catalog");
  const results = (result.structuredContent as {
    results: Array<{ success: boolean; httpStatus?: number; recordCount?: number; error?: { code?: string } }>;
  }).results;
  assert.equal(results.length, CATALOG.length);
  results.forEach((entry, index) => {
    console.log(
      `[integration] ${ENVIRONMENT} batch item ${index} (${CATALOG[index]!.label}): ` +
        `success=${entry.success} httpStatus=${entry.httpStatus ?? "n/a"} recordCount=${entry.recordCount ?? "n/a"}` +
        (entry.error?.code !== undefined ? ` error=${entry.error.code}` : ""),
    );
    assert.equal(entry.success, true, `batch item ${index} (${CATALOG[index]!.label}) did not succeed`);
  });
});
