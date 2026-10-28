import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../src/server-http.js";
import { sha256Hex } from "../src/tenancy.js";
import type { LocalRole } from "../src/local-auth.js";
import { jsonResponse, recordingFetch, xmlResponse } from "./helpers.js";

const METADATA = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
<edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0">
<Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="SFOData">
<EntityType Name="User"><Key><PropertyRef Name="userId"/></Key>
<Property Name="userId" Type="Edm.String"/><Property Name="name" Type="Edm.String"/>
<Property Name="email" Type="Edm.String"/>
<NavigationProperty Name="manager" Relationship="SFOData.Manager" FromRole="User" ToRole="Manager"/>
</EntityType>
<EntityType Name="FOOBar"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.String"/></EntityType>
<Association Name="Manager"><End Type="SFOData.User" Role="User" Multiplicity="*"/>
<End Type="SFOData.FOOBar" Role="Manager" Multiplicity="0..1"/></Association>
<EntityContainer Name="Container" m:IsDefaultEntityContainer="true">
<EntitySet Name="User" EntityType="SFOData.User"/><EntitySet Name="FOOBar" EntityType="SFOData.FOOBar"/>
<AssociationSet Name="ManagerSet" Association="SFOData.Manager"><End Role="User" EntitySet="User"/>
<End Role="Manager" EntitySet="FOOBar"/></AssociationSet>
</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;

type Config = {
  tenants: Record<string, {
    apiKeyHash?: string;
    environments: Record<string, {
      baseUrl: string;
      auth: { type: "basic"; username: string; password: string };
      entityAllowlist?: Array<{ entity: string; fields?: string[] }>;
    }>;
    roles: Record<string, LocalRole>;
    users: Record<string, {
      role: string;
      enabled: boolean;
      tokens: Array<{ id: string; hash: string; expiresAt: string; revoked: boolean }>;
    }>;
  }>;
};

async function fixture(t: TestContext, generatedToken?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-local-http-"));
  const configPath = path.join(dir, "config.json");
  const token = () => `ssff_pat_${randomBytes(32).toString("base64url")}`;
  const alice = generatedToken ?? token(), bob = token(), other = token(), legacy = token();
  const user = (credential: string, role = "reader") => ({
    role, enabled: true,
    tokens: [{ id: "initial", hash: sha256Hex(credential), expiresAt: "2099-01-01T00:00:00Z", revoked: false }],
  });
  const env = () => ({
    baseUrl: "https://synthetic.example.test",
    auth: { type: "basic" as const, username: "shared-sf-account", password: "synthetic-sf-secret" },
  });
  const config: Config = { tenants: {
    acme: {
      apiKeyHash: sha256Hex(legacy),
      environments: { prod: env(), dev: env() },
      roles: {
        reader: { environments: ["prod"], entityAllowlist: [{ entity: "User", fields: ["name"] }] },
        keys: { environments: ["dev"], entityAllowlist: [{ entity: "User", fields: ["email"] }] },
      },
      users: { alice: user(alice), bob: user(bob) },
    },
    other: {
      environments: { prod: env() },
      roles: { reader: { environments: ["prod"], entityAllowlist: [{ entity: "FOOBar" }] } },
      users: { alice: user(other) },
    },
  } };
  const save = () => fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await save();
  const logs: string[] = [];
  const recordExtras: Record<string, unknown> = {};
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let waiting: Promise<void> | undefined;
  const recorded = recordingFetch(async (url) => {
    if (url.includes("$metadata")) return xmlResponse(METADATA);
    entered?.();
    if (waiting !== undefined) await waiting;
    return jsonResponse({ d: {
      results: [{ userId: "u-1", name: "Sensitive Display Name", email: "private@example.test", ...recordExtras }],
      __next: "https://synthetic.example.test/odata/v2/User?$skiptoken=page-two",
    } });
  });
  const server = await startHttpServer({
    configPath, host: "127.0.0.1", port: 0, disableDiskCache: true,
    fetchImpl: recorded.fetch, log: (line) => logs.push(line),
  });
  t.after(async () => {
    release?.();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  let id = 0;
  async function rpc(credential: string, session: string | undefined, method: string, params = {}) {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session === undefined ? {} : { "Mcp-Session-Id": session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await response.text();
    const data = text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).at(-1)
      : (text.length === 0 ? {} : JSON.parse(text));
    return { response, data };
  }
  async function initialize(credential: string) {
    const result = await rpc(credential, undefined, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-auth-test", version: "1" },
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    const session = result.response.headers.get("mcp-session-id");
    assert.ok(session);
    return session;
  }
  const tool = (credential: string, session: string, name: string, args = {}) =>
    rpc(credential, session, "tools/call", { name, arguments: args });
  return {
    config, save, alice, bob, other, legacy, logs, initialize, rpc, tool, recorded, recordExtras,
    pauseBusiness() {
      waiting = new Promise<void>((resolve) => { release = resolve; });
      return new Promise<void>((resolve) => { entered = resolve; });
    },
    resumeBusiness() { release?.(); waiting = undefined; entered = undefined; },
  };
}

test("local users: valid user gets only its environments, role fields, and shared SSFF credentials", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  const list = await f.tool(f.alice, session, "list_environments");
  assert.deepEqual(list.data.result.structuredContent.environments.map((env: { alias: string }) => env.alias), ["prod"]);
  const denied = await f.tool(f.alice, session, "query_entity", { environment: "dev", entityPath: "User" });
  assert.equal(denied.data.result.isError, true);
  assert.equal(f.recorded.requests.length, 0);
  const result = await f.tool(f.alice, session, "query_entity", { environment: "prod", entityPath: "User" });
  assert.deepEqual(result.data.result.structuredContent.records, [{ userId: "u-1", name: "Sensitive Display Name" }]);
  assert.equal(f.recorded.requests.at(-1)?.headers.Authorization,
    `Basic ${Buffer.from("shared-sf-account:synthetic-sf-secret").toString("base64")}`);
});

test("local users: current role and environment scope replace session permissions on next request", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  f.config.tenants.acme.users.alice.role = "keys";
  await f.save();
  const list = await f.tool(f.alice, session, "list_environments");
  assert.equal(list.response.status, 200);
  assert.deepEqual(list.data.result.structuredContent.environments.map((env: { alias: string }) => env.alias), ["dev"]);
  const denied = await f.tool(f.alice, session, "query_entity", { environment: "prod", entityPath: "User" });
  assert.equal(denied.data.result.isError, true);
  assert.equal(f.recorded.requests.length, 0);
});

test("local users: disabled, expired, revoked and removed tokens reject existing sessions without business requests", async (t) => {
  for (const state of ["disabled", "expired", "revoked", "removed"] as const) {
    await t.test(state, async (sub) => {
      const f = await fixture(sub);
      const session = await f.initialize(f.alice);
      const user = f.config.tenants.acme.users.alice;
      if (state === "disabled") user.enabled = false;
      if (state === "expired") user.tokens[0].expiresAt = "2000-01-01T00:00:00Z";
      if (state === "revoked") user.tokens[0].revoked = true;
      if (state === "removed") user.tokens = [];
      await f.save();
      const result = await f.tool(f.alice, session, "query_entity", { environment: "prod", entityPath: "User" });
      assert.equal(result.response.status, 401);
      assert.equal(f.recorded.requests.length, 0);
      assert.doesNotMatch(f.logs.join("\n"), new RegExp(f.alice));
      if (state !== "removed") {
        const rejection = f.logs.map((line) => JSON.parse(line)).find((entry) => entry.status === 401);
        assert.equal(rejection.userId, "alice");
        assert.equal(rejection.role, undefined, "a rejected credential has no effective role");
      }
    });
  }
});

test("local users: rotation preserves user session, other user/tenant/auth method cannot reuse it", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  for (const credential of [f.bob, f.other, f.legacy]) {
    assert.equal((await f.tool(credential, session, "list_environments")).response.status, 401);
  }
  const rotated = `ssff_pat_${randomBytes(32).toString("base64url")}`;
  f.config.tenants.acme.users.alice.tokens[0].revoked = true;
  f.config.tenants.acme.users.alice.tokens.push({ id: "rotated", hash: sha256Hex(rotated), expiresAt: "2099-01-01T00:00:00Z", revoked: false });
  await f.save();
  assert.equal((await f.tool(f.alice, session, "list_environments")).response.status, 401);
  assert.equal((await f.tool(rotated, session, "list_environments")).response.status, 200);
});

test("local users: environment and role field intersection remains keys-only and XML downgrades", async (t) => {
  const f = await fixture(t);
  f.config.tenants.acme.environments.prod.entityAllowlist = [{ entity: "User", fields: ["email"] }];
  await f.save();
  const session = await f.initialize(f.alice);
  const result = await f.tool(f.alice, session, "query_entity", { environment: "prod", entityPath: "User", output: "xml" });
  assert.equal(result.data.result.structuredContent.outputDowngraded, true);
  assert.deepEqual(result.data.result.structuredContent.records, [{ userId: "u-1" }]);
  const schema = await f.tool(f.alice, session, "inspect_entity", { environment: "prod", entitySet: "User" });
  assert.deepEqual(schema.data.result.structuredContent.properties.map((property: { name: string }) => property.name), ["userId"]);
});

test("local users: denied entity stays denied across navigation, expand, batch, catalog and resources", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  for (const args of [
    { entityPath: "FOOBar" }, { entityPath: "User('u-1')/manager" },
    { entityPath: "User", expand: "manager" }, { entityPath: "User", select: "email" },
  ]) {
    const result = await f.tool(f.alice, session, "query_entity", { environment: "prod", ...args });
    assert.equal(result.data.result.isError, true, JSON.stringify(args));
  }
  const batch = await f.tool(f.alice, session, "batch_get", { environment: "prod", requests: [{ entityPath: "User" }, { entityPath: "FOOBar" }] });
  assert.equal(batch.data.result.isError, true);
  const catalog = await f.tool(f.alice, session, "inspect_entity", { environment: "prod" });
  assert.deepEqual(catalog.data.result.structuredContent.entities.map((entity: { name: string }) => entity.name), ["User"]);
  const resource = await f.rpc(f.alice, session, "resources/read", { uri: "sf://prod/entities/FOOBar" });
  assert.ok(resource.data.error);
  assert.ok(f.logs.map((line) => JSON.parse(line)).some((entry) => entry.userId === "alice" && entry.operation === "resources/read"));
  const overview = await f.rpc(f.alice, session, "resources/read", { uri: "sf://prod/overview" });
  assert.equal(JSON.parse(overview.data.result.contents[0].text).totalEntitySets, 1);
  assert.equal(f.recorded.requests.filter((request) => !request.url.includes("$metadata")).length, 0);
});

test("local users: denied association is hidden from schemas and unsolicited response navigations", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  const schema = await f.tool(f.alice, session, "inspect_entity", { environment: "prod", entitySet: "User" });
  assert.deepEqual(schema.data.result.structuredContent.navigationProperties, []);
  f.recordExtras.manager = { id: "denied-manager-record" };
  const result = await f.tool(f.alice, session, "query_entity", { environment: "prod", entityPath: "User" });
  assert.equal(result.data.result.structuredContent.records[0].manager, undefined);
});

test("local users: cursors cannot cross users, legacy access or a changed role policy", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice), bobSession = await f.initialize(f.bob);
  const args = { environment: "prod", entityPath: "User" };
  const first = await f.tool(f.alice, session, "query_entity", args);
  const cursor = first.data.result.structuredContent.cursor;
  assert.equal(typeof cursor, "string");
  const before = f.recorded.requests.filter((request) => !request.url.includes("$metadata")).length;
  const replay = await f.tool(f.bob, bobSession, "query_entity", { ...args, cursor });
  assert.equal(replay.data.result.structuredContent.code, "CURSOR_INVALID");
  const legacySession = await f.initialize(f.legacy);
  const legacyReplay = await f.tool(f.legacy, legacySession, "query_entity", { ...args, cursor });
  assert.equal(legacyReplay.data.result.structuredContent.code, "CURSOR_INVALID");
  f.config.tenants.acme.roles.reader.entityAllowlist = [{ entity: "User", fields: ["email"] }];
  await f.save();
  const stale = await f.tool(f.alice, session, "query_entity", { ...args, cursor });
  assert.equal(stale.data.result.structuredContent.code, "CURSOR_INVALID");
  assert.equal(f.recorded.requests.filter((request) => !request.url.includes("$metadata")).length, before);
});

test("local users: concurrent requests retain their own policy snapshot and safe audit attribution", async (t) => {
  const f = await fixture(t);
  const aliceSession = await f.initialize(f.alice), bobSession = await f.initialize(f.bob);
  const entered = f.pauseBusiness();
  const first = f.tool(f.alice, aliceSession, "query_entity", { environment: "prod", entityPath: "User" });
  await entered;
  f.config.tenants.acme.users.bob.role = "keys";
  await f.save();
  const second = await f.tool(f.bob, bobSession, "list_environments");
  assert.deepEqual(second.data.result.structuredContent.environments.map((env: { alias: string }) => env.alias), ["dev"]);
  f.resumeBusiness();
  const result = await first;
  assert.deepEqual(result.data.result.structuredContent.records, [{ userId: "u-1", name: "Sensitive Display Name" }]);
  const audit = f.logs.map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.userId === "alice" && entry.role === "reader" && entry.operation === "query_entity"));
  assert.ok(audit.some((entry) => entry.userId === "bob" && entry.role === "keys" && entry.operation === "list_environments"));
  for (const secret of [f.alice, f.bob, "Sensitive Display Name", "private@example.test", "synthetic-sf-secret"]) {
    assert.ok(!f.logs.join("\n").includes(secret));
  }
});

test("local users: picklist cache cannot bypass a role's denied source entities", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  const result = await f.tool(f.alice, session, "resolve_picklist", { environment: "prod", picklistId: "gender" });
  assert.equal(result.data.result.structuredContent.code, "ENTITY_NOT_ALLOWED");
  assert.equal(f.recorded.requests.length, 0);
});

test("local users: concurrent calls on one session cannot replace an in-flight policy snapshot", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  const entered = f.pauseBusiness();
  const first = f.tool(f.alice, session, "query_entity", { environment: "prod", entityPath: "User" });
  await entered;
  f.config.tenants.acme.roles.reader.entityAllowlist = [{ entity: "User", fields: ["email"] }];
  await f.save();
  try {
    const current = await f.tool(f.alice, session, "inspect_entity", { environment: "prod", entitySet: "User" });
    assert.deepEqual(current.data.result.structuredContent.properties.map((property: { name: string }) => property.name), ["userId", "email"]);
  } finally {
    f.resumeBusiness();
  }
  const previous = await first;
  assert.deepEqual(previous.data.result.structuredContent.records, [{ userId: "u-1", name: "Sensitive Display Name" }]);
});

test("local users smoke: CLI-generated token authenticates with only its hash in a clean config", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-local-smoke-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const generated = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../src/index.js", import.meta.url)), "key", "generate",
  ], { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH } });
  assert.equal(generated.stderr, "");
  const credential = JSON.parse(generated.stdout) as { token: string; tokenHash: string };
  assert.equal(credential.tokenHash, sha256Hex(credential.token));
  const f = await fixture(t, credential.token);
  assert.ok(!JSON.stringify(f.config).includes(credential.token));
  const session = await f.initialize(credential.token);
  const permitted = await f.tool(credential.token, session, "query_entity", { environment: "prod", entityPath: "User" });
  assert.equal(permitted.data.result.isError, undefined);
  const rejected = await f.tool(credential.token, session, "query_entity", { environment: "prod", entityPath: "FOOBar" });
  assert.equal(rejected.data.result.structuredContent.code, "ENTITY_NOT_ALLOWED");
});

test("local users: conflicting personal credentials reject, identical headers and legacy precedence remain valid", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  const endpoint = await f.rpc(f.alice, session, "ping");
  const before = f.recorded.requests.length;
  async function withHeaders(bearer: string, key: string, sessionId: string) {
    const response = await fetch(endpoint.response.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`, "X-Api-Key": key, "Mcp-Session-Id": sessionId,
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 991, method: "tools/call", params: { name: "list_environments", arguments: {} } }),
    });
    const text = await response.text();
    return { status: response.status, text };
  }
  for (const other of [f.bob, f.legacy, "unknown-credential"]) {
    const result = await withHeaders(f.alice, other, session);
    assert.equal(result.status, 401, result.text);
    assert.deepEqual(JSON.parse(result.text), { error: "unauthorized" });
  }
  assert.equal((await withHeaders(f.alice, f.alice, session)).status, 200);
  const legacySession = await f.initialize(f.legacy);
  assert.equal((await withHeaders(f.legacy, f.alice, legacySession)).status, 401);
  const secondLegacy = `ssff_pat_${randomBytes(32).toString("base64url")}`;
  f.config.tenants.other.apiKeyHash = sha256Hex(secondLegacy);
  await f.save();
  assert.equal((await withHeaders(f.legacy, secondLegacy, legacySession)).status, 200);
  f.config.tenants.acme.users.alice.tokens[0].revoked = true;
  await f.save();
  for (const [bearer, key, sessionId] of [
    [f.legacy, f.alice, legacySession], [f.alice, f.legacy, session], [f.alice, f.alice, session],
  ]) {
    const result = await withHeaders(bearer, key, sessionId);
    assert.equal(result.status, 401, result.text);
    assert.deepEqual(JSON.parse(result.text), { error: "unauthorized" });
  }
  assert.equal(f.recorded.requests.length, before);
});

test("local users: prompts are served over HTTP, audited by fixed operation name, and never reach SuccessFactors", async (t) => {
  const f = await fixture(t);
  const session = await f.initialize(f.alice);
  const listed = await f.rpc(f.alice, session, "prompts/list");
  assert.deepEqual(listed.data.result.prompts.map((prompt: { name: string }) => prompt.name).sort(),
    ["explore_entity", "prepare_read_query"]);
  const prompt = await f.rpc(f.alice, session, "prompts/get",
    { name: "explore_entity", arguments: { environment: "prod", entitySet: "User" } });
  assert.match(prompt.data.result.messages[0].content.text, /entitySet "User"/);
  const operations = f.logs.map((line) => JSON.parse(line))
    .filter((entry) => entry.userId === "alice").map((entry) => entry.operation);
  assert.ok(operations.includes("prompts/list"), JSON.stringify(operations));
  assert.ok(operations.includes("prompts/get"), JSON.stringify(operations));
  assert.equal(f.recorded.requests.length, 0);
});
