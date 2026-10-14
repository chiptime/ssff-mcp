import test from "node:test";
import assert from "node:assert/strict";
import {
  callTool,
  errorPayload,
  jsonResponse,
  mdfMetadataXml,
  recordingFetch,
  withTestServer,
  writeConfigFile,
} from "./helpers.js";
import { xmlResponse } from "./helpers.js";

async function configPathFor(extra: Record<string, unknown> = {}, aliases = ["tenant-a"]): Promise<string> {
  const environments = Object.fromEntries(
    aliases.map((alias) => [alias, { baseUrl: "https://tenant-a.example.com", auth: { type: "basic", username: "u", password: "p" } }]),
  );
  return await writeConfigFile(JSON.stringify({ environments, ...extra }), { mode: 0o600 });
}

function responder() {
  return recordingFetch((url) =>
    url.endsWith("/$metadata") ? xmlResponse(mdfMetadataXml(), 200, { "content-type": "application/xml" }) : jsonResponse({ d: { results: [] } }),
  );
}

test("inspect_custom_mdf is registered with a strict schema", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === "inspect_custom_mdf");
    assert.ok(tool);
    const props = Object.keys((tool.inputSchema as { properties: object }).properties).sort();
    assert.deepEqual(props, ["employeeLinkedOnly", "entitySet", "environment", "locale"]);
    assert.equal((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, false);
  });
});

test("without entitySet it lists the compact catalog", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a" });
    assert.ok(!result.isError);
    const body = result.structuredContent as { environment: string; totalCount: number; employeeLinkedCount: number; entities: Array<{ name: string }> };
    assert.equal(body.environment, "tenant-a");
    assert.equal(body.totalCount, 5);
    assert.equal(body.employeeLinkedCount, 3);
    assert.equal(body.entities.length, 5);
    assert.equal(JSON.parse((result.content[0] as { text: string }).text).totalCount, 5);
  });
});

test("employeeLinkedOnly filters the listing and reports the filtered counts", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", employeeLinkedOnly: true });
    const body = result.structuredContent as { totalCount: number; employeeLinkedCount: number; entities: Array<{ name: string }> };
    assert.deepEqual(body.entities.map((e) => e.name), ["cust_Equipo", "cust_Prendas", "cust_Social"]);
    assert.deepEqual([body.totalCount, body.employeeLinkedCount], [3, 3]);
  });
});

test("with entitySet it returns schema plus guidance", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", entitySet: "cust_Prendas" });
    assert.ok(!result.isError);
    const body = result.structuredContent as Record<string, any>;
    assert.equal(body.entitySet, "cust_Prendas");
    assert.equal(body.employeeLink.type, "USER_FIELD_NAVIGATION");
    assert.equal(body.guidance.suggestedFilter, "cust_UsuarioNav/userId eq '<userId>'");
    assert.ok(Array.isArray(body.properties));
    assert.ok(JSON.stringify(body).length < 5 * 1024);
  });
});

test("locale precedence: tool argument > config defaultLocale > SF_DEFAULT_LOCALE > en_US", async () => {
  const { fetch } = responder();
  const run = async (extra: Record<string, unknown>, args: Record<string, unknown>, env: NodeJS.ProcessEnv) =>
    await withTestServer({ configPath: await configPathFor(extra), fetchImpl: fetch, env }, async (client) => {
      const result = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", entitySet: "cust_Equipo", ...args });
      return (result.structuredContent as { guidance: { locale: string } }).guidance.locale;
    });
  assert.equal(await run({ defaultLocale: "en_US" }, { locale: "es_ES" }, { SF_DEFAULT_LOCALE: "en_US" }), "es_ES");
  assert.equal(await run({ defaultLocale: "es_ES" }, {}, { SF_DEFAULT_LOCALE: "en_US" }), "es_ES");
  assert.equal(await run({}, {}, { SF_DEFAULT_LOCALE: "es" }), "es_ES");
  assert.equal(await run({}, {}, {}), "en_US");
  assert.equal(await run({ defaultLocale: "es_ES" }, { locale: "fr_FR" }, {}), "en_US");
});

test("the listing also states the active locale", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", locale: "es" });
    assert.equal((result.structuredContent as { locale: string }).locale, "es_ES");
  });
});

test("a denied entity is ENTITY_NOT_ALLOWED and an empty allowlist denies everything", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor({ entityAllowlist: [{ entity: "User" }] }), fetchImpl: fetch }, async (client) => {
    const denied = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", entitySet: "cust_Equipo" });
    assert.equal(errorPayload(denied).code, "ENTITY_NOT_ALLOWED");
    const list = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a" });
    assert.deepEqual((list.structuredContent as { entities: unknown[] }).entities, []);
  });
  await withTestServer({ configPath: await configPathFor({ entityAllowlist: [] }), fetchImpl: fetch }, async (client) => {
    const denied = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", entitySet: "cust_Equipo" });
    assert.equal(errorPayload(denied).code, "ENTITY_NOT_ALLOWED");
  });
});

test("unknown or non-custom entity sets are RESOURCE_NOT_FOUND and the message does not echo the input", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    for (const entitySet of ["cust_Nope", "User"]) {
      const result = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", entitySet });
      const error = errorPayload(result);
      assert.equal(error.code, "RESOURCE_NOT_FOUND");
      assert.ok(!error.message.includes(entitySet === "User" ? "User'" : "cust_Nope"));
    }
  });
});

test("environment rules match the other tools: required with a config file, unknown is rejected", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    assert.equal(errorPayload(await callTool(client, "inspect_custom_mdf", {})).code, "ENVIRONMENT_REQUIRED");
    assert.equal(errorPayload(await callTool(client, "inspect_custom_mdf", { environment: "nope" })).code, "ENVIRONMENT_UNKNOWN");
  });
});

test("unknown arguments are rejected (strict) and no data request is ever made", async () => {
  const { fetch, requests } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const bad = await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", filter: "x" });
    assert.ok(bad.isError);
    await callTool(client, "inspect_custom_mdf", { environment: "tenant-a" });
    await callTool(client, "inspect_custom_mdf", { environment: "tenant-a", entitySet: "cust_Equipo" });
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.url.endsWith("/$metadata"));
  });
});

test("inline mode may omit environment (DS-MDF-04)", async () => {
  const { fetch } = responder();
  const env = { SF_BASE_URL: "https://tenant-a.example.com", SF_USERNAME: "u", SF_PASSWORD: "p", SF_ENVIRONMENT: "solo" };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    await withTestServer({ configPath: "/nonexistent/ssff-config.json", fetchImpl: fetch }, async (client) => {
      const result = await callTool(client, "inspect_custom_mdf", {});
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      assert.equal((result.structuredContent as { environment: string }).environment, "solo");
    });
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
