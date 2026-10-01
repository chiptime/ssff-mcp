/**
 * OAuth token manager tests (FR-32/FR-33): two-step flow shape, header
 * hygiene (no Authorization on token POSTs), cache/single-flight, skew
 * buffer, 200-with-HTML guard, bounded retries, and secret-free errors.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  getAuthorizationHeader,
  invalidateOAuthToken,
  resetOAuthStateForTests,
  SAML2_BEARER_GRANT,
  type OAuthFetch,
  type OAuthPostInit,
} from "../src/oauth.js";
import { FakeResponse } from "./helpers.js";
import type { OAuthAuthConfig } from "../src/config.js";
import { isSanitizedError } from "../src/errors.js";

const ASSERTION_BODY = "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz48IZZTIW9u"; // base64-ish, > 50 chars
const ACCESS_TOKEN = "token-abc-123";

function oauthConfig(overrides: Partial<OAuthAuthConfig> = {}): OAuthAuthConfig {
  return {
    type: "oauth",
    clientId: "api-key-1",
    companyId: "company-1",
    userId: "SFAPI",
    privateKey: "PRIVATE-KEY-MATERIAL",
    tokenUrl: "https://auth.example.com/oauth/token",
    idpUrl: "https://auth.example.com/oauth/idp",
    ...overrides,
  };
}

interface RecordedPost {
  url: string;
  init: OAuthPostInit;
}

/** POST-only recording fetch; responds per URL with optional scripted failures. */
function makePostFetch(
  handler: (post: RecordedPost, callIndex: number) => FakeResponse,
): { fetch: OAuthFetch; posts: RecordedPost[] } {
  const posts: RecordedPost[] = [];
  const fetch: OAuthFetch = async (url, init) => {
    const post = { url, init };
    posts.push(post);
    return handler(post, posts.length - 1);
  };
  return { fetch, posts };
}

const okAssertion = () => new FakeResponse(200, ASSERTION_BODY, { "content-type": "text/plain" });
const okToken = () =>
  new FakeResponse(200, JSON.stringify({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 }), {
    "content-type": "application/json",
  });

test.beforeEach(() => resetOAuthStateForTests());

test("happy path posts the exact two-step form flow with clean headers", async () => {
  const { fetch, posts } = makePostFetch((post) =>
    post.url.endsWith("/oauth/idp") ? okAssertion() : okToken(),
  );
  const header = await getAuthorizationHeader("env-1", oauthConfig(), { fetchImpl: fetch });

  assert.equal(header, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(posts.length, 2);

  const idp = posts[0]!;
  assert.equal(idp.url, "https://auth.example.com/oauth/idp");
  assert.equal(idp.init.method, "POST");
  assert.equal(idp.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(idp.init.headers.Accept, "text/plain");
  assert.equal(idp.init.headers.Authorization, undefined);
  const idpForm = new URLSearchParams(idp.init.body);
  assert.equal(idpForm.get("client_id"), "api-key-1");
  assert.equal(idpForm.get("user_id"), "SFAPI");
  assert.equal(idpForm.get("token_url"), "https://auth.example.com/oauth/token");
  assert.equal(idpForm.get("private_key"), "PRIVATE-KEY-MATERIAL");

  const token = posts[1]!;
  assert.equal(token.url, "https://auth.example.com/oauth/token");
  assert.equal(token.init.headers.Authorization, undefined);
  const tokenForm = new URLSearchParams(token.init.body);
  assert.equal(tokenForm.get("client_id"), "api-key-1");
  assert.equal(tokenForm.get("grant_type"), SAML2_BEARER_GRANT);
  assert.equal(tokenForm.get("company_id"), "company-1");
  assert.equal(tokenForm.get("assertion"), ASSERTION_BODY);
});

test("a cached token is reused without new fetches", async () => {
  const { fetch, posts } = makePostFetch((post) =>
    post.url.endsWith("/oauth/idp") ? okAssertion() : okToken(),
  );
  const opts = { fetchImpl: fetch, now: () => 1_000_000 };
  await getAuthorizationHeader("env-2", oauthConfig(), opts);
  await getAuthorizationHeader("env-2", oauthConfig(), opts);
  assert.equal(posts.length, 2);
});

test("concurrent callers share one in-flight acquisition", async () => {
  const { fetch, posts } = makePostFetch((post) =>
    post.url.endsWith("/oauth/idp") ? okAssertion() : okToken(),
  );
  const opts = { fetchImpl: fetch, now: () => 5_000_000 };
  const headers = await Promise.all(
    Array.from({ length: 5 }, () => getAuthorizationHeader("env-3", oauthConfig(), opts)),
  );
  assert.deepEqual(headers, Array.from({ length: 5 }, () => `Bearer ${ACCESS_TOKEN}`));
  assert.equal(posts.length, 2); // 1 idp + 1 token, shared
});

test("token refetches once inside the 60s/10% safety window", async () => {
  let fakeNow = 1_000_000;
  const { fetch, posts } = makePostFetch((post) =>
    post.url.endsWith("/oauth/idp") ? okAssertion() : okToken(),
  );
  const opts = { fetchImpl: fetch, now: () => fakeNow };
  await getAuthorizationHeader("env-4", oauthConfig(), opts);
  // expires_in 3600s => safety min(60s, 10%) = 60s; stale 1ms past 3600s-60s.
  fakeNow += 3_540_001;
  await getAuthorizationHeader("env-4", oauthConfig(), opts);
  assert.equal(posts.length, 4);
});

test("200 with an HTML body at the assertion endpoint is rejected", async () => {
  const { fetch } = makePostFetch(
    () => new FakeResponse(200, "<html><body>proxy error</body></html>", { "content-type": "text/html" }),
  );
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      getAuthorizationHeader("env-5", oauthConfig(), {
        fetchImpl: fetch,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    (error: unknown) => {
      assert.ok(isSanitizedError(error));
      assert.match(error.code, /OAUTH_ASSERTION_ERROR|OAUTH_TOKEN_ERROR/);
      assert.match(error.message, /unexpected body/);
      return true;
    },
  );
  assert.deepEqual(sleeps, [500, 1000]); // 3 attempts, 2 sleeps
});

test("a failing attempt retries and succeeds on the second", async () => {
  const { fetch, posts } = makePostFetch((post) => {
    if (post.url.endsWith("/oauth/idp") && posts.length === 1) {
      return new FakeResponse(503, "unavailable");
    }
    return post.url.endsWith("/oauth/idp") ? okAssertion() : okToken();
  });
  const sleeps: number[] = [];
  const header = await getAuthorizationHeader("env-6", oauthConfig(), {
    fetchImpl: fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(header, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(sleeps, [500]);
  assert.equal(posts.length, 3); // idp(503) + idp + token
});

test("terminal failure is sanitized: no secret material in the message", async () => {
  const { fetch } = makePostFetch((post) =>
    post.url.endsWith("/oauth/idp")
      ? okAssertion()
      : new FakeResponse(400, JSON.stringify({ error: "invalid_request", error_description: "bad client" })),
  );
  await assert.rejects(
    () =>
      getAuthorizationHeader("env-7", oauthConfig(), {
        fetchImpl: fetch,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(isSanitizedError(error));
      assert.equal(error.code, "OAUTH_TOKEN_ERROR");
      assert.match(error.message, /status 400/);
      assert.doesNotMatch(error.message, /PRIVATE-KEY-MATERIAL/);
      assert.doesNotMatch(error.message, /api-key-1/);
      assert.doesNotMatch(error.message, /company-1/);
      assert.doesNotMatch(error.message, /SFAPI/);
      return true;
    },
  );
});

test("invalidate forces a fresh acquisition", async () => {
  const { fetch, posts } = makePostFetch((post) =>
    post.url.endsWith("/oauth/idp") ? okAssertion() : okToken(),
  );
  const opts = { fetchImpl: fetch, now: () => 9_000_000 };
  await getAuthorizationHeader("env-8", oauthConfig(), opts);
  invalidateOAuthToken("env-8");
  await getAuthorizationHeader("env-8", oauthConfig(), opts);
  assert.equal(posts.length, 4);
});

test("token endpoint 200 with a JSON payload lacking access_token is rejected", async () => {
  const { fetch } = makePostFetch((post) =>
    post.url.endsWith("/oauth/idp")
      ? okAssertion()
      : new FakeResponse(200, JSON.stringify({ error: "server_error" })),
  );
  await assert.rejects(
    () =>
      getAuthorizationHeader("env-9", oauthConfig(), {
        fetchImpl: fetch,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(isSanitizedError(error));
      assert.equal(error.code, "OAUTH_TOKEN_ERROR");
      assert.match(error.message, /invalid payload/);
      return true;
    },
  );
});

test("SAP errorHttpCode/errorMessage bodies are surfaced sanitized", async () => {
  const { fetch } = makePostFetch(
    () =>
      new FakeResponse(
        500,
        JSON.stringify({ errorHttpCode: "500", errorMessage: "Invalid X.509 private key. See https://help.sap.com/x" }),
      ),
  );
  await assert.rejects(
    () =>
      getAuthorizationHeader("env-10", oauthConfig(), {
        fetchImpl: fetch,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(isSanitizedError(error));
      assert.match(error.code, /OAUTH_(ASSERTION|TOKEN)_ERROR/);
      assert.match(error.message, /Invalid X\.509 private key/);
      assert.doesNotMatch(error.message, /https:\/\//);
      return true;
    },
  );
});
