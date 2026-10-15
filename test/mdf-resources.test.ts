import test from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, mdfMetadataXml, recordingFetch, withTestServer, writeConfigFile, xmlResponse, type TestClient } from "./helpers.js";

interface ConfigOptions {
  allowlist?: Array<{ entity: string }>;
  defaultLocale?: string;
}

async function configPathFor(options: ConfigOptions = {}): Promise<string> {
  const config: Record<string, unknown> = {
    environments: {
      "tenant-a": { baseUrl: "https://tenant-a.example.com", auth: { type: "basic", username: "u", password: "p" } },
    },
  };
  if (options.allowlist !== undefined) {
    config.entityAllowlist = options.allowlist;
  }
  if (options.defaultLocale !== undefined) {
    config.defaultLocale = options.defaultLocale;
  }
  return await writeConfigFile(JSON.stringify(config), { mode: 0o600 });
}

function responder() {
  return recordingFetch((url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(mdfMetadataXml(), 200, { "content-type": "application/xml" });
    }
    return jsonResponse({ d: { results: [] } });
  });
}

async function readJson<T>(client: TestClient, uri: string): Promise<T> {
  const res = await client.readResource({ uri });
  const content = res.contents[0];
  assert.ok(content !== undefined && "text" in content);
  return JSON.parse(content.text as string) as T;
}

interface CatalogItem {
  name: string;
  entityType: string;
  isCustom: boolean;
  isEmployeeLinked?: boolean;
  isEffectiveDated?: boolean;
  keyProperties: string[];
}

// --- S6: catalog flags ----------------------------------------------------------

test("sf://{env}/entities carries names only, with no enrichment fields", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const catalog = await readJson<{ entities: CatalogItem[] }>(client, "sf://tenant-a/entities");
    const by = Object.fromEntries(catalog.entities.map((e) => [e.name, e]));
    // Decision 2026-10-14: names only, 142 KB -> ~19 KB against PROD's 658
    // entities. The MDF flags live in sf://{env}/mdf/custom and in the
    // per-entity detail resource, not in the base catalog.
    assert.deepEqual(by.cust_Equipo, { name: "cust_Equipo" });
    assert.deepEqual(by.User, { name: "User" });
    for (const entity of catalog.entities) {
      assert.deepEqual(Object.keys(entity), ["name"]);
    }
  });
});

// --- S7: sf://{env}/mdf/custom --------------------------------------------------

test("MDF resource template is registered and listed per configured environment", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    assert.ok(templates.includes("sf://{environment}/mdf/custom"));
    assert.ok(!templates.some((t) => t.includes("/mdf/custom/")), "no parallel detail template (FR-72)");
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    assert.ok(uris.includes("sf://tenant-a/mdf/custom"));
  });
});

test("sf://{env}/mdf/custom returns the compact classified catalog", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const body = await readJson<{
      environment: string;
      totalCount: number;
      employeeLinkedCount: number;
      entities: Array<Record<string, unknown>>;
    }>(client, "sf://tenant-a/mdf/custom");
    assert.equal(body.environment, "tenant-a");
    assert.equal(body.totalCount, 5);
    assert.equal(body.employeeLinkedCount, 3);
    assert.deepEqual(body.entities[1], {
      name: "cust_Equipo",
      isEffectiveDated: true,
      linkType: "DIRECT_USER_KEY",
      targetEntity: "User",
      matchField: "externalCode",
    });
    assert.deepEqual(body.entities[0], { name: "cust_Catalogo", isEffectiveDated: false, linkType: "UNLINKED_STANDALONE" });
  });
});

test("sf://{env}/mdf/custom performs no request other than the cached $metadata", async () => {
  const { fetch, requests } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    await readJson(client, "sf://tenant-a/mdf/custom");
    await readJson(client, "sf://tenant-a/mdf/custom");
    await readJson(client, "sf://tenant-a/entities/cust_Equipo");
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.url.endsWith("/$metadata"));
  });
});

test("sf://{env}/mdf/custom is allowlist-filtered and an empty allowlist lists nothing", async () => {
  const { fetch } = responder();
  const filtered = await configPathFor({ allowlist: [{ entity: "cust_Prendas" }, { entity: "User" }] });
  await withTestServer({ configPath: filtered, fetchImpl: fetch }, async (client) => {
    const body = await readJson<{ totalCount: number; entities: Array<{ name: string }> }>(client, "sf://tenant-a/mdf/custom");
    assert.deepEqual(body.entities.map((e) => e.name), ["cust_Prendas"]);
    assert.equal(body.totalCount, 1);
  });
  const denyAll = await configPathFor({ allowlist: [] });
  await withTestServer({ configPath: denyAll, fetchImpl: fetch }, async (client) => {
    const body = await readJson<{ totalCount: number; employeeLinkedCount: number; entities: unknown[] }>(client, "sf://tenant-a/mdf/custom");
    assert.deepEqual([body.totalCount, body.employeeLinkedCount, body.entities.length], [0, 0, 0]);
  });
});

test("there is no sf://{env}/mdf/custom/{entitySet} resource (FR-72)", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    await assert.rejects(() => client.readResource({ uri: "sf://tenant-a/mdf/custom/cust_Equipo" }));
  });
});

// --- S8: detail enrichment ------------------------------------------------------

test("detail of a Custom MDF entity keeps the schema contract and adds the MDF fields", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const body = await readJson<Record<string, any>>(client, "sf://tenant-a/entities/cust_Equipo");
    assert.equal(body.entitySet, "cust_Equipo");
    assert.equal(body.entityType, "SFOData.cust_Equipo");
    assert.deepEqual(body.keys, ["externalCode", "effectiveStartDate"]);
    assert.ok(Array.isArray(body.properties) && Array.isArray(body.navigationProperties));
    assert.equal(body.isCustom, true);
    assert.equal(body.isEffectiveDated, true);
    assert.deepEqual(body.employeeLink, {
      type: "DIRECT_USER_KEY",
      targetEntitySet: "User",
      matchingField: "externalCode",
      navigationProperty: "externalCodeNav",
    });
    assert.equal(body.guidance.suggestedFilter, "externalCode eq '<userId>'");
    assert.equal(body.guidance.exampleQuery.tool, "query_entity");
    assert.ok(JSON.stringify(body).length < 5 * 1024);
  });
});

test("detail of a standard entity is unchanged (no MDF fields)", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    const body = await readJson<Record<string, unknown>>(client, "sf://tenant-a/entities/User");
    assert.deepEqual(Object.keys(body).sort(), ["entitySet", "entityType", "keys", "navigationProperties", "properties"]);
  });
});

test("detail of a denied Custom MDF entity is ENTITY_NOT_ALLOWED and a missing one RESOURCE_NOT_FOUND", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPathFor({ allowlist: [{ entity: "User" }] }), fetchImpl: fetch }, async (client) => {
    await assert.rejects(() => client.readResource({ uri: "sf://tenant-a/entities/cust_Equipo" }), /ENTITY_NOT_ALLOWED/);
  });
  await withTestServer({ configPath: await configPathFor(), fetchImpl: fetch }, async (client) => {
    await assert.rejects(() => client.readResource({ uri: "sf://tenant-a/entities/cust_Nope" }), /RESOURCE_NOT_FOUND/);
  });
});

// --- S2: locale for resources (levels 2-4) -------------------------------------

async function guidanceLocale(options: ConfigOptions, env: NodeJS.ProcessEnv): Promise<string> {
  const { fetch } = responder();
  return await withTestServer({ configPath: await configPathFor(options), fetchImpl: fetch, env }, async (client) => {
    const body = await readJson<{ guidance: { locale: string } }>(client, "sf://tenant-a/entities/cust_Equipo");
    return body.guidance.locale;
  });
}

test("resource guidance locale: config defaultLocale > SF_DEFAULT_LOCALE > en_US", async () => {
  assert.equal(await guidanceLocale({ defaultLocale: "es_ES" }, { SF_DEFAULT_LOCALE: "en_US" }), "es_ES");
  assert.equal(await guidanceLocale({}, { SF_DEFAULT_LOCALE: "es" }), "es_ES");
  assert.equal(await guidanceLocale({}, {}), "en_US");
  assert.equal(await guidanceLocale({ defaultLocale: "fr_FR" }, { SF_DEFAULT_LOCALE: "es_ES" }), "en_US");
});
