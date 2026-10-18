import test from "node:test";
import assert from "node:assert/strict";
import { createCursorCodec } from "../src/cursor.js";
import { dispatchGet, envTargetFor } from "../src/http.js";
import { resetOAuthStateForTests } from "../src/oauth.js";
import { metadataCacheFileName } from "../src/metadata.js";
import { resolveTenant, sha256Hex } from "../src/tenancy.js";
import { recordingFetch, xmlResponse, jsonResponse } from "./helpers.js";

test("OAuth tokens for the same alias are isolated by tenant", async () => {
  resetOAuthStateForTests();
  const config = {
    baseUrl: "https://api.example.com",
    auth: { type: "oauth" as const, clientId: "app", companyId: "company", userId: "reader",
      privateKey: "key", tokenUrl: "https://api.example.com/oauth/token",
      idpUrl: "https://api.example.com/oauth/idp" },
  };
  const a = { ...envTargetFor(config, "prod"), tenantId: "acme" };
  const b = { ...envTargetFor(config, "prod"), tenantId: "globex" };
  let tokens = 0;
  const seen: string[] = [];
  const { fetch } = recordingFetch((url, init) => {
    if (url.endsWith("/idp")) return xmlResponse("A".repeat(100));
    if (url.endsWith("/token")) return jsonResponse({ access_token: `token-${++tokens}`, expires_in: 3600 });
    seen.push(init.headers.Authorization!);
    return jsonResponse({ d: { results: [] } });
  });
  for (const target of [a, b, a]) {
    await dispatchGet(target, "User", { accept: "application/json", timeoutMs: 1000, fetchImpl: fetch });
  }
  assert.deepEqual(seen, ["Bearer token-1", "Bearer token-2", "Bearer token-1"]);
});

test("a signed cursor cannot be replayed under another tenant", () => {
  const codec = createCursorCodec();
  const payload = { v: 1 as const, tenantId: "acme", env: "prod", path: "User", options: {}, skiptoken: "next" };
  const token = codec.encode(payload);
  const other = { ...payload, tenantId: "globex" };
  assert.throws(() => codec.decode(token, other), /current query/);
  assert.equal(codec.decode(token, payload).skiptoken, "next");
});

test("tenant and alias cache components cannot collide through separators", () => {
  assert.notEqual(metadataCacheFileName("acme-prod", "dev"), metadataCacheFileName("acme", "prod-dev"));
});

test("a credential shared ambiguously across tenants fails closed", () => {
  const hash = sha256Hex("shared");
  assert.equal(resolveTenant({
    acme: { apiKeyHash: hash, environments: { prod: undefined } },
    globex: { apiKeyHash: hash, environments: { prod: undefined } },
  }, "shared"), null);
});
