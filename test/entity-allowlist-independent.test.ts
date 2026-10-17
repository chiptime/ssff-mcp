import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type AllowlistEntry } from "../src/config.js";
import { buildConfigFromAnswers } from "../src/cli/init.js";
import { callTool, FakeResponse, jsonResponse, recordingFetch, withTestServer, xmlResponse } from "./helpers.js";

const names = ["User", "FOOBar", "cust_One", "cust_Two"];
const metadata = `<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices><Schema Namespace="P" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">${names.map(n => `<EntityType Name="${n}"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.String"/></EntityType>`).join("")}<EntityContainer Name="C">${names.map(n => `<EntitySet Name="${n}" EntityType="P.${n}"/>`).join("")}</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
const environment = (entityAllowlist?: AllowlistEntry[]) => ({
  baseUrl: "https://probe.example.com", auth: { type: "basic", username: "u", password: "p" },
  ...(entityAllowlist === undefined ? {} : { entityAllowlist }),
});
async function configFile(value: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "allowlist-independent-"));
  const p = path.join(dir, "config.json");
  await fs.writeFile(p, JSON.stringify(value), { mode: 0o600 });
  return p;
}
async function unchanged<T>(p: string, action: () => Promise<T>): Promise<T> {
  const digest = async () => createHash("sha256").update(await fs.readFile(p)).digest("hex");
  const before = await digest();
  try { return await action(); } finally { assert.equal(await digest(), before); }
}

test("S1/S2/S4/S5: config migration, inline mapping and writer round trips", async () => {
  for (const allowlist of [undefined, [], ["User"]]) {
    const raw = buildConfigFromAnswers({ authType: "basic", alias: "prod", baseUrl: "https://probe.example.com", username: "u", password: "p", ...(allowlist === undefined ? {} : { allowlist }) });
    const p = await configFile(raw);
    const loaded = await loadConfig({ configPath: p, env: {} });
    assert.deepEqual(loaded.environments.prod!.entityAllowlist, allowlist?.map(entity => ({ entity })));
    assert.equal(Object.hasOwn(raw, "entityAllowlist"), false);
  }
  for (const value of [null, [], {}, false, 0, "", [{ entity: "User" }]]) {
    const p = await configFile({ environments: { prod: environment() }, entityAllowlist: value });
    await unchanged(p, () => assert.rejects(loadConfig({ configPath: p, env: {} }), {
      code: "CONFIG_INVALID",
      message: `configuration file at ~/.config/ssff-mcp/config.json is invalid: "entityAllowlist" is no longer supported at the top level; define it inside each environment as environments.<alias>.entityAllowlist`,
    }));
  }
  for (const value of [null, [], [{ entityAllowlist: [] }], { environments: { prod: { ...environment(), entityAllowlist: [{ entity: "User" }, { entity: "User" }] } } }, { environments: { prod: { ...environment(), entityAllowlist: [{ entity: "User", protocols: [] }] } } }, JSON.parse(`{"environments":{},"__proto__":{"entityAllowlist":[]}}`)]) {
    const p = await configFile(value);
    await unchanged(p, () => assert.rejects(loadConfig({ configPath: p, env: {} }), { code: "CONFIG_INVALID" }));
  }
  const missing = path.join(await fs.mkdtemp(path.join(tmpdir(), "inline-")), "missing.json");
  const loaded = await loadConfig({ configPath: missing, env: { SF_BASE_URL: "https://probe.example.com", SF_USERNAME: "u", SF_PASSWORD: "p", SF_ENVIRONMENT: "inline", SF_ENTITY_ALLOWLIST: "User, FOOBar" } });
  assert.deepEqual(loaded.environments.inline!.entityAllowlist, [{ entity: "User" }, { entity: "FOOBar" }]);
  assert.equal(Object.hasOwn(loaded, "entityAllowlist"), false);
  const template = (await fs.readFile("config.template.json", "utf8")).replace(/<([^>]+)>/g, (_, n: string) => `probe-${n}`);
  assert.equal(template.includes("entityAllowlist"), false);
  const p = await configFile(JSON.parse(template));
  assert.equal(Object.keys((await loadConfig({ configPath: p, env: {}, resolveSecretsFor: "none" })).environments).length, 3);
});

test("S1/S3/S5/S6/S8: scope matrix, cold denials, first segment and cache", async () => {
  const lists: Record<string, AllowlistEntry[] | undefined> = {
    prod: [{ entity: "User" }, { entity: "cust_One" }], dev: [{ entity: "FOOBar" }, { entity: "cust_Two" }],
    open: undefined, empty: [], v4: [{ entity: "User", protocols: ["v4"] }], v2: [{ entity: "User", protocols: ["v2"] }],
  };
  // An EMPTY allowlist narrows nothing, exactly like an absent one.
  const allowedFor = (list: AllowlistEntry[] | undefined): string[] =>
    list === undefined || list.length === 0
      ? names
      : list.filter((e) => e.protocols === undefined || e.protocols.includes("v2")).map((e) => e.entity);
  const p = await configFile({ environments: Object.fromEntries(Object.entries(lists).map(([a, l]) => [a, environment(l)])) });
  const cacheDir = path.join(path.dirname(p), "cache");
  const { fetch, requests } = recordingFetch((url, init) => {
    if (url.endsWith("/$metadata")) return xmlResponse(metadata);
    if (url.endsWith("/$batch")) return new FakeResponse(200, `--p\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"d":{"results":[]}}\r\n--p--\r\n`, { "content-type": "multipart/mixed; boundary=p" });
    return jsonResponse({ d: { results: [] } });
  });
  await withTestServer({ configPath: p, cacheDir, fetchImpl: fetch, logSink: () => {} }, async client => {
    const read = async (uri: string): Promise<Record<string, unknown>> => unchanged(p, async () => { const item = (await client.readResource({ uri })).contents[0]!; assert.ok("text" in item); return JSON.parse(item.text) as Record<string, unknown>; });
    const query = async (alias: string, entityPath: string) => unchanged(p, () => callTool(client, "query_entity", { environment: alias, entityPath }));
    const first = await query("prod", "FOOBar");
    assert.deepEqual(first.structuredContent, { code: "ENTITY_NOT_ALLOWED", message: "the entity is not permitted by the configured entityAllowlist" });
    assert.equal(requests.length, 0);
    for (const alias of [...Object.keys(lists), "dev", "prod"]) {
      const allowed = allowedFor(lists[alias]);
      // Only a NON-EMPTY allowlist narrows; `[]` behaves exactly like absent.
      const narrows = lists[alias] !== undefined && lists[alias]!.length > 0;
      for (const name of [...names, "user", "UserExtra"]) {
        for (const method of ["query_entity", "batch_get", "inspect_entity"]) {
          const before: number = requests.length;
          const args = { environment: alias, ...(method === "batch_get" ? { requests: [{ entityPath: name }] } : method === "inspect_entity" ? { entitySet: name } : { entityPath: name }) };
          const r = await unchanged(p, () => callTool(client, method, args));
          if (allowed.includes(name)) assert.equal(r.isError, undefined);
          else { assert.equal(r.structuredContent?.code, narrows ? "ENTITY_NOT_ALLOWED" : (method === "inspect_entity" ? "RESOURCE_NOT_FOUND" : "PATH_INVALID")); if (narrows) assert.equal(requests.length, before); }
        }
        const uri = `sf://${alias}/entities/${name}`;
        if (allowed.includes(name)) assert.equal((await read(uri)).entitySet, name);
        else await assert.rejects(read(uri), /ENTITY_NOT_ALLOWED|not found/);
      }
      for (const uri of [`sf://${alias}/entities`, `sf://${alias}/mdf/custom`]) {
        const body = await read(uri);
        assert.deepEqual((body.entities as Array<{ name: string }>).map(e => e.name).sort(), allowed.filter(n => !uri.endsWith("custom") || n.startsWith("cust_")).sort());
      }
      for (const customOnly of [false, true]) {
        const r = await unchanged(p, () => callTool(client, "inspect_entity", { environment: alias, customOnly }));
        assert.deepEqual((r.structuredContent!.entities as Array<{ name: string }>).map(e => e.name).sort(), allowed.filter(n => !customOnly || n.startsWith("cust_")).sort());
      }
      const overview = await read(`sf://${alias}/overview`);
      assert.equal(overview.allowlistConfigured, lists[alias] !== undefined && lists[alias]!.length > 0);
      assert.equal(overview.denylistConfigured, false);
    }
    // The fixture metadata models no navigation, so the hop cannot be resolved:
    // it must fail closed instead of being handed to the service (FR-144).
    assert.equal(
      (await query("prod", "User(123)/FOOBar")).structuredContent?.code,
      "NAVIGATION_NOT_ALLOWED",
    );
    const before: number = requests.length;
    await fs.writeFile(p, JSON.stringify({ environments: { prod: environment([]), dev: environment() } }));
    // `[]` narrows nothing, so BOTH environments expose the full catalog.
    const catalog = (body: Record<string, unknown>): string[] =>
      (body.entities as Array<{ name: string }>).map((e) => e.name).sort();
    assert.deepEqual(catalog(await read("sf://prod/entities")), [...names].sort());
    assert.deepEqual(catalog(await read("sf://dev/entities")), [...names].sort());
    assert.equal(requests.length, before);
    for (const alias of ["prod", "dev"]) assert.deepEqual(JSON.parse(await fs.readFile(path.join(cacheDir, `metadata-${alias}.json`), "utf8")).data.entitySets.sort(), [...names].sort());
  });
});
