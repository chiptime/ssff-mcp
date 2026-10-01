import test from "node:test";
import assert from "node:assert/strict";
import type { Writable } from "node:stream";
import { promises as fs } from "node:fs";
import { LOG_FIELD_ALLOWLIST } from "../src/logger.js";
import {
  callTool,
  configJson,
  errorPayload,
  jsonResponse,
  recordingFetch,
  SAMPLE_METADATA_XML,
  standardSfResponder,
  withTestServer,
  writeConfigFile,
  writeStandardConfig,
  xmlResponse,
  type CallResult,
} from "./helpers.js";

function feed(records: unknown[], next?: string, count?: string | number): unknown {
  const d: Record<string, unknown> = { results: records };
  if (next !== undefined) {
    d.__next = next;
  }
  if (count !== undefined) {
    d.__count = count;
  }
  return { d };
}

test("list_environments returns aliases and auth type only", async () => {
  const configPath = await writeStandardConfig({
    "tenant-a": {},
    "tenant-b": { baseUrl: "https://tenant-b.example.com", username: "u@b", password: "secret-password-b" },
  });
  await withTestServer({ configPath }, async (client) => {
    const result = await callTool(client, "list_environments", {});
    assert.equal(result.isError, undefined);
    const environments = (result.structuredContent as { environments: Array<{ alias: string; authType: string }> })
      .environments;
    assert.deepEqual(
      environments.map((e) => [e.alias, e.authType]),
      [
        ["tenant-a", "basic"],
        ["tenant-b", "basic"],
      ],
    );
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("secret-password"));
    assert.ok(!serialized.includes("tenant-a.example.com"));
    assert.ok(!serialized.includes("tenant-b.example.com"));
  });
});

test("configuration is re-read on every call (stateless)", async () => {
  const configPath = await writeConfigFile(configJson({ "tenant-a": {} }), { mode: 0o600 });
  await withTestServer({ configPath }, async (client) => {
    const first = await callTool(client, "list_environments", {});
    assert.equal((first.structuredContent as { environments: unknown[] }).environments.length, 1);

    await fs.writeFile(configPath, configJson({ "tenant-a": {}, "tenant-z": {} }), "utf-8");
    const second = await callTool(client, "list_environments", {});
    assert.equal((second.structuredContent as { environments: unknown[] }).environments.length, 2);
  });
});

test("get_metadata returns the raw XML document from the source (no cache)", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(() => xmlResponse(SAMPLE_METADATA_XML));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "get_metadata", { environment: "tenant-a" });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]!.type, "text");
    assert.equal((result.content[0] as { text: string }).text, SAMPLE_METADATA_XML);
    assert.deepEqual(result.structuredContent, { environment: "tenant-a", contentType: "xml" });
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.url.endsWith("/$metadata"));
    assert.equal(requests[0]!.headers.Accept, "application/xml");
    assert.equal(requests[0]!.method, "GET");
  });
});

test("query_entity happy path unwraps d.results with verbatim records", async () => {
  const configPath = await writeStandardConfig();
  const records = [
    {
      userId: "u1",
      firstName: "Ada",
      __metadata: { uri: "https://tenant-a.example.com/odata/v2/User('u1')", type: "SFOData.User" },
    },
    { userId: "u2", firstName: "Linus" },
  ];
  const { fetch, requests } = recordingFetch(standardSfResponder(feed(records)));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      filter: "userId eq 'u1'",
      top: 50,
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      environment: string;
      path: string;
      recordCount: number;
      records: unknown[];
      hasMore: boolean;
    };
    assert.equal(structured.environment, "tenant-a");
    assert.equal(structured.path, "User");
    assert.equal(structured.recordCount, 2);
    assert.deepEqual(structured.records, records);
    assert.equal(structured.hasMore, false);

    const entityRequests = requests.filter((r) => !r.url.includes("$metadata"));
    assert.equal(entityRequests.length, 1);
    const url = new URL(entityRequests[0]!.url);
    assert.equal(url.hostname, "tenant-a.example.com");
    assert.equal(url.pathname, "/odata/v2/User");
    assert.equal(url.searchParams.get("$filter"), "userId eq 'u1'");
    assert.equal(url.searchParams.get("$top"), "50");
    assert.equal(entityRequests[0]!.headers.Accept, "application/json");
    assert.ok(requests.every((r) => r.method === "GET"));
  });
});

test("query_entity unwraps a single entity (d without results)", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch(standardSfResponder({ d: { userId: "u1", firstName: "Ada" } }));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User('u1')",
    });
    const structured = result.structuredContent as { recordCount: number; records: unknown[]; hasMore: boolean };
    assert.equal(structured.recordCount, 1);
    assert.deepEqual(structured.records, [{ userId: "u1", firstName: "Ada" }]);
    assert.equal(structured.hasMore, false);
  });
});

test("missing environment argument yields ENVIRONMENT_REQUIRED", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { entityPath: "User" });
    const payload = errorPayload(result);
    assert.equal(payload.code, "ENVIRONMENT_REQUIRED");
    assert.equal(requests.length, 0);
  });
});

test("empty environment string yields ENVIRONMENT_REQUIRED", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "  ", entityPath: "User" });
    assert.equal(errorPayload(result).code, "ENVIRONMENT_REQUIRED");
    assert.equal(requests.length, 0);
  });
});

test("unknown environment yields ENVIRONMENT_UNKNOWN and nothing is dispatched", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "prod", entityPath: "User" });
    const payload = errorPayload(result);
    assert.equal(payload.code, "ENVIRONMENT_UNKNOWN");
    assert.match(payload.message, /prod/);
    assert.equal(requests.length, 0);
  });
});

test("$-prefixed paths are rejected before any dispatch", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    for (const entityPath of ["$batch", "$metadata", "$value", "User/$count"]) {
      const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath });
      assert.equal(errorPayload(result).code, "PATH_INVALID", entityPath);
    }
    assert.equal(requests.length, 0);
  });
});

test("host-injection attempts in entityPath are rejected by the grammar", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    for (const entityPath of ["User@evil.com", "evil.com/User", "User:8080", "User//evil.com"]) {
      const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath });
      assert.equal(errorPayload(result).code, "PATH_INVALID", entityPath);
    }
    assert.equal(requests.length, 0);
  });
});

test("function imports are rejected with FUNCTION_IMPORT_UNSUPPORTED", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "doThing" });
    const payload = errorPayload(result);
    assert.equal(payload.code, "FUNCTION_IMPORT_UNSUPPORTED");
    assert.equal(payload.message, "custom service operations / function imports are not supported in the MVP");
    // Only the $metadata validation call happened; no data dispatch.
    assert.equal(requests.filter((r) => !r.url.includes("$metadata")).length, 0);
  });
});

test("unknown first segments are rejected as unknown entity set", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "NotAnEntity" });
    const payload = errorPayload(result);
    assert.equal(payload.code, "PATH_INVALID");
    assert.match(payload.message, /unknown entity set/);
    assert.equal(requests.filter((r) => !r.url.includes("$metadata")).length, 0);
  });
});

test("unknown tool fields are rejected by the strict schema", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      bogusOption: "nope",
    });
    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Invalid arguments|Unrecognized key/i);
    assert.equal(requests.length, 0);
  });
});

test("option bounds are enforced with OPTION_INVALID", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const cases: Array<Record<string, unknown>> = [
      { top: 0 },
      { top: -5 },
      { skip: -1 },
      { skip: 1_000_001 },
    ];
    for (const extra of cases) {
      const result = await callTool(client, "query_entity", {
        environment: "tenant-a",
        entityPath: "User",
        ...extra,
      });
      assert.equal(errorPayload(result).code, "OPTION_INVALID", JSON.stringify(extra));
    }
    assert.equal(requests.length, 0);
  });
});

test("top above the ceiling is clamped and flagged in the response", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([{ userId: "u1" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      top: 5000,
    });
    const structured = result.structuredContent as { topClamped?: boolean };
    assert.equal(structured.topClamped, true);
    const entityUrl = new URL(requests.filter((r) => !r.url.includes("$metadata"))[0]!.url);
    assert.equal(entityUrl.searchParams.get("$top"), "1000");
  });
});

test("oversized single page is truncated to 1000 and __next is never followed", async () => {
  const configPath = await writeStandardConfig();
  const records = Array.from({ length: 1500 }, (_, i) => ({ userId: String(i) }));
  const { fetch, requests } = recordingFetch(
    standardSfResponder(feed(records, "https://tenant-a.example.com/odata/v2/User?$skip=1000")),
  );
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    const structured = result.structuredContent as {
      recordCount: number;
      hasMore: boolean;
      truncatedToCeiling?: boolean;
    };
    assert.equal(structured.recordCount, 1000);
    assert.equal(structured.truncatedToCeiling, true);
    assert.equal(structured.hasMore, true);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("__next"));
    assert.ok(!serialized.includes("$skip=1000"));
    // One metadata fetch + exactly ONE data fetch: the no-auto-follow proof.
    const entityRequests = requests.filter((r) => !r.url.includes("$metadata"));
    assert.equal(entityRequests.length, 1);
    assert.equal(requests.length, 2);
  });
});

test("errors returned by the service surface as sanitized isError payloads", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return jsonResponse(
      { error: { code: "401", message: { value: "Invalid session; see https://tenant-a.example.com/help" } } },
      401,
    );
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    const payload = errorPayload(result);
    assert.equal(payload.code, "HTTP_ERROR");
    assert.equal(payload.httpStatus, 401);
    assert.ok(payload.message.includes("[redacted-url]"));
    assert.ok(!payload.message.includes("https://"));
  });
});

test("stderr logging emits JSON lines with allowlisted keys and no sensitive values", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch(standardSfResponder(feed([{ userId: "u1" }, { userId: "u2" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const chunks: string[] = [];
    const stderr = process.stderr as Writable;
    const originalWrite = stderr.write.bind(stderr);
    (stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    let result: CallResult;
    try {
      result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    } finally {
      (stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
    }
    assert.equal(result.isError, undefined);

    const lines = chunks.join("").split("\n").filter((line) => line.trim().length > 0);
    assert.ok(lines.length >= 1);
    const queryLines = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((o) => o.tool === "query_entity");
    assert.equal(queryLines.length, 1);
    for (const entry of queryLines) {
      for (const key of Object.keys(entry)) {
        assert.ok(LOG_FIELD_ALLOWLIST.has(key), `unexpected log key: ${key}`);
      }
      assert.equal(entry.outcome, "ok");
      assert.equal(entry.environment, "tenant-a");
      assert.equal(entry.recordCount, 2);
      assert.ok(typeof entry.durationMs === "number");
      assert.ok(typeof entry.ts === "string");
    }
    const raw = lines.join("");
    assert.ok(!raw.includes("https://"));
    assert.ok(!raw.includes("secret-password"));
    assert.ok(!raw.includes("User"));
  });
});

test("error outcomes are logged with their sanitized code via the injectable sink", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch(standardSfResponder(feed([])));
  const lines: string[] = [];
  await withTestServer({ configPath, fetchImpl: fetch, logSink: (line) => lines.push(line) }, async (client) => {
    await callTool(client, "query_entity", { environment: "nope", entityPath: "User" });
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const errorEntry = entries.find((e) => e.outcome === "error");
    assert.ok(errorEntry !== undefined);
    assert.equal(errorEntry.code, "ENVIRONMENT_UNKNOWN");
    assert.equal(errorEntry.environment, "nope");
    for (const entry of entries) {
      for (const key of Object.keys(entry)) {
        assert.ok(LOG_FIELD_ALLOWLIST.has(key), `unexpected log key: ${key}`);
      }
    }
  });
});

// --- Cursor continuation, inlinecount and XML output (FR-25/26/27) -------------

const NEXT_WITH_TOKEN = "https://tenant-a.example.com/odata/v2/User?$skiptoken=tok-1000-2000";

test("first page returns a cursor when __next carries $skiptoken; the second call replays it", async () => {
  const configPath = await writeStandardConfig();
  let dataCalls = 0;
  const { fetch, requests } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    dataCalls += 1;
    return dataCalls === 1 ? jsonResponse(feed([{ userId: "u1" }], NEXT_WITH_TOKEN)) : jsonResponse(feed([{ userId: "u2-page2" }]));
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const baseArgs = { environment: "tenant-a", entityPath: "User", filter: "status eq 'active'", top: 100 };
    const first = await callTool(client, "query_entity", baseArgs);
    assert.equal(first.isError, undefined);
    const firstStructured = first.structuredContent as { hasMore: boolean; cursor?: string };
    assert.equal(firstStructured.hasMore, true);
    assert.ok(typeof firstStructured.cursor === "string" && firstStructured.cursor.length > 0);
    // Opaque envelope: no skiptoken, no __next URL anywhere in the response.
    const serialized = JSON.stringify(first);
    assert.ok(!serialized.includes("__next"));
    assert.ok(!serialized.includes("tok-1000-2000"));

    const second = await callTool(client, "query_entity", { ...baseArgs, cursor: firstStructured.cursor });
    assert.equal(second.isError, undefined);
    const secondStructured = second.structuredContent as { records: unknown[]; hasMore: boolean; cursor?: string };
    assert.deepEqual(secondStructured.records, [{ userId: "u2-page2" }]);
    assert.equal(secondStructured.hasMore, false);
    assert.equal(secondStructured.cursor, undefined);

    // Exactly one data GET per call; the second carries the original token raw.
    const dataRequests = requests.filter((r) => !r.url.includes("$metadata"));
    assert.equal(dataRequests.length, 2);
    const secondUrl = new URL(dataRequests[1]!.url);
    assert.equal(secondUrl.searchParams.get("$skiptoken"), "tok-1000-2000");
    assert.equal(secondUrl.searchParams.get("$filter"), "status eq 'active'");
    assert.equal(secondUrl.searchParams.get("$top"), "100");
    assert.equal(secondUrl.searchParams.get("$skip"), null);
  });
});

test("changed filter with the same cursor yields CURSOR_INVALID and no fetch", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return jsonResponse(feed([{ userId: "u1" }], NEXT_WITH_TOKEN));
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const first = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      top: 100,
    });
    const cursor = (first.structuredContent as { cursor: string }).cursor;
    const requestsBefore = requests.length; // metadata + first page

    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      top: 100,
      filter: "userId eq 'changed'",
      cursor,
    });
    const payload = errorPayload(result);
    assert.equal(payload.code, "CURSOR_INVALID");
    assert.ok(!payload.message.includes(cursor));
    assert.ok(!payload.message.includes("tok-1000-2000"));
    // Rejected pre-dispatch: not even the (cached) metadata lookup ran.
    assert.equal(requests.length, requestsBefore);
  });
});

test("skip combined with cursor yields OPTION_INVALID and no fetch", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return jsonResponse(feed([{ userId: "u1" }], NEXT_WITH_TOKEN));
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const first = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      top: 100,
    });
    const cursor = (first.structuredContent as { cursor: string }).cursor;
    const requestsBefore = requests.length;

    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      top: 100,
      skip: 10,
      cursor,
    });
    assert.equal(errorPayload(result).code, "OPTION_INVALID");
    assert.equal(requests.length, requestsBefore);
  });
});

test("hasMore without an extractable skiptoken returns no cursor (never invented)", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch(
    standardSfResponder(feed([{ userId: "u1" }], "https://tenant-a.example.com/odata/v2/User?$skip=1000")),
  );
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { hasMore: boolean; cursor?: string };
    assert.equal(structured.hasMore, true);
    assert.equal(structured.cursor, undefined);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("__next"));
    assert.ok(!serialized.includes("$skip=1000"));
  });
});

test("inlinecount=allpages sends $inlinecount and returns totalCount from __count", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([{ userId: "u1" }], undefined, "96577")));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      top: 1,
      inlinecount: "allpages",
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { totalCount?: number };
    assert.equal(structured.totalCount, 96577);
    const entityUrl = new URL(requests.filter((r) => !r.url.includes("$metadata"))[0]!.url);
    assert.equal(entityUrl.searchParams.get("$inlinecount"), "allpages");
    assert.equal(entityUrl.searchParams.get("$top"), "1");
  });
});

test("without inlinecount no $inlinecount is sent and totalCount is omitted", async () => {
  const configPath = await writeStandardConfig();
  // Realistic body: the service only returns __count when $inlinecount was requested.
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([{ userId: "u1" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { totalCount?: number };
    assert.equal(structured.totalCount, undefined);
    const entityUrl = new URL(requests.filter((r) => !r.url.includes("$metadata"))[0]!.url);
    assert.equal(entityUrl.searchParams.get("$inlinecount"), null);
  });
});

const XML_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
  <title type="text">User</title>
  <m:count>96577</m:count>
  <entry><id>https://tenant-a.example.com/odata/v2/User('u1')</id></entry>
  <link rel="next" href="https://tenant-a.example.com/odata/v2/User?$skiptoken=xml-tok-1"/>
</feed>
`;

test("output xml sends Accept application/atom+xml and returns the raw body with paging flags", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return xmlResponse(XML_FEED, 200, { "content-type": "application/xml" });
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const args = { environment: "tenant-a", entityPath: "User", output: "xml" as const };
    const result = await callTool(client, "query_entity", args);
    assert.equal(result.isError, undefined);
    assert.equal((result.content[0] as { text: string }).text, XML_FEED);

    const structured = result.structuredContent as {
      environment: string;
      path: string;
      contentType: string;
      hasMore: boolean;
      totalCount: number;
      cursor: string;
    };
    assert.deepEqual(
      { ...structured, cursor: "<present>" },
      {
        environment: "tenant-a",
        path: "User",
        contentType: "xml",
        hasMore: true,
        totalCount: 96577,
        cursor: "<present>",
      },
    );
    const dataRequest = requests.filter((r) => !r.url.includes("$metadata"))[0]!;
    assert.equal(dataRequest.headers.Accept, "application/atom+xml");

    // The xml cursor replays exactly like the json one.
    const second = await callTool(client, "query_entity", { ...args, cursor: structured.cursor });
    assert.equal(second.isError, undefined);
    const dataRequests = requests.filter((r) => !r.url.includes("$metadata"));
    assert.equal(dataRequests.length, 2);
    assert.equal(new URL(dataRequests[1]!.url).searchParams.get("$skiptoken"), "xml-tok-1");
  });
});

test("output xml without a next link reports hasMore false and no cursor", async () => {
  const configPath = await writeStandardConfig();
  const body = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id></entry></feed>`;
  const { fetch } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return xmlResponse(body);
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      output: "xml",
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { hasMore: boolean; cursor?: string; totalCount?: number };
    assert.equal(structured.hasMore, false);
    assert.equal(structured.cursor, undefined);
    assert.equal(structured.totalCount, undefined);
  });
});

test("output xml rejects responses with more than 1000 entries", async () => {
  const configPath = await writeStandardConfig();
  const entries = Array.from({ length: 1001 }, (_, i) => `<entry><id>e${i}</id></entry>`).join("");
  const body = `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  const { fetch } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return xmlResponse(body);
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      output: "xml",
    });
    const payload = errorPayload(result);
    assert.equal(payload.code, "RESPONSE_INVALID");
    assert.match(payload.message, /xml response exceeds the 1000-record ceiling/);
  });
});

test("output xml at exactly 1000 entries is accepted", async () => {
  const configPath = await writeStandardConfig();
  const entries = Array.from({ length: 1000 }, (_, i) => `<entry><id>e${i}</id></entry>`).join("");
  const body = `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  const { fetch } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return xmlResponse(body);
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      output: "xml",
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.content[0] as { text: string }).text, body);
  });
});

test("a cursor from a json call is rejected on an otherwise identical xml call", async () => {
  const configPath = await writeStandardConfig();
  const { fetch } = recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    return jsonResponse(feed([{ userId: "u1" }], NEXT_WITH_TOKEN));
  });
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const first = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    const cursor = (first.structuredContent as { cursor: string }).cursor;
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User",
      output: "xml",
      cursor,
    });
    assert.equal(errorPayload(result).code, "CURSOR_INVALID");
  });
});

// --- Entity allowlist (FR-28, D-30, DS-P2-03) ----------------------------------

function allowlistConfigJson(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    environments: {
      "tenant-a": {
        baseUrl: "https://tenant-a.example.com",
        auth: { type: "basic", username: "apiuser@tenantA", password: "secret-password-a" },
      },
    },
    entityAllowlist: entries,
  });
}

test("query_entity succeeds for an entity listed in the allowlist", async () => {
  const configPath = await writeConfigFile(allowlistConfigJson([{ entity: "User" }]), { mode: 0o600 });
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([{ userId: "u1" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { recordCount: number; records: unknown[] };
    assert.equal(structured.recordCount, 1);
    const dataRequests = requests.filter((r) => !r.url.includes("$metadata"));
    assert.equal(dataRequests.length, 1);
  });
});

test("entity absent from the allowlist yields ENTITY_NOT_ALLOWED with zero fetches", async () => {
  const configPath = await writeConfigFile(allowlistConfigJson([{ entity: "FOOBar" }]), { mode: 0o600 });
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    const payload = errorPayload(result);
    assert.equal(payload.code, "ENTITY_NOT_ALLOWED");
    assert.equal(payload.message, "the entity is not permitted by the configured entityAllowlist");
    // Generic message: the path/entity is never echoed.
    assert.ok(!payload.message.includes("User"));
    // Denied BEFORE metadata classification: not even $metadata was fetched.
    assert.equal(requests.length, 0);
  });
});

test("allowlist matching is case-sensitive (User listed, user denied)", async () => {
  const configPath = await writeConfigFile(allowlistConfigJson([{ entity: "User" }]), { mode: 0o600 });
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "user" });
    assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
    assert.equal(requests.length, 0);
  });
});

test("a v4-only allowlist entry is denied in this phase (DS-P2-03)", async () => {
  const configPath = await writeConfigFile(
    allowlistConfigJson([{ entity: "User", protocols: ["v4"] }]),
    { mode: 0o600 },
  );
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
    assert.equal(requests.length, 0);
  });
});

test("an entry restricted to [\"v2\"] allows the entity", async () => {
  const configPath = await writeConfigFile(
    allowlistConfigJson([{ entity: "User", protocols: ["v2"] }]),
    { mode: 0o600 },
  );
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([{ userId: "u1" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "User" });
    assert.equal(result.isError, undefined);
    assert.equal(requests.filter((r) => !r.url.includes("$metadata")).length, 1);
  });
});

test("navigation after an allowed first segment is not re-checked against the allowlist", async () => {
  // FOOBar is NOT in the allowlist, but the check only covers the FIRST
  // segment's entity set (D-30: navigation may only start from a listed entity).
  const configPath = await writeConfigFile(allowlistConfigJson([{ entity: "User" }]), { mode: 0o600 });
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([{ id: "x1" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "tenant-a",
      entityPath: "User('u1')/FOOBar",
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { recordCount: number };
    assert.equal(structured.recordCount, 1);
    const dataUrl = new URL(requests.filter((r) => !r.url.includes("$metadata"))[0]!.url);
    assert.equal(dataUrl.pathname, "/odata/v2/User('u1')/FOOBar");
  });
});

test("an empty allowlist array is a configured deny-all for query_entity", async () => {
  const configPath = await writeConfigFile(allowlistConfigJson([]), { mode: 0o600 });
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    for (const entityPath of ["User", "FOOBar"]) {
      const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath });
      assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED", entityPath);
    }
    assert.equal(requests.length, 0);
  });
});

test("get_metadata is never filtered by the allowlist, even a deny-all one", async () => {
  const configPath = await writeConfigFile(allowlistConfigJson([]), { mode: 0o600 });
  const { fetch, requests } = recordingFetch((url) => xmlResponse(SAMPLE_METADATA_XML));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "get_metadata", { environment: "tenant-a" });
    assert.equal(result.isError, undefined);
    assert.equal((result.content[0] as { text: string }).text, SAMPLE_METADATA_XML);
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.url.endsWith("/$metadata"));
  });
});

test("without an allowlist configured, queries are unrestricted as before", async () => {
  const configPath = await writeStandardConfig();
  const { fetch, requests } = recordingFetch(standardSfResponder(feed([{ id: "f1" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "tenant-a", entityPath: "FOOBar" });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { recordCount: number };
    assert.equal(structured.recordCount, 1);
    assert.equal(requests.filter((r) => !r.url.includes("$metadata")).length, 1);
  });
});

// --- OAuth environments (FR-32/FR-33) ----------------------------------------

const OAUTH_ASSERTION = "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz48IZZTIW9u";

function oauthConfigJson(alias: string): string {
  return JSON.stringify({
    environments: {
      [alias]: {
        baseUrl: "https://tenant-oauth.example.com",
        auth: {
          type: "oauth",
          clientId: "api-key-1",
          companyId: "co",
          userId: "SFAPI",
          privateKey: "KEYMAT",
          tokenUrl: "https://auth.example.com/oauth/token",
        },
      },
    },
  });
}

function oauthSfResponder(queryBody: unknown): ReturnType<typeof standardSfResponder> {
  return (url) => {
    if (url.endsWith("/oauth/idp")) return xmlResponse(OAUTH_ASSERTION, 200, { "content-type": "text/plain" });
    if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "TT", expires_in: 3600 });
    if (url.endsWith("/$metadata")) return xmlResponse(SAMPLE_METADATA_XML, 200, { "content-type": "application/xml" });
    return jsonResponse(queryBody);
  };
}

test("list_environments reports the oauth auth type", async () => {
  const configPath = await writeConfigFile(oauthConfigJson("oa-list"), { mode: 0o600 });
  const { fetch } = recordingFetch(() => jsonResponse({}));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "list_environments", {});
    assert.equal(result.isError, undefined);
    const environments = (result.structuredContent as { environments: Array<{ alias: string; authType: string }> })
      .environments;
    assert.deepEqual(environments, [{ alias: "oa-list", authType: "oauth" }]);
  });
});

test("oauth failures are not masked as METADATA_UNAVAILABLE", async () => {
  const configPath = await writeConfigFile(oauthConfigJson("oa-fail"), { mode: 0o600 });
  const { fetch } = recordingFetch((url) =>
    url.endsWith("/oauth/idp")
      ? jsonResponse({ errorHttpCode: "500", errorMessage: "Invalid X.509 private key." }, 500)
      : jsonResponse({}),
  );
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "oa-fail", entityPath: "User" });
    const payload = errorPayload(result);
    assert.equal(payload.code, "OAUTH_ASSERTION_ERROR");
    assert.match(payload.message, /Invalid X\.509 private key/);
    assert.doesNotMatch(payload.message, /KEYMAT|api-key-1/);
  });
});

test("query_entity works end to end for an oauth environment", async () => {
  const configPath = await writeConfigFile(oauthConfigJson("oa-query"), { mode: 0o600 });
  const { fetch, requests } = recordingFetch(oauthSfResponder(feed([{ userId: "1001" }])));
  await withTestServer({ configPath, fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "oa-query", entityPath: "User", top: 5 });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { recordCount: number; records: unknown[] };
    assert.equal(structured.recordCount, 1);
  });
  const posts = requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 2); // idp + token, exactly once
  const dataGets = requests.filter((r) => r.method === "GET");
  assert.equal(dataGets.length, 2); // $metadata (validation) + data page
  assert.equal(dataGets[1]!.headers.Authorization, "Bearer TT");
});
