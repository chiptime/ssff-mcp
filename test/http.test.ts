import test from "node:test";
import assert from "node:assert/strict";
import { dispatchGet, envTargetFor, MAX_REDIRECT_HOPS, USER_AGENT } from "../src/http.js";
import { isSanitizedError } from "../src/errors.js";
import {
  FakeResponse,
  jsonResponse,
  redirectResponse,
  recordingFetch,
  xmlResponse,
  type RecordingFetch,
} from "./helpers.js";

const ENV = {
  baseUrl: "https://tenant-a.example.com",
  auth: { type: "basic" as const, username: "apiuser@tenantA", password: "secret-password-a" },
};

const PREFIXED_ENV = {
  baseUrl: "https://tenant-a.example.com/prefix",
  auth: { type: "basic" as const, username: "u", password: "p" },
};

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    if (!isSanitizedError(error)) {
      return false;
    }
    assert.equal(error.code, code);
    return true;
  };
}

test("every request is GET with exactly the allowed header set", async () => {
  const { fetch, requests } = recordingFetch(() => jsonResponse({ d: { results: [] } }));
  await dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "GET");
  const keys = Object.keys(requests[0]!.headers).sort();
  assert.deepEqual(keys, ["Accept", "Authorization", "User-Agent"]);
  const expectedAuth =
    "Basic " + Buffer.from("apiuser@tenantA:secret-password-a", "utf-8").toString("base64");
  assert.equal(requests[0]!.headers.Authorization, expectedAuth);
  assert.equal(requests[0]!.headers.Accept, "application/json");
  assert.equal(requests[0]!.headers["User-Agent"], USER_AGENT);
  assert.match(USER_AGENT, /^ssff-mcp\/0\.1\.0/);
});

test("URL host and path come only from the configured environment", async () => {
  const { fetch, requests } = recordingFetch(() => jsonResponse({ d: {} }));
  await dispatchGet(envTargetFor(PREFIXED_ENV), "User('123')/foo", {
    accept: "application/json",
    timeoutMs: 1000,
    fetchImpl: fetch,
  });
  assert.equal(requests[0]!.url, "https://tenant-a.example.com/prefix/odata/v2/User('123')/foo");
});

test("cross-host redirect is blocked and no host name leaks", async () => {
  const { fetch, requests } = recordingFetch(() => redirectResponse("https://evil.example.com/steal"));
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      const err = expectCode("REDIRECT_BLOCKED")(error) ? (error as Error) : undefined;
      assert.ok(err instanceof Error);
      assert.match(err.message, /redirect to a host different from the configured environment host was blocked/);
      assert.ok(!err.message.includes("evil.example.com"));
      assert.ok(!err.message.includes("tenant-a"));
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test("http-scheme redirect to the same host is blocked", async () => {
  const { fetch } = recordingFetch(() => redirectResponse("http://tenant-a.example.com/odata/v2/User"));
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      const err = expectCode("REDIRECT_BLOCKED")(error) ? (error as Error) : undefined;
      assert.ok(err instanceof Error);
      assert.match(err.message, /non-https/);
      assert.ok(!err.message.includes("tenant-a"));
      return true;
    },
  );
});

test("same-host https redirects are followed with GET and bounded to 5 hops", async () => {
  let calls = 0;
  const { fetch, requests } = recordingFetch(() => {
    calls += 1;
    if (calls <= 2) {
      return redirectResponse("https://tenant-a.example.com/odata/v2/User?page=" + calls);
    }
    return jsonResponse({ d: { results: [{ ok: true }] } });
  });
  const result = await dispatchGet(envTargetFor(ENV), "User", {
    accept: "application/json",
    timeoutMs: 1000,
    fetchImpl: fetch,
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.method === "GET"));
  assert.match(result.body, /results/);
});

test("same-host redirect with explicit default port :443 is allowed", async () => {
  let calls = 0;
  const { fetch, requests } = recordingFetch(() => {
    calls += 1;
    if (calls === 1) {
      return redirectResponse("https://tenant-a.example.com:443/odata/v2/User");
    }
    return jsonResponse({ d: {} });
  });
  await dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch });
  assert.equal(requests.length, 2);
});

test("a redirect loop stops after 5 followed hops", async () => {
  const { fetch, requests } = recordingFetch(
    () => redirectResponse("https://tenant-a.example.com/odata/v2/User?loop=1"),
  );
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      const err = expectCode("REDIRECT_BLOCKED")(error) ? (error as Error) : undefined;
      assert.ok(err instanceof Error);
      assert.match(err.message, /too many redirects/);
      return true;
    },
  );
  // 1 initial request + 5 followed redirects = 6 fetches, then blocked.
  assert.equal(requests.length, MAX_REDIRECT_HOPS + 1);
});

test("abort on timeout yields TIMEOUT", async () => {
  const { fetch } = recordingFetch(
    (_url, init) =>
      new Promise<FakeResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      }),
  );
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 25, fetchImpl: fetch }),
    (error: unknown) => {
      const err = expectCode("TIMEOUT")(error) ? (error as Error) : undefined;
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/);
      assert.ok(!err.message.includes("tenant-a"));
      return true;
    },
  );
});

test("fetch rejection yields generic NETWORK_ERROR without hostnames", async () => {
  const { fetch } = recordingFetch(() => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND tenant-a.example.com");
  });
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      const err = expectCode("NETWORK_ERROR")(error) ? (error as Error) : undefined;
      assert.ok(err instanceof Error);
      assert.equal(err.message, "request to the configured environment failed");
      assert.ok(!err.message.includes("tenant-a"));
      assert.ok(!err.message.includes("ENOTFOUND"));
      return true;
    },
  );
});

test("401 with an OData JSON error body becomes a sanitized HTTP_ERROR", async () => {
  const { fetch } = recordingFetch(
    () =>
      new FakeResponse(
        401,
        JSON.stringify({
          error: {
            code: "401",
            message: { value: "Invalid session or token; see https://tenant-a.example.com/help for help" },
          },
        }),
      ),
  );
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      if (!isSanitizedError(error)) {
        return false;
      }
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.httpStatus, 401);
      assert.match(error.message, /^status 401/);
      assert.match(error.message, /401: Invalid session/);
      assert.ok(error.message.includes("[redacted-url]"));
      assert.ok(!error.message.includes("https://"));
      return true;
    },
  );
});

test("XML error bodies are parsed into a sanitized HTTP_ERROR", async () => {
  const { fetch } = recordingFetch(
    () =>
      xmlResponse(
        `<error xmlns="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
           <code>QUERY_LIMIT_EXCEEDED</code>
           <message xml:lang="en">query &amp; scope too large</message>
         </error>`,
        400,
      ),
  );
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      if (!isSanitizedError(error)) {
        return false;
      }
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.httpStatus, 400);
      assert.match(error.message, /QUERY_LIMIT_EXCEEDED: query & scope too large/);
      return true;
    },
  );
});

test("unparseable error bodies fall back to a generic reason phrase", async () => {
  const { fetch } = recordingFetch(() => new FakeResponse(500, "<html>gateway barf</ht"));
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      if (!isSanitizedError(error)) {
        return false;
      }
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.httpStatus, 500);
      assert.match(error.message, /^status 500/);
      assert.ok(!error.message.includes("gateway"));
      return true;
    },
  );
});

test("long service error messages are clamped", async () => {
  const longMessage = "x".repeat(2000);
  const { fetch } = recordingFetch(
    () => new FakeResponse(400, JSON.stringify({ error: { code: "C", message: { value: longMessage } } })),
  );
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      if (!isSanitizedError(error)) {
        return false;
      }
      assert.ok(error.message.length <= 510);
      return true;
    },
  );
});

// --- OAuth (FR-32/FR-33) ----------------------------------------------------

const OAUTH_ASSERTION = "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz48IZZTIW9u";

const OAUTH_ENV = {
  baseUrl: "https://tenant-oauth.example.com",
  auth: {
    type: "oauth" as const,
    clientId: "api-key-1",
    companyId: "co",
    userId: "SFAPI",
    privateKey: "KEYMAT",
    tokenUrl: "https://auth.example.com/oauth/token",
    idpUrl: "https://auth.example.com/oauth/idp",
  },
};

test("oauth environments attach a Bearer header acquired via the two POSTs", async () => {
  const { fetch, requests } = recordingFetch((url) => {
    if (url.endsWith("/oauth/idp")) return xmlResponse(OAUTH_ASSERTION, 200, { "content-type": "text/plain" });
    if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "T1", expires_in: 3600 });
    return jsonResponse({ d: { results: [] } });
  });
  await dispatchGet(envTargetFor(OAUTH_ENV, "oa-http-1"), "User", {
    accept: "application/json",
    timeoutMs: 1000,
    fetchImpl: fetch,
  });

  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.method, "POST");
  assert.equal(requests[0]!.headers.Authorization, undefined);
  assert.equal(requests[1]!.method, "POST");
  assert.equal(requests[1]!.headers.Authorization, undefined);
  assert.equal(requests[2]!.method, "GET");
  assert.equal(requests[2]!.headers.Authorization, "Bearer T1");
});

test("a 401 on a data read invalidates the token and retries exactly once", async () => {
  let dataCalls = 0;
  const { fetch, requests } = recordingFetch((url) => {
    if (url.endsWith("/oauth/idp")) return xmlResponse(OAUTH_ASSERTION, 200, { "content-type": "text/plain" });
    if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "T2", expires_in: 3600 });
    dataCalls += 1;
    if (dataCalls === 1) return jsonResponse({ error: { code: "Unauthorized" } }, 401);
    return jsonResponse({ d: { results: [] } });
  });
  const result = await dispatchGet(envTargetFor(OAUTH_ENV, "oa-http-2"), "User", {
    accept: "application/json",
    timeoutMs: 1000,
    fetchImpl: fetch,
  });
  assert.equal(result.status, 200);

  const dataGets = requests.filter((r) => r.method === "GET");
  assert.equal(dataGets.length, 2);
  assert.equal(dataGets[1]!.headers.Authorization, "Bearer T2");
  assert.equal(requests.filter((r) => r.method === "POST").length, 4); // 2 acquisitions
});

test("a second 401 surfaces as a sanitized HTTP_ERROR", async () => {
  const { fetch } = recordingFetch((url) => {
    if (url.endsWith("/oauth/idp")) return xmlResponse(OAUTH_ASSERTION, 200, { "content-type": "text/plain" });
    if (url.endsWith("/oauth/token")) return jsonResponse({ access_token: "T3", expires_in: 3600 });
    return jsonResponse({ error: { code: "Unauthorized" } }, 401);
  });
  await assert.rejects(
    () =>
      dispatchGet(envTargetFor(OAUTH_ENV, "oa-http-3"), "User", {
        accept: "application/json",
        timeoutMs: 1000,
        fetchImpl: fetch,
      }),
    (error: unknown) => {
      assert.ok(isSanitizedError(error));
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.httpStatus, 401);
      return true;
    },
  );
});

test("basic environments do not retry on 401", async () => {
  const { fetch, requests } = recordingFetch(() => jsonResponse({ error: { code: "Unauthorized" } }, 401));
  await assert.rejects(
    () => dispatchGet(envTargetFor(ENV), "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch }),
    (error: unknown) => {
      assert.ok(isSanitizedError(error));
      assert.equal(error.code, "HTTP_ERROR");
      return true;
    },
  );
  assert.equal(requests.length, 1);
});
