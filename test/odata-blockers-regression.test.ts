/**
 * Independent verifier's regression suite for two blockers found after the
 * feature was first implemented: an explicitly provided empty effective-dating
 * date being silently dropped (B1/S5), and the parity test not being byte-exact
 * because option order was out of scope (B2/S7).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildQuery, type QueryOptions } from "../src/odata.js";
import { callTool, errorPayload, jsonResponse, xmlResponse, SAMPLE_METADATA_XML,
  withTestServer, writeStandardConfig, type CallResult } from "./helpers.js";

const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const dates = ["fromDate", "toDate", "asOfDate"] as const;
async function rejected(options: QueryOptions, message: string): Promise<void> {
  const configPath = await writeStandardConfig();
  let dispatches = 0;
  await withTestServer({ configPath, fetchImpl: async () => {
    dispatches++; throw new Error("unexpected network dispatch");
  } }, async (client) => {
    for (const tool of ["query_entity", "batch_get"]) {
      const before = await hash(configPath);
      const item = { entityPath: "User", ...options };
      const args = tool === "query_entity" ? { environment: "tenant-a", ...item }
        : { environment: "tenant-a", requests: [item] };
      const result = await callTool(client, tool, args);
      assert.deepEqual(errorPayload(result), { code: "OPTION_INVALID", message });
      assert.equal(dispatches, 0);
      assert.equal(await hash(configPath), before);
      console.log(JSON.stringify({ tool, options, error: errorPayload(result), dispatches, unchanged: true }));
    }
  });
}

// B1 / S5: all requested malformed forms, on both entry paths.
for (const name of dates) for (const value of ["", " ", "2026-10-14\n"]) {
  test(`B1 ${name}=${JSON.stringify(value)} is rejected without dispatch`, async () => {
    const message = `${name} must be a date in YYYY-MM-DD format`;
    assert.throws(() => buildQuery("User", { [name]: value }),
      { code: "OPTION_INVALID", message });
    await rejected({ [name]: value }, message);
  });
}

test("B1 all provided asOfDate/window combinations reject, including empty values", async () => {
  for (const name of ["fromDate", "toDate"] as const) {
    for (const invalid of ["", " ", "2026-10-14\n"]) {
      await rejected({ asOfDate: "2026-10-14", [name]: invalid }, `${name} must be a date in YYYY-MM-DD format`);
      await rejected({ asOfDate: invalid, [name]: "2026-10-14" }, "asOfDate must be a date in YYYY-MM-DD format");
    }
    await rejected({ asOfDate: "2026-10-14", [name]: "2026-10-14" }, "asOfDate cannot be combined with fromDate or toDate");
  }
  console.log("B1 exclusivity: 28 tool calls rejected; format validation precedes exclusivity");
});

test("B1 empty filter/orderby/select/expand still omit on both tools", async () => {
  const options: QueryOptions = { filter: "", orderby: "", select: "", expand: "" };
  for (const name of ["filter", "orderby", "select", "expand"] as const) {
    assert.equal(buildQuery("User", { [name]: "" }).pathAndQuery, "User");
  }
  assert.equal(buildQuery("User", options).pathAndQuery, "User");
  const configPath = await writeStandardConfig();
  const dispatched: string[] = [];
  await withTestServer({ configPath, fetchImpl: async (url, init) => {
    if (url.endsWith("/$metadata")) return xmlResponse(SAMPLE_METADATA_XML);
    dispatched.push(init.method === "POST" ? String(init.body) : url);
    if (init.method !== "POST") return jsonResponse({ d: { results: [] } });
    const body = '--response\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"d":{"results":[]}}\r\n--response--\r\n';
    return xmlResponse(body, 200, { "content-type": "multipart/mixed; boundary=response" });
  } }, async (client) => {
    for (const tool of ["query_entity", "batch_get"]) {
      const invoke = (o: QueryOptions): Promise<CallResult> => callTool(client, tool,
        tool === "query_entity" ? { environment: "tenant-a", entityPath: "User", ...o }
          : { environment: "tenant-a", requests: [{ entityPath: "User", ...o }] });
      const absent = await invoke({});
      const empty = await invoke(options);
      assert.notEqual(absent.isError, true);
      assert.notEqual(empty.isError, true);
      assert.deepEqual(empty, absent);
      if (tool === "batch_get") {
        const items = empty.structuredContent?.results as Array<{ success: boolean }>;
        assert.equal(items[0]?.success, true);
      }
      const wire = dispatched.at(-1)!;
      for (const name of ["filter", "orderby", "select", "expand"]) assert.equal(wire.includes(`$${name}=`), false);
    }
  });
  console.log("B1 empty raw options: 4 individual builders + combined builder; both tools succeed identically to absent options");
});

// B2 / S7: independently specified order, no writer fixture and no sorting.
test("B2 strict parity across every shared-option subset and MCP-only insertions", () => {
  const keys = ["filter", "select", "expand", "top", "skiptoken", "inlinecount", "orderby"] as const;
  const values: QueryOptions = { filter: "status eq 'f' and name eq 'a+b'", select: "userId, firstName",
    expand: "manager, hr", top: 5, skiptoken: "tok123", inlinecount: "allpages", orderby: "startDate desc" };
  const fragments = ["$filter=status eq 'f' and name eq 'a+b'", "$select=userId, firstName", "$expand=manager, hr",
    "$top=5", "$skiptoken=tok123", "$inlinecount=allpages", "$orderby=startDate desc"];
  const extras: QueryOptions[] = [{ skip: 0 }, { skip: 2 }, { fromDate: "1970-01-12", toDate: "9999-12-31" },
    { asOfDate: "2026-10-14", skip: 2 }];
  for (let mask = 0; mask < 128; mask++) {
    const options = Object.fromEntries(keys.flatMap((k, i) => mask & (1 << i) ? [[k, values[k]]] : [])) as QueryOptions;
    const selected = fragments.filter((_, i) => mask & (1 << i));
    const reference = "User" + (selected.length ? "?" + selected.join("&") : "");
    const expected = reference.replace(/ /g, "%20");
    assert.equal(buildQuery("User", options).pathAndQuery, expected);
    for (const extra of extras) {
      const actual = buildQuery("User", { ...options, ...extra }).pathAndQuery;
      const extended = selected.map((part) => part.replace(/ /g, "%20"));
      const datePairs = dates.flatMap((name) => extra[name] === undefined ? [] : [`${name}=${extra[name]}`]);
      const beforeDate = keys.slice(0, 3).filter((_, i) => mask & (1 << i)).length;
      extended.splice(beforeDate, 0, ...datePairs);
      if (extra.skip) {
        const beforeSkip = beforeDate + datePairs.length + (options.top === undefined ? 0 : 1);
        extended.splice(beforeSkip, 0, `$skip=${extra.skip}`);
      }
      assert.equal(actual, "User" + (extended.length ? "?" + extended.join("&") : ""));
      const shared = (actual.split("?")[1] ?? "").split("&")
        .filter((part) => !/^(?:fromDate|toDate|asOfDate|\$skip)=/.test(part)).join("&");
      assert.equal("User" + (shared ? "?" + shared : ""), expected);
    }
  }
  assert.throws(() => assert.equal("User?$filter=status+eq+%27f%27", "User?$filter=status%20eq%20'f'"), assert.AssertionError);
  assert.throws(() => assert.equal("User?$filter=f&$orderby=o&$select=s&$expand=e", "User?$filter=f&$select=s&$expand=e&$orderby=o"), assert.AssertionError);
  console.log("B2 strict parity: 128 subsets + 512 MCP-only insertion cases passed; plus-encoded and old-order strings rejected");
});
