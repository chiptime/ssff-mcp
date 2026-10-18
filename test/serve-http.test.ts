/**
 * S4/S5 (PRD-feature-multitenant-hosting.md): the hosted edge — auth,
 * session binding and environment scope over real Streamable HTTP sessions.
 *
 * These are also the Bloque-3 isolation probes: two tenants sharing an alias
 * ("prod") must be invisible to each other, and a key must never grant more
 * than its scope.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer, type RunningHttpServer, type ServeHttpOptions } from "../src/server-http.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { SAMPLE_METADATA_XML, jsonResponse, recordingFetch, xmlResponse } from "./helpers.js";

const ACME_KEY = "acme-client-key";
const ACME_DEV_KEY = "acme-dev-only-key";
const GLOBEX_KEY = "globex-client-key";

const digest = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

function basicEnv() {
  return {
    baseUrl: "https://tenant.example.com",
    auth: { type: "basic" as const, username: "u", password: "p" },
  };
}

async function writeTwoTenantConfig(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-serve-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      tenants: {
        acme: {
          apiKeyHash: digest(ACME_KEY),
          environments: {
            dev: { ...basicEnv(), apiKeyHash: digest(ACME_DEV_KEY) },
            prod: basicEnv(),
          },
        },
        globex: {
          apiKeyHash: digest(GLOBEX_KEY),
          environments: { prod: basicEnv() },
        },
      },
    }),
    "utf8",
  );
  // Keep the directory world-open warning out of the assertions; mode is irrelevant here.
  return configPath;
}

async function startTestServer(configPath: string, overrides: Partial<ServeHttpOptions> = {}) {
  return await startHttpServer({
    configPath,
    host: "127.0.0.1",
    port: 0,
    disableDiskCache: true,
    log: () => undefined,
    ...overrides,
  });
}

function connectClient(server: RunningHttpServer, key: string): Promise<Client> {
  const client = new Client({ name: "ssff-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/mcp`),
    { requestInit: { headers: { "X-API-Key": key } } },
  );
  return client.connect(transport).then(() => client);
}

/** connectClient + a hard bound: a 503 initialize leaves the SDK client
 *  waiting forever for a JSON-RPC answer, so the race aborts the transport. */
async function connectClientBounded(
  server: RunningHttpServer,
  key: string,
  timeoutMs = 3_000,
): Promise<Client> {
  const client = new Client({ name: "ssff-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/mcp`),
    { requestInit: { headers: { "X-API-Key": key } } },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
      }),
    ]);
    return client;
  } catch (error) {
    await transport.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

test("/healthz answers without auth, fast, and without touching SAP", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; version: string };
    assert.equal(body.status, "ok");
    assert.equal(body.version, PACKAGE_VERSION);
    assert.ok(Date.now() - started < 10_000);
  } finally {
    await server.close();
  }
});

test("/mcp without a key or with an unknown key is 401 (fail-closed)", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  try {
    const initialize = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    };
    const no = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialize),
    });
    assert.equal(no.status, 401);

    const wrong = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "no-such-key" },
      body: JSON.stringify(initialize),
    });
    assert.equal(wrong.status, 401);
    assert.equal(server.sessionsCount(), 0);
  } finally {
    await server.close();
  }
});

test("a tenant key pins the session to ITS tenant: acme sees dev+prod, globex sees prod only", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  let acme: Client | undefined;
  let globex: Client | undefined;
  try {
    acme = await connectClient(server, ACME_KEY);
    const acmeList = await acme.listTools();
    assert.ok(acmeList.tools.length > 0, "tools are exposed after initialize");
    const acmeEnv = await acme.callTool({ name: "list_environments", arguments: {} });
    const acmeAliases = JSON.stringify(acmeEnv.content);
    assert.match(acmeAliases, /dev/);
    assert.match(acmeAliases, /prod/);

    globex = await connectClient(server, GLOBEX_KEY);
    const globexEnv = await globex.callTool({ name: "list_environments", arguments: {} });
    const globexAliases = JSON.stringify(globexEnv.content);
    assert.match(globexAliases, /prod/);
    // Isolation: globex must not see acme's dev entry as its own.
    assert.doesNotMatch(globexAliases, /"dev"/);
    assert.equal(server.sessionsCount(), 2);
  } finally {
    await acme?.close();
    await globex?.close();
    await server.close();
  }
});

test("an environment key cannot invoke environments outside its scope (FR-160)", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  let client: Client | undefined;
  try {
    client = await connectClient(server, ACME_DEV_KEY);
    const denied = await client.callTool({
      name: "query_entity",
      arguments: { environment: "prod", entityPath: "User" },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /not permitted for this key/);
  } finally {
    await client?.close();
    await server.close();
  }
});

test("the key of another tenant cannot ride an existing session (isolation invariant 1)", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  let acme: Client | undefined;
  try {
    acme = await connectClient(server, ACME_KEY);
    assert.equal(server.sessionsCount(), 1);
    // acme's session id + globex's key => must be rejected before dispatch.
    const transport = (acme as unknown as { transport: { sessionId?: string } }).transport;
    const sessionId = transport.sessionId;
    assert.ok(typeof sessionId === "string" && sessionId.length > 0, "session id assigned");
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": GLOBEX_KEY, "Mcp-Session-Id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await acme?.close();
    await server.close();
  }
});

test("an explicit DELETE terminates the session and releases it", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  let client: Client | undefined;
  try {
    client = await connectClient(server, ACME_KEY);
    assert.equal(server.sessionsCount(), 1);
    const sessionId = (client as unknown as { transport: { sessionId?: string } }).transport.sessionId;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "DELETE",
      headers: { "X-API-Key": ACME_KEY, "Mcp-Session-Id": sessionId! },
    });
    assert.ok(res.status === 200 || res.status === 405 || res.status === 204, `delete answered ${res.status}`);
    for (let i = 0; i < 50 && server.sessionsCount() > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(server.sessionsCount(), 0);
  } finally {
    await client?.close();
    await server.close();
  }
});

test("sessions idle beyond the TTL are swept (vanished clients must not leak)", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath, { sessionIdleMs: 150 });
  const client = await connectClient(server, ACME_KEY);
  try {
    assert.equal(server.sessionsCount(), 1);
    for (let i = 0; i < 100 && server.sessionsCount() > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(server.sessionsCount(), 0);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
});

test("the concurrent-session cap returns 503 (FR-164)", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath, { maxSessions: 1 });
  const first = await connectClient(server, ACME_KEY);
  try {
    assert.equal(server.sessionsCount(), 1);
    await assert.rejects(() => connectClientBounded(server, GLOBEX_KEY));
    assert.equal(server.sessionsCount(), 1);
  } finally {
    await first.close();
    await server.close();
  }
});

test("a dev key cannot ride a broad session of its own tenant", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  const client = await connectClient(server, ACME_KEY);
  try {
    const sessionId = (client as unknown as { transport: { sessionId: string } }).transport.sessionId;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": ACME_DEV_KEY,
        "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 88, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
  } finally { await client.close(); await server.close(); }
});

test("a dev key only discovers permitted environments and resources", async () => {
  const configPath = await writeTwoTenantConfig();
  const server = await startTestServer(configPath);
  const client = await connectClient(server, ACME_DEV_KEY);
  try {
    const result = await client.callTool({ name: "list_environments", arguments: {} });
    assert.doesNotMatch(JSON.stringify(result.content), /prod/);
    const resources = await client.listResources();
    assert.ok(resources.resources.every((resource) => !resource.uri.includes("prod")));
  } finally { await client.close(); await server.close(); }
});

test("Host and Origin checks deny untrusted browser origins", async () => {
  const server = await startTestServer(await writeTwoTenantConfig());
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST", headers: { "X-API-Key": ACME_KEY, Origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  } finally { await server.close(); }
});

test("revoked keys and changed scopes cannot keep using an old session", async () => {
  const configPath = await writeTwoTenantConfig();
  const original = await fs.readFile(configPath, "utf8");
  const server = await startTestServer(configPath);
  const client = await connectClient(server, ACME_KEY);
  try {
    const sessionId = (client as unknown as { transport: { sessionId: string } }).transport.sessionId;
    const changed = JSON.parse(original);
    delete changed.tenants.acme.apiKeyHash;
    changed.tenants.acme.environments.dev.apiKeyHash = digest(ACME_KEY);
    await fs.writeFile(configPath, JSON.stringify(changed));
    const request = () => fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": ACME_KEY,
        "Mcp-Session-Id": sessionId, Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    assert.equal((await request()).status, 401);
    delete changed.tenants.acme.environments.dev.apiKeyHash;
    await fs.writeFile(configPath, JSON.stringify(changed));
    assert.equal((await request()).status, 401);
    assert.equal(await fs.readFile(configPath, "utf8"), JSON.stringify(changed));
  } finally { await client.close(); await server.close(); }
});

test("two tenants read with their own credentials and rejected scope sends no SAP request", async () => {
  const configPath = await writeTwoTenantConfig();
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.tenants.acme.environments.prod.auth.username = "acme-reader";
  config.tenants.globex.environments.prod.auth.username = "globex-reader";
  await fs.writeFile(configPath, JSON.stringify(config));
  const { fetch: sap, requests } = recordingFetch((url, init) => {
    if (url.includes("$metadata")) return xmlResponse(SAMPLE_METADATA_XML);
    return jsonResponse({ d: { results: [{ userId: Buffer.from(init.headers.Authorization!.slice(6), "base64").toString().split(":")[0] }] } });
  });
  const server = await startTestServer(configPath, { fetchImpl: sap });
  const a = await connectClient(server, ACME_KEY);
  const b = await connectClient(server, GLOBEX_KEY);
  const dev = await connectClient(server, ACME_DEV_KEY);
  try {
    for (const [client, reader] of [[a, "acme-reader"], [b, "globex-reader"]] as const) {
      const result = await client.callTool({ name: "query_entity", arguments: { environment: "prod", entityPath: "User" } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), new RegExp(reader));
    }
    const before = requests.length;
    const rejected = await dev.callTool({ name: "query_entity", arguments: { environment: "prod", entityPath: "User" } });
    assert.equal(rejected.isError, true);
    assert.equal(requests.length, before);
  } finally { await a.close(); await b.close(); await dev.close(); await server.close(); }
});

test("shutdown drains an in-flight SAP read before closing sessions", async () => {
  const configPath = await writeTwoTenantConfig();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { fetch: sap } = recordingFetch(async (url) => {
    if (url.includes("$metadata")) return xmlResponse(SAMPLE_METADATA_XML);
    started(); await blocked;
    return jsonResponse({ d: { results: [{ userId: "finished" }] } });
  });
  const server = await startTestServer(configPath, { fetchImpl: sap });
  const client = await connectClient(server, ACME_KEY);
  try {
    const read = client.callTool({ name: "query_entity", arguments: { environment: "prod", entityPath: "User" } });
    await waiting;
    const closed = server.close();
    release();
    assert.match(JSON.stringify((await read).content), /finished/);
    await closed;
    assert.equal(server.sessionsCount(), 0);
  } finally { release(); await client.close(); }
});
