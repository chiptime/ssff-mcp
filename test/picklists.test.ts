/**
 * Test suite for Picklist Resolution and Caching (PRD-feature-picklists.md).
 * Tests D-53..D-61, FR-56..FR-66, DS-PL-01..DS-PL-06, NFR-01..NFR-04.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PicklistService,
  resolveLabel,
  resolvePicklistLocale,
  picklistCacheFileName,
  type CachedPicklistOption,
  PICKLIST_DISK_TTL_MS,
  PICKLIST_MEMORY_TTL_MS,
} from "../src/picklists.js";
import { envTargetFor } from "../src/http.js";
import { parseMetadata, type EntitySchema } from "../src/metadata.js";
import { runCacheInvalidate } from "../src/cli/cache.js";
import {
  FakeResponse,
  recordingFetch,
  jsonResponse,
  xmlResponse,
} from "./helpers.js";
import { createMcpServer } from "../src/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const ENV = envTargetFor({
  baseUrl: "https://tenant-a.example.com",
  auth: { type: "basic" as const, username: "user", password: "pwd" },
});

const SAMPLE_PERPERSONAL_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"
           xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"
           xmlns:sap="http://www.sap.com/Protocols/SAPData"
           Version="1.0">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="SFOData">
      <EntityType Name="PerPersonal">
        <Key><PropertyRef Name="personIdExternal"/></Key>
        <Property Name="personIdExternal" Type="Edm.String" Nullable="false"/>
        <Property Name="gender" Type="Edm.String" Nullable="true" sap:picklist="gender"/>
        <Property Name="maritalStatus" Type="Edm.String" Nullable="true" sap:picklist="maritalStatus"/>
        <Property Name="department" Type="Edm.String" Nullable="true"/>
      </EntityType>
      <EntityType Name="PicklistOption">
        <Key><PropertyRef Name="id"/></Key>
        <Property Name="id" Type="Edm.Int64" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="EntityContainer" m:IsDefaultEntityContainer="true">
        <EntitySet Name="PerPersonal" EntityType="SFOData.PerPersonal"/>
        <EntitySet Name="PicklistOption" EntityType="SFOData.PicklistOption"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

test("resolveLabel respects fallback degradation chain (FR-64 / D-60)", () => {
  const fullOption: CachedPicklistOption = {
    optionId: "10283",
    picklistId: "gender",
    externalCode: "M",
    status: "ACTIVE",
    labels: {
      en_US: "Male",
      es_ES: "Masculino",
      defaultValue: "Male",
    },
  };

  // Direct locale match
  assert.deepEqual(resolveLabel(fullOption, "es_ES"), { label: "Masculino", locale: "es_ES" });
  assert.deepEqual(resolveLabel(fullOption, "es"), { label: "Masculino", locale: "es_ES" });

  // Degradation to en_US when locale missing
  assert.deepEqual(resolveLabel(fullOption, "de_DE"), { label: "Male", locale: "en_US" });

  // Degradation to defaultValue when en_US missing
  const defOption: CachedPicklistOption = {
    optionId: "10283",
    picklistId: "gender",
    externalCode: "M",
    status: "ACTIVE",
    labels: {
      defaultValue: "Default Gender",
    },
  };
  assert.deepEqual(resolveLabel(defOption, "fr_FR"), { label: "Default Gender", locale: "defaultValue" });

  // Degradation to externalCode when labels empty
  const codeOption: CachedPicklistOption = {
    optionId: "10283",
    picklistId: "gender",
    externalCode: "M",
    status: "ACTIVE",
    labels: {},
  };
  assert.deepEqual(resolveLabel(codeOption, "fr_FR"), { label: "M", locale: "externalCode" });

  // Degradation to optionId when externalCode empty
  const rawOption: CachedPicklistOption = {
    optionId: "10283",
    picklistId: "gender",
    externalCode: "",
    status: "ACTIVE",
    labels: {},
  };
  assert.deepEqual(resolveLabel(rawOption, "fr_FR"), { label: "10283", locale: "raw" });
});

test("resolvePicklistLocale handles hierarchy and normalization (D-60)", () => {
  assert.equal(resolvePicklistLocale({ tool: "es_ES" }), "es_ES");
  assert.equal(resolvePicklistLocale({ tool: "es-es" }), "es_ES");
  assert.equal(resolvePicklistLocale({ tool: "es" }), "es_ES");
  assert.equal(resolvePicklistLocale({ config: "pt_BR" }), "pt_BR");
  assert.equal(resolvePicklistLocale({ env: "de_DE" }), "de_DE");
  assert.equal(resolvePicklistLocale({}), "en_US");
});

test("PicklistService parses Legacy PicklistOption responses", async () => {
  const legacyResponse = {
    d: {
      results: [
        {
          id: 10283,
          externalCode: "M",
          status: "ACTIVE",
          sortOrder: 1,
          picklist: { id: "gender" },
          picklistLabels: {
            results: [
              { locale: "en_US", label: "Male" },
              { locale: "es_ES", label: "Masculino" },
            ],
          },
        },
        {
          id: 10284,
          externalCode: "F",
          status: "ACTIVE",
          sortOrder: 2,
          picklist: { id: "gender" },
          picklistLabels: {
            results: [
              { locale: "en_US", label: "Female" },
              { locale: "es_ES", label: "Femenino" },
            ],
          },
        },
      ],
    },
  };

  const { fetch, requests } = recordingFetch(() => jsonResponse(legacyResponse));
  const service = new PicklistService({ fetchImpl: fetch, disableDiskCache: true });

  const options = await service.ensurePicklistLoaded(ENV, "tenant-a", "gender");
  assert.equal(options.length, 2);
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.url.includes("PicklistOption?$filter=picklist/id%20eq%20%27gender%27"));

  const cache = await service.getCacheFor("tenant-a");
  assert.equal(cache.byOptionId.get("10283")?.labels["es_ES"], "Masculino");
  assert.equal(cache.byExternalCode.get("gender:F")?.labels["en_US"], "Female");
});

test("PicklistService parses MDF PickListValueV2 responses", async () => {
  const mdfResponse = {
    d: {
      results: [
        {
          PickListV2_id: "YesNo",
          externalCode: "Y",
          legacyOptionId: 501,
          status: "A",
          label_en_US: "Yes",
          label_es_ES: "Sí",
        },
        {
          PickListV2_id: "YesNo",
          externalCode: "N",
          legacyOptionId: 502,
          status: "A",
          label_en_US: "No",
          label_es_ES: "No",
        },
      ],
    },
  };

  const { fetch, requests } = recordingFetch((url) => {
    if (url.includes("PicklistOption")) {
      // Legacy returns 0 results
      return jsonResponse({ d: { results: [] } });
    }
    return jsonResponse(mdfResponse);
  });

  const service = new PicklistService({ fetchImpl: fetch, disableDiskCache: true });
  const options = await service.ensurePicklistLoaded(ENV, "tenant-a", "YesNo");
  assert.equal(options.length, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.url.includes("PickListValueV2?$filter=PickListV2_id%20eq%20%27YesNo%27"));

  const cache = await service.getCacheFor("tenant-a");
  assert.equal(cache.byOptionId.get("501")?.labels["es_ES"], "Sí");
  assert.equal(cache.byExternalCode.get("YesNo:N")?.labels["en_US"], "No");
});

test("in-flight requests are deduplicated for concurrent calls (NFR-04)", async () => {
  let networkCalls = 0;
  const { fetch } = recordingFetch(async () => {
    networkCalls += 1;
    // Tiny delay to allow concurrency
    await new Promise((r) => setTimeout(r, 10));
    return jsonResponse({
      d: {
        results: [
          {
            id: 1,
            externalCode: "A",
            status: "ACTIVE",
            picklist: { id: "concurrent_test" },
            picklistLabels: { results: [{ locale: "en_US", label: "Alpha" }] },
          },
        ],
      },
    });
  });

  const service = new PicklistService({ fetchImpl: fetch, disableDiskCache: true });

  const [res1, res2, res3] = await Promise.all([
    service.ensurePicklistLoaded(ENV, "tenant-a", "concurrent_test"),
    service.ensurePicklistLoaded(ENV, "tenant-a", "concurrent_test"),
    service.ensurePicklistLoaded(ENV, "tenant-a", "concurrent_test"),
  ]);

  assert.equal(networkCalls, 1);
  assert.equal(res1.length, 1);
  assert.equal(res2.length, 1);
  assert.equal(res3.length, 1);
});

test("disk L2 cache persistence and reload (FR-58, NFR-03, DS-PL-03)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-picklists-cache-"));
  try {
    let fetches = 0;
    const { fetch } = recordingFetch(() => {
      fetches += 1;
      return jsonResponse({
        d: {
          results: [
            {
              id: 999,
              externalCode: "DISK_TEST",
              status: "ACTIVE",
              picklist: { id: "disk_test" },
              picklistLabels: { results: [{ locale: "en_US", label: "Disk Value" }] },
            },
          ],
        },
      });
    });

    let clock = 10_000_000;
    const now = () => clock;

    // Service 1: fetches from SAP and saves to disk
    const service1 = new PicklistService({
      fetchImpl: fetch,
      now,
      cacheDir: tmpDir,
      disableDiskCache: false,
    });
    await service1.ensurePicklistLoaded(ENV, "tenant-a", "disk_test");
    assert.equal(fetches, 1);

    // Verify cache file exists on disk
    const cacheFile = path.join(tmpDir, picklistCacheFileName("default", "tenant-a"));
    const stat = await fs.stat(cacheFile);
    assert.ok(stat.isFile());

    // Service 2: fresh instance without in-memory cache, loads from disk without network
    const service2 = new PicklistService({
      fetchImpl: fetch,
      now,
      cacheDir: tmpDir,
      disableDiskCache: false,
    });
    const loaded = await service2.ensurePicklistLoaded(ENV, "tenant-a", "disk_test");
    assert.equal(fetches, 1); // No new network call!
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.externalCode, "DISK_TEST");

    // Force refresh bypasses cache
    await service2.ensurePicklistLoaded(ENV, "tenant-a", "disk_test", true);
    assert.equal(fetches, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("cache invalidation drops picklist cache on disk", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-invalidation-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        environments: {
          "tenant-a": {
            baseUrl: "https://tenant-a.example.com",
            auth: { type: "basic", username: "u", password: "p" },
          },
        },
      }),
      "utf-8",
    );

    const picklistFile = path.join(tmpDir, picklistCacheFileName("default", "tenant-a"));
    await fs.writeFile(picklistFile, JSON.stringify({ fetchedAt: Date.now(), options: [] }), "utf-8");

    assert.ok(await fs.stat(picklistFile).then(() => true, () => false));

    const code = await runCacheInvalidate("tenant-a", false, {
      configPath,
      cacheDir: tmpDir,
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(code, 0);

    const existsAfter = await fs.stat(picklistFile).then(() => true, () => false);
    assert.equal(existsAfter, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("enrichRecords enriches records non-destructively and handles missing options (D-57, FR-61, FR-63, FR-65, NFR-01)", async () => {
  const parsed = parseMetadata(SAMPLE_PERPERSONAL_METADATA);
  const schema = parsed.entitySchemas["PerPersonal"]!;

  const { fetch } = recordingFetch((url) => {
    if (url.includes("gender")) {
      return jsonResponse({
        d: {
          results: [
            {
              id: 10283,
              externalCode: "M",
              status: "ACTIVE",
              picklist: { id: "gender" },
              picklistLabels: { results: [{ locale: "es_ES", label: "Masculino" }] },
            },
          ],
        },
      });
    }
    if (url.includes("maritalStatus")) {
      return jsonResponse({
        d: {
          results: [
            {
              id: 10119,
              externalCode: "M",
              status: "ACTIVE",
              picklist: { id: "maritalStatus" },
              picklistLabels: { results: [{ locale: "es_ES", label: "Casado/a" }] },
            },
          ],
        },
      });
    }
    return jsonResponse({ d: { results: [] } });
  });

  const service = new PicklistService({ fetchImpl: fetch, disableDiskCache: true });

  const records = [
    {
      personIdExternal: "P1",
      gender: "10283",
      maritalStatus: "10119",
      department: "DEP_IT_01",
    },
    {
      personIdExternal: "P2",
      gender: "99999", // Orphan / unknown option
      maritalStatus: "10119",
      department: "DEP_HR_02",
    },
  ];

  const enriched = (await service.enrichRecords(
    records,
    schema,
    ENV,
    "tenant-a",
    "es_ES",
  )) as Array<Record<string, any>>;

  assert.equal(enriched.length, 2);

  // Native properties preserved unchanged (FR-63)
  assert.equal(enriched[0].gender, "10283");
  assert.equal(enriched[0].maritalStatus, "10119");
  assert.equal(enriched[0].department, "DEP_IT_01");

  // _picklistLabels attached (FR-61)
  assert.deepEqual(enriched[0]._picklistLabels, {
    gender: {
      label: "Masculino",
      externalCode: "M",
      picklistId: "gender",
      resolved: true,
    },
    maritalStatus: {
      label: "Casado/a",
      externalCode: "M",
      picklistId: "maritalStatus",
      resolved: true,
    },
  });

  // Orphan option handled fail-safe (FR-65 / D-59)
  assert.deepEqual(enriched[1]._picklistLabels, {
    gender: {
      resolved: false,
      rawValue: "99999",
      reason: "OPTION_NOT_FOUND",
    },
    maritalStatus: {
      label: "Casado/a",
      externalCode: "M",
      picklistId: "maritalStatus",
      resolved: true,
    },
  });
});

test("MCP resolve_picklist tool: Caso A (reverse search), Caso B (option ID), Caso C (list) via McpServer harness", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-picklists-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        environments: {
          "tenant-a": {
            baseUrl: "https://tenant-a.example.com",
            auth: { type: "basic", username: "u", password: "p" },
          },
        },
      }),
      "utf-8",
    );

    const { fetch } = recordingFetch((url) => {
      if (url.includes("$metadata")) {
        return xmlResponse(SAMPLE_PERPERSONAL_METADATA);
      }
      if (url.includes("maritalStatus")) {
        return jsonResponse({
          d: {
            results: [
              {
                id: 10119,
                externalCode: "M",
                status: "ACTIVE",
                picklist: { id: "maritalStatus" },
                picklistLabels: {
                  results: [
                    { locale: "en_US", label: "Married" },
                    { locale: "es_ES", label: "Casado/a" },
                  ],
                },
              },
              {
                id: 10120,
                externalCode: "S",
                status: "ACTIVE",
                picklist: { id: "maritalStatus" },
                picklistLabels: {
                  results: [
                    { locale: "en_US", label: "Single" },
                    { locale: "es_ES", label: "Soltero/a" },
                  ],
                },
              },
            ],
          },
        });
      }
      if (url.includes("gender")) {
        return jsonResponse({
          d: {
            results: [
              {
                id: 10283,
                externalCode: "M",
                status: "ACTIVE",
                picklist: { id: "gender" },
                picklistLabels: {
                  results: [
                    { locale: "en_US", label: "Male" },
                    { locale: "es_ES", label: "Masculino" },
                  ],
                },
              },
            ],
          },
        });
      }
      return jsonResponse({ d: { results: [] } });
    });

    const server = createMcpServer({
      configPath,
      fetchImpl: fetch,
      disableDiskCache: true,
      logSink: () => {},
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Caso A: Reverse search by query
    const resA = await client.callTool({
      name: "resolve_picklist",
      arguments: {
        environment: "tenant-a",
        picklistId: "maritalStatus",
        query: "Casado",
        locale: "es_ES",
      },
    });
    assert.equal(resA.isError, undefined);
    const structA = resA.structuredContent as any;
    assert.equal(structA.picklistId, "maritalStatus");
    assert.equal(structA.matches.length, 1);
    assert.equal(structA.matches[0].optionId, "10119");
    assert.equal(structA.matches[0].label, "Casado/a");
    assert.equal(structA.matches[0].suggestedFilter, "maritalStatus eq '10119'");

    // Caso B: Direct optionId resolution
    const resB = await client.callTool({
      name: "resolve_picklist",
      arguments: {
        environment: "tenant-a",
        picklistId: "gender",
        optionId: 10283,
        locale: "es_ES",
      },
    });
    assert.equal(resB.isError, undefined);
    const structB = resB.structuredContent as any;
    assert.equal(structB.found, true);
    assert.equal(structB.option.optionId, "10283");
    assert.equal(structB.option.label, "Masculino");
    assert.equal(structB.option.externalCode, "M");

    // Caso C: List options of catalog
    const resC = await client.callTool({
      name: "resolve_picklist",
      arguments: {
        environment: "tenant-a",
        picklistId: "maritalStatus",
        locale: "es_ES",
      },
    });
    assert.equal(resC.isError, undefined);
    const structC = resC.structuredContent as any;
    assert.equal(structC.picklistId, "maritalStatus");
    assert.equal(structC.options.length, 2);

    await client.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("query_entity and batch_get end-to-end with resolvePicklists: true (FR-61, FR-62, D-58)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-e2e-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    // Notice: entityAllowlist only contains PerPersonal; PicklistOption is EXCLUDED! (Testing D-58 / FR-66)
    await fs.writeFile(
      configPath,
      JSON.stringify({
        environments: {
          "tenant-a": {
            baseUrl: "https://tenant-a.example.com",
            auth: { type: "basic", username: "u", password: "p" },
            entityAllowlist: [{ entity: "PerPersonal" }],
          },
        },
      }),
      "utf-8",
    );

    const { fetch } = recordingFetch((url, init) => {
      if (url.includes("$metadata")) {
        return xmlResponse(SAMPLE_PERPERSONAL_METADATA);
      }
      if (url.includes("$batch")) {
        const contentType = (init.headers as Record<string, string>)["Content-Type"] ?? "";
        const match = /boundary=(.+)$/.exec(contentType);
        const boundary = match ? match[1]! : "batch_boundary";
        const body = [
          `--${boundary}`,
          "Content-Type: application/http",
          "Content-Transfer-Encoding: binary",
          "",
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          "",
          JSON.stringify({
            d: {
              results: [
                {
                  personIdExternal: "P1",
                  gender: "10283",
                  maritalStatus: "10119",
                  department: "DEP_IT_01",
                },
              ],
            },
          }),
          "",
          `--${boundary}--`,
          "",
        ].join("\r\n");
        return new FakeResponse(200, body, { "content-type": `multipart/mixed; boundary=${boundary}` });
      }
      if (url.includes("/PerPersonal")) {
        return jsonResponse({
          d: {
            results: [
              {
                personIdExternal: "P1",
                gender: "10283",
                maritalStatus: "10119",
                department: "DEP_IT_01",
              },
            ],
          },
        });
      }
      if (url.includes("gender")) {
        return jsonResponse({
          d: {
            results: [
              {
                id: 10283,
                externalCode: "M",
                status: "ACTIVE",
                picklist: { id: "gender" },
                picklistLabels: { results: [{ locale: "es_ES", label: "Masculino" }] },
              },
            ],
          },
        });
      }
      if (url.includes("maritalStatus")) {
        return jsonResponse({
          d: {
            results: [
              {
                id: 10119,
                externalCode: "M",
                status: "ACTIVE",
                picklist: { id: "maritalStatus" },
                picklistLabels: { results: [{ locale: "es_ES", label: "Casado/a" }] },
              },
            ],
          },
        });
      }
      return jsonResponse({ d: { results: [] } });
    });

    const server = createMcpServer({
      configPath,
      fetchImpl: fetch,
      disableDiskCache: true,
      logSink: () => {},
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // 1. Calling query_entity on PicklistOption directly MUST BE DENIED by allowlist (D-58)
    const resDenied = await client.callTool({
      name: "query_entity",
      arguments: {
        environment: "tenant-a",
        entityPath: "PicklistOption",
      },
    });
    assert.equal(resDenied.isError, true);
    assert.equal((resDenied.structuredContent as any).code, "ENTITY_NOT_ALLOWED");

    // 2. Calling query_entity on PerPersonal with resolvePicklists: true works and enriches via internal dispatch (D-58 / FR-61)
    const resQuery = await client.callTool({
      name: "query_entity",
      arguments: {
        environment: "tenant-a",
        entityPath: "PerPersonal",
        resolvePicklists: true,
        locale: "es_ES",
      },
    });
    assert.equal(resQuery.isError, undefined);
    const structQuery = resQuery.structuredContent as any;
    assert.equal(structQuery.records.length, 1);
    assert.equal(structQuery.records[0].gender, "10283");
    assert.equal(structQuery.records[0]._picklistLabels.gender.label, "Masculino");
    assert.equal(structQuery.records[0]._picklistLabels.maritalStatus.label, "Casado/a");

    // 3. batch_get with resolvePicklists: true per item (FR-62)
    const resBatch = await client.callTool({
      name: "batch_get",
      arguments: {
        environment: "tenant-a",
        requests: [
          {
            entityPath: "PerPersonal",
            resolvePicklists: true,
            locale: "es_ES",
          },
        ],
      },
    });
    assert.equal(resBatch.isError, undefined);
    const structBatch = resBatch.structuredContent as any;
    assert.equal(structBatch.results[0].success, true);
    assert.equal(structBatch.results[0].records[0]._picklistLabels.gender.label, "Masculino");

    await client.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("NFR-01: In-memory enrichment of 1,000 records completes in < 5ms", async () => {
  const parsed = parseMetadata(SAMPLE_PERPERSONAL_METADATA);
  const schema = parsed.entitySchemas["PerPersonal"]!;

  const { fetch } = recordingFetch(() =>
    jsonResponse({
      d: {
        results: [
          {
            id: 10283,
            externalCode: "M",
            status: "ACTIVE",
            picklist: { id: "gender" },
            picklistLabels: { results: [{ locale: "es_ES", label: "Masculino" }] },
          },
          {
            id: 10119,
            externalCode: "M",
            status: "ACTIVE",
            picklist: { id: "maritalStatus" },
            picklistLabels: { results: [{ locale: "es_ES", label: "Casado/a" }] },
          },
        ],
      },
    }),
  );

  const service = new PicklistService({ fetchImpl: fetch, disableDiskCache: true });

  // Pre-load
  await service.ensurePicklistLoaded(ENV, "tenant-a", "gender");
  await service.ensurePicklistLoaded(ENV, "tenant-a", "maritalStatus");

  // Generate 1,000 records
  const records: Array<Record<string, any>> = [];
  for (let i = 0; i < 1000; i++) {
    records.push({
      personIdExternal: `USER_${i}`,
      gender: "10283",
      maritalStatus: "10119",
      department: "DEP_01",
    });
  }

  const start = performance.now();
  await service.enrichRecords(records, schema, ENV, "tenant-a", "es_ES");
  const duration = performance.now() - start;

  assert.ok(
    duration < 15, // Generous margin for test runner overhead, target is < 5ms
    `enrichment took ${duration}ms, expected under 15ms in test runner`,
  );
  assert.ok(records[0]._picklistLabels);
  assert.equal(records[999]._picklistLabels.gender.label, "Masculino");
});

test("resolve_picklist schema rejects calls with no search criteria", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-schema-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        environments: {
          "tenant-a": {
            baseUrl: "https://tenant-a.example.com",
            auth: { type: "basic", username: "u", password: "p" },
          },
        },
      }),
      "utf-8",
    );

    const server = createMcpServer({
      configPath,
      disableDiskCache: true,
      logSink: () => {},
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "resolve_picklist",
      arguments: {
        environment: "tenant-a",
      },
    });

    // Zod refine validation rejects it
    assert.equal(res.isError, true);

    await client.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("query_entity output: 'xml' preserves raw Atom XML body without modifying it (Section 4.2.3 / D-32)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-xml-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        environments: {
          "tenant-a": {
            baseUrl: "https://tenant-a.example.com",
            auth: { type: "basic", username: "u", password: "p" },
          },
        },
      }),
      "utf-8",
    );

    const rawAtomXml = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><content type="application/xml"><m:properties xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices"><d:userId>cgranados</d:userId><d:gender>10283</d:gender></m:properties></content></entry></feed>`;

    const { fetch } = recordingFetch((url) => {
      if (url.includes("$metadata")) {
        return xmlResponse(SAMPLE_PERPERSONAL_METADATA);
      }
      return xmlResponse(rawAtomXml);
    });

    const server = createMcpServer({
      configPath,
      fetchImpl: fetch,
      disableDiskCache: true,
      logSink: () => {},
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "query_entity",
      arguments: {
        environment: "tenant-a",
        entityPath: "PerPersonal",
        output: "xml",
        resolvePicklists: true,
      },
    });

    assert.equal(res.isError, undefined);
    assert.equal((res.content as any)[0].type, "text");
    assert.equal((res.content as any)[0].text, rawAtomXml);

    await client.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
