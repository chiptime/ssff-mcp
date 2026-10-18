import test from "node:test";
import assert from "node:assert/strict";
import { validateEntityPath } from "../src/odata.js";
import { isSanitizedError } from "../src/errors.js";
import {
  callTool,
  configJson,
  errorPayload,
  jsonResponse,
  mdfMetadataXml,
  recordingFetch,
  withTestServer,
  writeConfigFile,
  xmlResponse,
} from "./helpers.js";

/**
 * URL normalisation is applied by the HTTP layer AFTER validation, so a key that
 * contains normalising syntax makes the dispatched path point somewhere else than
 * the path that was checked. `User('x/../Payroll#')` was the reported case: the
 * `/../` collapses and the `#` truncates, so the request reached `/odata/v2/Payroll`
 * while the checker had only seen `User`. `?` and `\` have the same class of
 * problem (query injection, separator rewriting).
 */

const REJECTED = [
  "User('x/../Payroll#')",
  "User('x/../Payroll')",
  "User('x\\..\\Payroll')",
  "User('x#')",
  "User('1')?$expand=Payroll",
  "User('1')/../Payroll",
  "User('1')/./Payroll",
];

test("normalising syntax in an entity path is rejected by the validator", () => {
  for (const entityPath of REJECTED) {
    assert.throws(
      () => validateEntityPath(entityPath),
      (error: unknown) => isSanitizedError(error) && error.code === "PATH_INVALID",
      entityPath,
    );
  }
});

test("ordinary paths are still accepted", () => {
  for (const entityPath of [
    "User('123')",
    "User('It''s')",
    "User('a/b')",
    "User('a.b')",
    "cust_Note('x')",
    "User(guid'12345678-1234-1234-1234-123456789abc')",
    "User('1')/job",
  ]) {
    assert.doesNotThrow(() => validateEntityPath(entityPath), entityPath);
  }
});

function responder() {
  return recordingFetch((url) =>
    url.endsWith("/$metadata")
      ? xmlResponse(mdfMetadataXml(), 200, { "content-type": "application/xml" })
      : jsonResponse({ d: { results: [] } }),
  );
}

async function configPath(): Promise<string> {
  return await writeConfigFile(
    configJson({ prod: { allowlist: [{ entity: "User" }, { entity: "EmpJob" }] } }),
    { mode: 0o600 },
  );
}

test("a normalising path never reaches the network", async () => {
  const { fetch, requests } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    for (const entityPath of REJECTED) {
      const result = await callTool(client, "query_entity", { environment: "prod", entityPath });
      assert.equal(errorPayload(result).code, "PATH_INVALID", entityPath);
    }
    assert.equal(requests.filter((r) => !r.url.includes("$metadata")).length, 0);
  });
});

test("a normalising path is rejected inside batch_get too, before the POST", async () => {
  const { fetch, requests } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "prod",
      requests: [{ entityPath: "User" }, { entityPath: "User('x/../Payroll#')" }],
    });
    assert.equal(errorPayload(result).code, "PATH_INVALID");
    assert.equal(requests.filter((r) => r.method === "POST").length, 0);
  });
});
