/**
 * batch_get tests (FR-29..FR-31, D-28, DS-P2-01/DS-P2-04):
 * - one fixed $batch POST per call, GET-only direct parts (no changesets);
 * - full preflight before the POST (path/allowlist/options/cursor/metadata);
 * - 1..180 item cap and the 1000-record aggregate ceiling (json + xml);
 * - OAuth Bearer + single 401 replay (Basic never retries);
 * - opaque per-item cursors and sanitized per-item errors.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SsffBatchRepository } from "../src/batch.js";
import type { BatchResponseConstructor } from "odata-batch";
import { envTargetFor, type AnyFetchInit, type FetchImpl } from "../src/http.js";
import {
  callTool,
  errorPayload,
  FakeResponse,
  jsonResponse,
  recordingFetch,
  SAMPLE_METADATA_XML,
  withTestServer,
  writeConfigFile,
  writeStandardConfig,
  xmlResponse,
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

// --- fake $batch multipart responses -------------------------------------------

interface BatchPart {
  status: number;
  body: string;
  contentType?: string;
}

function batchBoundaryOf(init: AnyFetchInit): string {
  assert.equal(init.method, "POST");
  const contentType = init.headers["Content-Type"] ?? "";
  const match = /boundary=(batch_\d+)$/.exec(contentType);
  assert.ok(match !== null, `unexpected batch content-type: ${contentType}`);
  return match[1]!;
}

function batchResponse(boundary: string, parts: BatchPart[]): FakeResponse {
  const body =
    parts
      .map((part) => {
        const reason = part.status === 200 ? "OK" : part.status === 401 ? "Unauthorized" : "Error";
        return [
          `--${boundary}`,
          "Content-Type: application/http",
          "Content-Transfer-Encoding: binary",
          "",
          `HTTP/1.1 ${part.status} ${reason}`,
          `Content-Type: ${part.contentType ?? "application/json"}`,
          "",
          part.body,
          "",
        ].join("\r\n");
      })
      .join("") + `--${boundary}--\r\n`;
  return new FakeResponse(200, body, { "content-type": `multipart/mixed; boundary=${boundary}` });
}

interface CapturedBatchPost {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface TestFetch {
  fetchImpl: FetchImpl;
  posts: CapturedBatchPost[];
  requests: Array<{ url: string; method: string; headers: Record<string, string> }>;
}

/** Base responder + request recorder + $batch POST body capture. */
function makeTestFetch(base: FetchImpl): TestFetch {
  const posts: CapturedBatchPost[] = [];
  const { fetch: recFetch, requests } = recordingFetch(base);
  const fetchImpl: FetchImpl = async (url, init) => {
    if (init.method === "POST" && url.includes("$batch")) {
      posts.push({ url, headers: { ...init.headers }, body: init.body });
    }
    return await recFetch(url, init);
  };
  return { fetchImpl, posts, requests };
}

function requestLinesOf(body: string): string[] {
  return body.split("\r\n").filter((line) => /^([A-Za-z]+) \S+ HTTP\/1\.[01]$/.test(line));
}

/** $metadata + one $batch POST responder with per-part JSON bodies. */
function metadataAndBatchHandler(partsFor: (batchCalls: number) => BatchPart[]) {
  let batchCalls = 0;
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    batchCalls += 1;
    return batchResponse(batchBoundaryOf(init), partsFor(batchCalls));
  };
  return base;
}

// --- 1. happy path: one POST, GET-only direct parts, ordered results -------------

test("batch_get dispatches exactly ONE $batch POST with GET-only direct parts and ordered per-item results", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, posts, requests } = makeTestFetch(
    metadataAndBatchHandler(() => [
      { status: 200, body: JSON.stringify(feed([{ userId: "u1" }])) },
      { status: 200, body: JSON.stringify(feed([{ id: "f1" }, { id: "f2" }])) },
    ]),
  );
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [
        { entityPath: "User", select: "userId", top: 1 },
        { entityPath: "FOOBar" },
      ],
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      environment: string;
      output: string;
      results: Array<Record<string, unknown>>;
    };
    assert.equal(structured.environment, "tenant-a");
    assert.equal(structured.output, "json");
    assert.equal(structured.results.length, 2);

    const first = structured.results[0]!;
    assert.deepEqual(
      {
        index: first.index,
        path: first.path,
        success: first.success,
        httpStatus: first.httpStatus,
        recordCount: first.recordCount,
        hasMore: first.hasMore,
      },
      { index: 0, path: "User", success: true, httpStatus: 200, recordCount: 1, hasMore: false },
    );
    assert.deepEqual(first.records, [{ userId: "u1" }]);
    const second = structured.results[1]!;
    assert.equal(second.index, 1);
    assert.equal(second.path, "FOOBar");
    assert.equal(second.recordCount, 2);

    // Exactly ONE $batch POST to the fixed endpoint; the only other call is
    // the (cached) metadata classification GET.
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, "https://tenant-a.example.com/odata/v2/$batch");
    const gets = requests.filter((r) => r.method === "GET");
    assert.equal(gets.length, 1);
    assert.ok(gets.every((r) => r.url.endsWith("/$metadata")));

    // Envelope: controlled outer headers, GET-only, direct parts.
    const post = posts[0]!;
    assert.equal(
      post.headers.Authorization,
      "Basic " + Buffer.from("apiuser@tenantA:secret-password-a").toString("base64"),
    );
    assert.equal(post.headers.Accept, "multipart/mixed");
    assert.match(post.headers["Content-Type"] ?? "", /^multipart\/mixed; boundary=batch_\d+$/);
    assert.equal(post.headers["User-Agent"], "ssff-mcp/0.1.0 (+mcp; linux)");
    assert.equal(Object.keys(post.headers).length, 4);
    const lines = requestLinesOf(post.body);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => line.startsWith("GET ")));
    assert.ok(lines[0]!.includes("User?"));
    assert.ok(!/changeset/i.test(post.body));
    assert.match(post.body, /^--batch_\d+\r\n/);
    assert.match(post.body, /--batch_\d+--$/);
    // Options pass through to the embedded URL with LITERAL $ prefixes:
    // SAP's $batch does not percent-decode inner request targets (verified
    // live: %24top=1 is silently ignored, $top=1 returns 1 record).
    assert.ok(post.body.includes("$select=userId"));
    assert.ok(post.body.includes("$top=1"));
    assert.ok(!post.body.includes("%24"));
  });
});

// --- 2. preflight: any bad item rejects the whole batch before the POST ----------

function allowlistConfigJson(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    environments: {
      "tenant-a": {
        baseUrl: "https://tenant-a.example.com",
        auth: { type: "basic", username: "apiuser@tenantA", password: "secret-password-a" },
        entityAllowlist: entries,
      },
    },
  });
}

test("an item whose entity is absent from the allowlist rejects the batch with zero fetches", async () => {
  const configPath = await writeConfigFile(allowlistConfigJson([{ entity: "FOOBar" }]), { mode: 0o600 });
  const { fetchImpl, requests } = makeTestFetch(async () => new FakeResponse(500, "unused"));
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "FOOBar" }, { entityPath: "User" }],
    });
    assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
    assert.equal(requests.length, 0);
  });
});

test("a function-import item rejects the batch after classification but before the $batch POST", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, requests } = makeTestFetch(async (url) => {
    assert.ok(url.endsWith("/$metadata"), `unexpected dispatch: ${url}`);
    return xmlResponse(SAMPLE_METADATA_XML);
  });
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }, { entityPath: "doThing" }],
    });
    const payload = errorPayload(result);
    assert.equal(payload.code, "FUNCTION_IMPORT_UNSUPPORTED");
    // Metadata classification GET is the ONLY allowed call; no POST happened.
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.url.endsWith("/$metadata"));
  });
});

test("an unknown entity-set item rejects the batch before the $batch POST", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, requests } = makeTestFetch(async (url) => {
    assert.ok(url.endsWith("/$metadata"), `unexpected dispatch: ${url}`);
    return xmlResponse(SAMPLE_METADATA_XML);
  });
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "NotAnEntity" }, { entityPath: "User" }],
    });
    const payload = errorPayload(result);
    assert.equal(payload.code, "PATH_INVALID");
    assert.match(payload.message, /unknown entity set/);
    assert.equal(requests.length, 1); // $metadata classification only
  });
});

test("a $-prefixed path item is rejected by the grammar with zero fetches", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, requests } = makeTestFetch(async () => new FakeResponse(500, "unused"));
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }, { entityPath: "User/$batch" }],
    });
    assert.equal(errorPayload(result).code, "PATH_INVALID");
    assert.equal(requests.length, 0);
  });
});

test("a bad option in any item rejects the batch with zero fetches", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, requests } = makeTestFetch(async () => new FakeResponse(500, "unused"));
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }, { entityPath: "FOOBar", top: 0 }],
    });
    assert.equal(errorPayload(result).code, "OPTION_INVALID");
    assert.equal(requests.length, 0);
  });
});

test("a cursor bound to different options in any item rejects the batch before any new fetch", async () => {
  const configPath = await writeStandardConfig();
  const next = "https://tenant-a.example.com/odata/v2/User?$skiptoken=tok-batch-bind";
  const { fetchImpl, requests } = makeTestFetch(
    metadataAndBatchHandler(() => [{ status: 200, body: JSON.stringify(feed([{ userId: "u1" }], next)) }]),
  );
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    // Produce a cursor bound to {User, top:100} without options.
    const first = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User", top: 100 }],
    });
    const cursor = (first.structuredContent as { results: Array<{ cursor?: string }> }).results[0]!.cursor;
    assert.ok(typeof cursor === "string");
    const requestsBefore = requests.length; // metadata + one $batch POST

    // Same cursor replayed with a DIFFERENT filter: rejected pre-dispatch.
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User", top: 100, filter: "userId eq 'changed'", cursor }],
    });
    const payload = errorPayload(result);
    assert.equal(payload.code, "CURSOR_INVALID");
    assert.ok(!payload.message.includes(cursor));
    assert.equal(requests.length, requestsBefore);
  });
});

// --- 3. item-count caps -----------------------------------------------------------

test("zero requests are rejected by the schema before any network call", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, requests } = makeTestFetch(async () => new FakeResponse(500, "unused"));
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", { environment: "tenant-a", requests: [] });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /Invalid arguments|at least 1/i);
    assert.equal(requests.length, 0);
  });
});

test("more than 180 requests are rejected by the schema before any network call", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, requests } = makeTestFetch(async () => new FakeResponse(500, "unused"));
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const requestsArg = Array.from({ length: 181 }, () => ({ entityPath: "User", top: 1 }));
    const result = await callTool(client, "batch_get", { environment: "tenant-a", requests: requestsArg });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /Invalid arguments|180/i);
    assert.equal(requests.length, 0);
  });
});

// --- 4. injection surfaces ---------------------------------------------------------

test("items cannot express method, headers or absolute URLs (strict schema)", async () => {
  const configPath = await writeStandardConfig();
  const { fetchImpl, requests } = makeTestFetch(async () => new FakeResponse(500, "unused"));
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const injections: Array<Record<string, unknown>> = [
      { entityPath: "User", method: "POST" },
      { entityPath: "User", headers: { "X-Evil": "1" } },
      { entityPath: "User", url: "https://evil.example.com/User" },
      { entityPath: "User", data: { write: true } },
      { entityPath: "User", changeset: [] },
    ];
    for (const injection of injections) {
      const result = await callTool(client, "batch_get", {
        environment: "tenant-a",
        requests: [injection],
      });
      assert.equal(result.isError, true, JSON.stringify(injection));
      assert.match((result.content[0] as { text: string }).text, /Invalid arguments|Unrecognized key/i);
    }
    assert.equal(requests.length, 0);
  });
});

// Direct repository-level validation (defense in depth, independent of the tool).

function repositoryEnvelope(boundary: string, requestLines: string[], extraLines: string[] = []): string {
  const parts = requestLines
    .map(
      (line) =>
        [
          `--${boundary}`,
          "Content-Type: application/http",
          "Content-Transfer-Encoding: binary",
          "",
          line,
          "Accept: application/json",
          "",
          "",
        ].join("\r\n"),
    )
    .join("");
  return parts + extraLines.map((line) => `${line}\r\n`).join("") + `--${boundary}--`;
}

async function expectRepositoryReject(
  batchRequest: string,
  options: { url?: string; contentType?: string; itemCount?: number } = {},
): Promise<string> {
  let dispatched = false;
  const env = envTargetFor(
    { baseUrl: "https://tenant-a.example.com", auth: { type: "basic", username: "u", password: "p" } },
    "tenant-a",
  );
  const repository = new SsffBatchRepository({
    env,
    itemCount: options.itemCount ?? 1,
    output: "json",
    timeoutMs: 1000,
    fetchImpl: async () => {
      dispatched = true;
      return new FakeResponse(200, "");
    },
  });
  const DummyParser = class {} as unknown as BatchResponseConstructor;
  const outcome = await repository
    .send(
      options.url ?? `${env.serviceRoot}$batch`,
      batchRequest,
      { headers: { "Content-Type": options.contentType ?? "multipart/mixed; boundary=batch_123" } },
      "application/json",
      DummyParser,
    )
    .then(
      () => "no-error",
      (err: unknown) => (err as { code?: string }).code ?? "unknown",
    );
  assert.equal(dispatched, false, "repository must reject BEFORE dispatch");
  return outcome;
}

test("repository independently rejects a non-GET inner request line", async () => {
  const body = repositoryEnvelope("batch_123", ["POST User HTTP/1.1"]);
  assert.equal(await expectRepositoryReject(body), "BATCH_INVALID");
});

test("repository independently rejects changeset content", async () => {
  const body = repositoryEnvelope(
    "batch_123",
    ["GET User HTTP/1.1"],
    ["--changeset_abc", "Content-Type: multipart/mixed; boundary=changeset_abc"],
  );
  assert.equal(await expectRepositoryReject(body), "BATCH_INVALID");
});

test("repository independently rejects an inner-request count mismatch", async () => {
  const body = repositoryEnvelope("batch_123", ["GET User HTTP/1.1"]);
  assert.equal(await expectRepositoryReject(body, { itemCount: 2 }), "BATCH_INVALID");
});

test("repository independently rejects absolute inner URLs", async () => {
  const body = repositoryEnvelope("batch_123", ["GET https://evil.example.com/User HTTP/1.1"]);
  assert.equal(await expectRepositoryReject(body), "BATCH_INVALID");
});

test("repository independently rejects a wrong target URL or content type", async () => {
  const body = repositoryEnvelope("batch_123", ["GET User HTTP/1.1"]);
  assert.equal(
    await expectRepositoryReject(body, { url: "https://tenant-a.example.com/odata/v2/User" }),
    "BATCH_INVALID",
  );
  assert.equal(await expectRepositoryReject(body, { contentType: "text/plain" }), "BATCH_INVALID");
});

// --- 5. OAuth: Bearer on the outer POST, one 401 replay; Basic never retries -------

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

test("oauth batch uses Bearer on the $batch POST and replays exactly once after a 401", async () => {
  const configPath = await writeConfigFile(oauthConfigJson("oa-batch"), { mode: 0o600 });
  let batchCalls = 0;
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/oauth/idp")) {
      return xmlResponse(OAUTH_ASSERTION, 200, { "content-type": "text/plain" });
    }
    if (url.endsWith("/oauth/token")) {
      return jsonResponse({ access_token: "TT", expires_in: 3600 });
    }
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    batchCalls += 1;
    if (batchCalls === 1) {
      return jsonResponse({ error: { code: "401", message: { value: "Invalid session" } } }, 401);
    }
    return batchResponse(batchBoundaryOf(init), [{ status: 200, body: JSON.stringify(feed([{ userId: "u1" }])) }]);
  };
  const { fetchImpl, posts } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "oa-batch",
      requests: [{ entityPath: "User", top: 1 }],
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { results: Array<Record<string, unknown>> };
    assert.equal(structured.results[0]!.success, true);

    // One failed POST + exactly one replay; both carried the Bearer header.
    assert.equal(posts.length, 2);
    assert.ok(posts.every((p) => p.headers.Authorization === "Bearer TT"));
  });
});

test("oauth 401 batch replay acquires a fresh token (idp+token hit again)", async () => {
  const configPath = await writeConfigFile(oauthConfigJson("oa-batch2"), { mode: 0o600 });
  let batchCalls = 0;
  let idpCalls = 0;
  let tokenCalls = 0;
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/oauth/idp")) {
      idpCalls += 1;
      return xmlResponse(OAUTH_ASSERTION, 200, { "content-type": "text/plain" });
    }
    if (url.endsWith("/oauth/token")) {
      tokenCalls += 1;
      return jsonResponse({ access_token: "TT2", expires_in: 3600 });
    }
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    batchCalls += 1;
    if (batchCalls === 1) {
      return jsonResponse({}, 401);
    }
    return batchResponse(batchBoundaryOf(init), [{ status: 200, body: JSON.stringify(feed([])) }]);
  };
  const { fetchImpl } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "oa-batch2",
      requests: [{ entityPath: "User" }],
    });
    assert.equal(result.isError, undefined);
    assert.equal(batchCalls, 2);
    // Two full acquisitions: idp x2 + token x2 (invalidation forced a refresh).
    assert.equal(idpCalls, 2);
    assert.equal(tokenCalls, 2);
  });
});

test("basic-auth batch 401 never retries", async () => {
  const configPath = await writeStandardConfig();
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    return jsonResponse({ error: { code: "401", message: { value: "Invalid session" } } }, 401);
  };
  const { fetchImpl, posts } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }],
    });
    const payload = errorPayload(result);
    assert.equal(payload.code, "HTTP_ERROR");
    assert.equal(payload.httpStatus, 401);
    assert.equal(posts.length, 1);
  });
});

// --- 6. per-item cursors -----------------------------------------------------------

test("per-item __next yields an opaque cursor; replay sends the raw skiptoken", async () => {
  const configPath = await writeStandardConfig();
  const next = "https://tenant-a.example.com/odata/v2/User?$skiptoken=tok-batch-page2";
  const { fetchImpl, posts } = makeTestFetch(
    metadataAndBatchHandler((batchCalls) => [
      {
        status: 200,
        body: JSON.stringify(batchCalls === 1 ? feed([{ userId: "u1" }], next) : feed([{ userId: "page2" }])),
      },
    ]),
  );
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const args = { environment: "tenant-a", requests: [{ entityPath: "User", top: 100 }] };
    const first = await callTool(client, "batch_get", args);
    assert.equal(first.isError, undefined);
    const item = (first.structuredContent as { results: Array<Record<string, unknown>> }).results[0]!;
    assert.equal(item.hasMore, true);
    assert.ok(typeof item.cursor === "string" && item.cursor.length > 0);
    const serialized = JSON.stringify(first);
    assert.ok(!serialized.includes("__next"));
    assert.ok(!serialized.includes("tok-batch-page2"));

    const second = await callTool(client, "batch_get", {
      ...args,
      requests: [{ entityPath: "User", top: 100, cursor: item.cursor as string }],
    });
    assert.equal(second.isError, undefined);
    const replayItem = (second.structuredContent as { results: Array<Record<string, unknown>> }).results[0]!;
    assert.deepEqual(replayItem.records, [{ userId: "page2" }]);
    assert.equal(posts.length, 2);
    assert.ok(posts[1]!.body.includes("$skiptoken=tok-batch-page2"));
  });
});

test("batch inner request lines carry literal $ option names (a %24 name is silently ignored by SF)", async () => {
  // Live finding (odd/tasks/odata-query-fidelity.md, L12): SAP's $batch decodes
  // percent-encoding once in option VALUES but matches option NAMES verbatim,
  // so a `%24filter`/`%24top` name is silently ignored and the part returns
  // UNFILTERED data. buildQuery therefore emits literal `$` names and the
  // batch layer embeds the target untouched (no %24 -> $ rewriting).
  const configPath = await writeStandardConfig();
  const next = "https://tenant-a.example.com/odata/v2/User?$skiptoken=tok-decode";
  const { fetchImpl, posts } = makeTestFetch(
    metadataAndBatchHandler(() => [{ status: 200, body: JSON.stringify(feed([{ userId: "u1" }], next)) }]),
  );
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User", filter: "userId eq 'a%24b'", top: 3, inlinecount: "allpages" }],
    });
    assert.equal(result.isError, undefined);
    const line = requestLinesOf(posts[0]!.body)[0]!;
    assert.ok(line.includes("$filter=userId%20eq%20'a%24b'"));
    assert.ok(line.includes("$top=3"));
    assert.ok(line.includes("$inlinecount=allpages"));
    // A literal "%24" inside a VALUE survives verbatim: no URLSearchParams
    // double-encoding (%2524) and no whole-string %24 -> $ rewrite.
    assert.ok(!line.includes("%2524b"));
    assert.ok(!line.includes("%24top"));
    assert.ok(!line.includes("%24inlinecount"));
  });
});

// --- 7. aggregate record ceiling ----------------------------------------------------

test("json aggregate ceiling: total records across items never exceed 1000", async () => {
  const configPath = await writeStandardConfig();
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ userId: `${prefix}${i}` }));
  const { fetchImpl, posts } = makeTestFetch(
    metadataAndBatchHandler(() => [
      { status: 200, body: JSON.stringify(feed(many("a", 600))) },
      { status: 200, body: JSON.stringify(feed(many("b", 600))) },
    ]),
  );
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }],
    });
    assert.equal(result.isError, undefined);
    const results = (result.structuredContent as { results: Array<Record<string, unknown>> }).results;
    assert.equal(results[0]!.recordCount, 600);
    assert.equal(results[0]!.truncatedToCeiling, undefined);
    assert.equal(results[1]!.recordCount, 400);
    assert.equal((results[1]!.records as unknown[]).length, 400);
    assert.equal(results[1]!.truncatedToCeiling, true);
    const total = results.reduce((sum, r) => sum + (r.recordCount as number), 0);
    assert.equal(total, 1000);
    assert.equal(posts.length, 1); // still ONE POST
  });
});

function atomFeed(entries: string, extras = ""): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\r\n' +
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">\r\n' +
    `<m:count>96577</m:count>\r\n${entries}${extras}</feed>`
  );
}

test("xml batch output uses atom Accept on every part and returns sanitized bodies with flags", async () => {
  const configPath = await writeStandardConfig();
  // The blank line between entries exercises the raw-body parser rejoin.
  const entries = "<entry><id>e1</id></entry>\r\n\r\n<entry><id>e2</id></entry>\r\n";
  const feedXml = atomFeed(
    entries,
    '<link rel="next" href="https://tenant-a.example.com/odata/v2/User?$skiptoken=xml-batch-tok"/>\r\n',
  );
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    return batchResponse(batchBoundaryOf(init), [{ status: 200, body: feedXml, contentType: "application/atom+xml" }]);
  };
  const { fetchImpl, posts } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      output: "xml",
      requests: [{ entityPath: "User" }],
    });
    assert.equal(result.isError, undefined);
    const item = (result.structuredContent as { results: Array<Record<string, unknown>> }).results[0]!;
    assert.equal(item.contentType, "xml");
    assert.equal(item.recordCount, 2); // both <entry> elements counted
    assert.equal(item.hasMore, true);
    assert.equal(item.totalCount, 96577);
    assert.ok(typeof item.cursor === "string");
    // The cursor is an opaque envelope (no raw token inside it), and the raw
    // Atom body is returned MINUS the next-link href (DS-P2-06): entries and
    // native fields survive verbatim, but neither the next URL nor the
    // skiptoken ever leaves the process — exactly like query_entity's xml output.
    assert.ok(!item.cursor.includes("xml-batch-tok"));
    const body = item.body as string;
    // Full raw body: the second <entry> survives the parser (blank-line rejoin).
    assert.ok(body.includes("<entry><id>e2</id></entry>"));
    assert.ok(body.includes("<m:count>96577</m:count>"));
    assert.ok(!body.includes("xml-batch-tok"));
    assert.ok(!body.includes("$skiptoken"));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("__next")); // JSON-mode artifact never leaks
    assert.ok(!serialized.includes("xml-batch-tok")); // cursor opaque, href sanitized

    // Inner requests carry Accept: application/atom+xml (never application/xml).
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.body.split("Accept: application/atom+xml").length - 1, 1);
    assert.ok(!posts[0]!.body.includes("Accept: application/xml"));
    assert.equal(posts[0]!.headers.Accept, "multipart/mixed");
  });
});

test("xml aggregate above 1000 entries rejects the whole response sanitized", async () => {
  const configPath = await writeStandardConfig();
  const entries = (n: number) => Array.from({ length: n }, (_, i) => `<entry><id>e${i}</id></entry>`).join("\r\n");
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    return batchResponse(batchBoundaryOf(init), [
      { status: 200, body: atomFeed(entries(600)), contentType: "application/atom+xml" },
      { status: 200, body: atomFeed(entries(600)), contentType: "application/atom+xml" },
    ]);
  };
  const { fetchImpl } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      output: "xml",
      requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }],
    });
    const payload = errorPayload(result);
    assert.equal(payload.code, "RESPONSE_INVALID");
    assert.match(payload.message, /batch xml response exceeds the 1000-record ceiling/);
  });
});

// --- 8. embedded non-2xx parts are sanitized per-item -------------------------------

test("an embedded non-2xx part becomes a sanitized per-item error without failing the call", async () => {
  const configPath = await writeStandardConfig();
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    return batchResponse(batchBoundaryOf(init), [
      { status: 200, body: JSON.stringify(feed([{ userId: "u1" }])) },
      {
        status: 401,
        body: JSON.stringify({
          error: { code: "401", message: { value: "Invalid session; see https://tenant-a.example.com/help" } },
        }),
      },
    ]);
  };
  const { fetchImpl } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }],
    });
    assert.equal(result.isError, undefined);
    const results = (result.structuredContent as { results: Array<Record<string, unknown>> }).results;
    assert.equal(results[0]!.success, true);
    const failed = results[1]!;
    assert.equal(failed.success, false);
    assert.equal(failed.httpStatus, 401);
    const error = failed.error as { code: string; message: string };
    assert.equal(error.code, "HTTP_ERROR");
    assert.ok(error.message.includes("[redacted-url]"));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("https://tenant-a.example.com/help"));
    assert.ok(!serialized.includes("secret-password"));
    assert.ok(!error.message.includes("https://"));
  });
});

test("an embedded success part with an unparseable body becomes a per-item RESPONSE_INVALID error", async () => {
  const configPath = await writeStandardConfig();
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    return batchResponse(batchBoundaryOf(init), [{ status: 200, body: "" }]);
  };
  const { fetchImpl } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }],
    });
    assert.equal(result.isError, undefined);
    const item = (result.structuredContent as { results: Array<Record<string, unknown>> }).results[0]!;
    assert.equal(item.success, false);
    assert.equal((item.error as { code: string }).code, "RESPONSE_INVALID");
  });
});

// --- cross-host redirect defense ----------------------------------------------------

test("a cross-host redirect of the $batch POST is blocked", async () => {
  const configPath = await writeStandardConfig();
  const base: FetchImpl = async (url, init) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML);
    }
    assert.ok(url.includes("$batch") && init.method === "POST", `unexpected dispatch: ${url}`);
    return new FakeResponse(302, "", { location: "https://evil.example.com/odata/v2/$batch" });
  };
  const { fetchImpl } = makeTestFetch(base);
  await withTestServer({ configPath, fetchImpl }, async (client) => {
    const result = await callTool(client, "batch_get", {
      environment: "tenant-a",
      requests: [{ entityPath: "User" }],
    });
    assert.equal(errorPayload(result).code, "REDIRECT_BLOCKED");
  });
});
