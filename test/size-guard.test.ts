import test from "node:test";
import assert from "node:assert/strict";
import { MAX_RESPONSE_BYTES, exceedsResponseCap, responseBytes } from "../src/size-guard.js";
import {
  callTool,
  errorPayload,
  FakeResponse,
  jsonResponse,
  mdfMetadataXml,
  recordingFetch,
  SAMPLE_METADATA_XML,
  withTestServer,
  writeStandardConfig,
  xmlResponse,
} from "./helpers.js";
import type { AnyFetchInit, FetchImpl } from "../src/http.js";

const BIG = "x".repeat(60 * 1024);

function bigRecords(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({ userId: `u${i}`, blob: BIG }));
}

function boundaryOf(init: AnyFetchInit): string {
  return /boundary=(batch_\d+)$/.exec(init.headers["Content-Type"] ?? "")![1]!;
}

function batchResponse(boundary: string, bodies: string[], contentType = "application/json"): FakeResponse {
  const body =
    bodies
      .map((part) =>
        [
          `--${boundary}`,
          "Content-Type: application/http",
          "Content-Transfer-Encoding: binary",
          "",
          "HTTP/1.1 200 OK",
          `Content-Type: ${contentType}`,
          "",
          part,
          "",
        ].join("\r\n"),
      )
      .join("") + `--${boundary}--\r\n`;
  return new FakeResponse(200, body, { "content-type": `multipart/mixed; boundary=${boundary}` });
}

test("cap is a size in bytes of UTF-8 text", () => {
  assert.equal(MAX_RESPONSE_BYTES, 262144);
  assert.equal(responseBytes("ñ"), 2);
  assert.equal(exceedsResponseCap("a".repeat(MAX_RESPONSE_BYTES)), false);
  assert.equal(exceedsResponseCap("a".repeat(MAX_RESPONSE_BYTES + 1)), true);
});

test("query_entity rejects an oversized response with a sanitized, actionable error", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch((url) =>
    url.endsWith("/$metadata") ? xmlResponse(SAMPLE_METADATA_XML) : jsonResponse({ d: { results: bigRecords(6) } }),
  );
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    const error = errorPayload(result);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    for (const hint of ["$select", "$top", "$filter"]) {
      assert.ok(error.message.includes(hint), hint);
    }
    assert.ok(!error.message.includes("xxxx"), "no data echoed");
    assert.ok(!error.message.includes("get_metadata"));
  });
});

test("query_entity below the cap is untouched, whatever the entity", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch((url) =>
    url.endsWith("/$metadata") ? xmlResponse(SAMPLE_METADATA_XML) : jsonResponse({ d: { results: bigRecords(2) } }),
  );
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    for (const entityPath of ["User", "FOOBar"]) {
      const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath });
      assert.ok(!result.isError, entityPath);
      assert.equal((result.structuredContent as { recordCount: number }).recordCount, 2);
    }
  });
});

test("the cap does not depend on the entity name: the same payload fails for any entity", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch((url) =>
    url.endsWith("/$metadata") ? xmlResponse(SAMPLE_METADATA_XML) : jsonResponse({ d: { results: bigRecords(6) } }),
  );
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    for (const entityPath of ["User", "FOOBar"]) {
      assert.equal(errorPayload(await callTool(client, "query_entity", { environment: "tenant-a", entityPath })).code, "RESPONSE_TOO_LARGE");
    }
  });
});

test("query_entity xml output is also capped", async () => {
  const configPath = await writeStandardConfig();
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><content>${"y".repeat(MAX_RESPONSE_BYTES + 10)}</content></entry></feed>`;
  const { fetch } = recordingFetch((url) => (url.endsWith("/$metadata") ? xmlResponse(SAMPLE_METADATA_XML) : xmlResponse(atom)));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User", output: "xml" });
    assert.equal(errorPayload(result).code, "RESPONSE_TOO_LARGE");
  });
});

test("metadata larger than the cap is exempt: it is internal, never returned whole", async () => {
  const configPath = await writeStandardConfig();
  const many = Array.from({ length: 4000 }, (_, i) => ({ name: `cust_Big${i}`, keys: ["externalCode", "effectiveStartDate"] }));
  const xml = mdfMetadataXml([{ name: "User", keys: ["userId"] }, ...many]);
  assert.ok(Buffer.byteLength(xml) > MAX_RESPONSE_BYTES);
  const { fetch } = recordingFetch((url) => (url.endsWith("/$metadata") ? xmlResponse(xml) : jsonResponse({ d: { results: [{ userId: "1" }] } })));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    assert.ok(!result.isError);
    const detail = await client.readResource({ uri: "sf://tenant-a/entities/cust_Big7" });
    assert.equal(detail.contents.length, 1);
  });
});

test("batch_get applies the cap per inner request, not to the whole batch", async () => {
  const configPath = await writeStandardConfig();
  const small = JSON.stringify({ d: { results: bigRecords(3) } }); // ~180 KB each, two parts exceed one cap
  const huge = JSON.stringify({ d: { results: bigRecords(6) } });
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) return xmlResponse(SAMPLE_METADATA_XML);
    return batchResponse(boundaryOf(init), [small, huge, small]);
  };
  const { fetch } = recordingFetch(base);
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }, { entityPath: "User", top: 5 }],
    });
    assert.ok(!result.isError);
    const { results } = result.structuredContent as { results: Array<Record<string, any>> };
    assert.deepEqual(results.map((r) => r.success), [true, false, true]);
    assert.equal(results[1]!.error.code, "RESPONSE_TOO_LARGE");
    assert.match(results[1]!.error.message, /\$select/);
    assert.equal(results[1]!.records, undefined);
    // The aggregate is above one cap, yet the two valid parts survive untouched.
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) > MAX_RESPONSE_BYTES);
    assert.equal(results[0]!.recordCount, 3);
    assert.equal(results[2]!.recordCount, 3);
  });
});

test("an oversized batch part does not consume the aggregate record ceiling", async () => {
  const configPath = await writeStandardConfig();
  const wide = JSON.stringify({ d: { results: Array.from({ length: 900 }, (_, i) => ({ id: i, blob: "z".repeat(400) })) } });
  const ok = JSON.stringify({ d: { results: Array.from({ length: 900 }, (_, i) => ({ id: i })) } });
  const base: FetchImpl = async (url, init) =>
    url.endsWith("/$metadata") ? xmlResponse(SAMPLE_METADATA_XML) : batchResponse(boundaryOf(init), [wide, ok]);
  const { fetch } = recordingFetch(base);
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "batch_get", { environment: "tenant-a", requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }] });
    const { results } = result.structuredContent as { results: Array<Record<string, any>> };
    assert.equal(results[0]!.success, false);
    assert.equal(results[1]!.success, true);
    assert.equal(results[1]!.recordCount, 900);
    assert.equal(results[1]!.truncatedToCeiling, undefined);
  });
});

test("batch_get xml part over the cap fails that item only", async () => {
  const configPath = await writeStandardConfig();
  const atom = (n: number) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><content>${"y".repeat(n)}</content></entry></feed>`;
  const base: FetchImpl = async (url, init) =>
    url.endsWith("/$metadata")
      ? xmlResponse(SAMPLE_METADATA_XML)
      : batchResponse(boundaryOf(init), [atom(MAX_RESPONSE_BYTES + 10), atom(100)], "application/atom+xml");
  const { fetch } = recordingFetch(base);
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      output: "xml",
      requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }],
    });
    const { results } = result.structuredContent as { results: Array<Record<string, any>> };
    assert.deepEqual(results.map((r) => r.success), [false, true]);
    assert.equal(results[0]!.error.code, "RESPONSE_TOO_LARGE");
  });
});

// --- corrections after independent verification --------------------------------

test("S12: a batch XML part whose JSON-escaped result exceeds the cap fails that item", async () => {
  const configPath = await writeStandardConfig();
  // Raw XML below the cap; JSON-escaping the quotes doubles it in the payload.
  const quotes = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><content>${'"'.repeat(140000)}</content></entry></feed>`;
  assert.ok(Buffer.byteLength(quotes) < MAX_RESPONSE_BYTES);
  const small = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><content>ok</content></entry></feed>`;
  const base: FetchImpl = async (url, init) =>
    url.endsWith("/$metadata")
      ? xmlResponse(SAMPLE_METADATA_XML)
      : batchResponse(boundaryOf(init), [quotes, small], "application/atom+xml");
  const { fetch } = recordingFetch(base);
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      output: "xml",
      requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }],
    });
    const { results } = result.structuredContent as { results: Array<Record<string, any>> };
    assert.deepEqual(results.map((r) => r.success), [false, true]);
    assert.equal(results[0]!.error.code, "RESPONSE_TOO_LARGE");
    assert.equal(results[0]!.body, undefined);
  });
});

test("S12: a batch JSON item is measured on its serialized result", async () => {
  const configPath = await writeStandardConfig();
  // Records whose raw JSON is under the cap produce an under-cap serialized item.
  const under = JSON.stringify({ d: { results: [{ id: 1, note: "ok" }] } });
  const base: FetchImpl = async (url, init) =>
    url.endsWith("/$metadata") ? xmlResponse(SAMPLE_METADATA_XML) : batchResponse(boundaryOf(init), [under]);
  const { fetch } = recordingFetch(base);
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "batch_get", { environment: "tenant-a", requests: [{ entityPath: "User" }] });
    const { results } = result.structuredContent as { results: Array<Record<string, any>> };
    assert.equal(results[0]!.success, true);
    assert.equal(results[0]!.recordCount, 1);
  });
});
