import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHttpServer } from "../src/server-http.js";
import { sha256Hex } from "../src/tenancy.js";

/** A non-loopback local IPv4 address, so the socket peer is not loopback. */
function externalIpv4(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

const LAN = externalIpv4();

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-token-peer-"));
  const configPath = path.join(dir, "config.json");
  const personal = `ssff_pat_${randomBytes(32).toString("base64url")}`;
  const legacy = `ssff_key_${randomBytes(32).toString("base64url")}`;
  const env = {
    baseUrl: "https://synthetic.example.test",
    auth: { type: "basic", username: "shared-sf-account", password: "synthetic-sf-secret" },
  };
  await fs.writeFile(configPath, JSON.stringify({ tenants: { acme: {
    apiKeyHash: sha256Hex(legacy),
    environments: { prod: env },
    roles: { reader: { environments: ["prod"] } },
    users: { alice: { role: "reader", enabled: true, tokens: [
      { id: "initial", hash: sha256Hex(personal), expiresAt: "2099-01-01T00:00:00Z", revoked: false },
    ] } },
  } } }), { mode: 0o600 });
  const server = await startHttpServer({
    configPath, host: "0.0.0.0", port: 0, disableDiskCache: true,
    allowedHosts: [LAN ?? "127.0.0.1", "127.0.0.1"],
    fetchImpl: async () => { throw new Error("no SAP call expected"); },
    log: () => undefined,
  });
  t.after(async () => {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function initialize(credential: string, address: string) {
    const response = await fetch(`http://${address}:${server.port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "token-peer-test", version: "1" },
      } }),
    });
    const text = await response.text();
    const session = response.headers.get("mcp-session-id");
    if (session !== null) {
      await fetch(`http://${address}:${server.port}/mcp`, { method: "DELETE", headers: {
        Authorization: `Bearer ${credential}`, "Mcp-Session-Id": session,
      } });
    }
    return { status: response.status, text };
  }
  return { personal, legacy, initialize };
}

(LAN === undefined ? test.skip : test)(
  "personal tokens authenticate from any peer, like legacy keys (TLS belongs to the ingress)",
  async (t) => {
    const f = await fixture(t);
    for (const address of [LAN!, "127.0.0.1"]) {
      const personal = await f.initialize(f.personal, address);
      assert.equal(personal.status, 200, `${address}: ${personal.text}`);
      assert.equal((await f.initialize(f.legacy, address)).status, 200, address);
    }
    // An unknown credential is still rejected from a non-loopback peer.
    assert.equal((await f.initialize(`ssff_pat_${randomBytes(32).toString("base64url")}`, LAN!)).status, 401);
  },
);
