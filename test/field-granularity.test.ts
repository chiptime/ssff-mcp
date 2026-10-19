import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { permittedFieldsFor, type AllowlistEntry } from "../src/allowlist.js";
import {
  allowedProperties,
  FieldNotPermittedError,
  redactValue,
} from "../src/fields.js";
import { parseExpand } from "../src/expand.js";
import {
  callTool,
  errorPayload,
  FakeResponse,
  jsonResponse,
  mdfMetadataXml,
  withTestServer,
  writeConfigFile,
  xmlResponse,
  type TestClient,
} from "./helpers.js";

/**
 * Field-level granularity: `fields` on an `entityAllowlist` entry restricts the
 * properties an entity exposes. Absent or empty = every property. The entity's
 * keys are ALWAYS readable, so `__metadata.uri` never leaks a denied property.
 */

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices>
    <Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="SFOData">
      <EntityType Name="User">
        <Key><PropertyRef Name="userId"/></Key>
        <Property Name="userId" Type="Edm.String" Nullable="false"/>
        <Property Name="firstName" Type="Edm.String"/>
        <Property Name="salary" Type="Edm.Double"/>
        <NavigationProperty Name="job" Relationship="SFOData.A_job" FromRole="From" ToRole="To"/>
      </EntityType>
      <EntityType Name="EmpJob">
        <Key><PropertyRef Name="id"/></Key>
        <Property Name="id" Type="Edm.String" Nullable="false"/>
        <Property Name="amount" Type="Edm.Double"/>
      </EntityType>
      <Association Name="A_job"><End Role="From" Type="SFOData.User" Multiplicity="*"/><End Role="To" Type="SFOData.EmpJob" Multiplicity="0..1"/></Association>
      <EntityContainer Name="EntityContainer">
        <EntitySet Name="User" EntityType="SFOData.User"/>
        <EntitySet Name="EmpJob" EntityType="SFOData.EmpJob"/>
        <AssociationSet Name="A_job" Association="SFOData.A_job"><End Role="From" EntitySet="User"/><End Role="To" EntitySet="EmpJob"/></AssociationSet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

const RECORD = {
  __metadata: { uri: "https://t.example.com/odata/v2/User('1027740')", type: "SFOData.User" },
  userId: "1027740",
  firstName: "Ana",
  salary: 45000,
};

function responder(body: unknown) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/$metadata")) {
      return xmlResponse(METADATA, 200, { "content-type": "application/xml" });
    }
    return jsonResponse(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function configFor(allowlist: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-fields-"));
  const file = path.join(dir, "config.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://t.example.com",
          auth: { type: "basic", username: "u", password: "p" },
          ...(allowlist === undefined ? {} : { entityAllowlist: allowlist }),
        },
      },
    }),
    { mode: 0o600 },
  );
  return file;
}

// --- pure helpers ------------------------------------------------------------

test("permittedFieldsFor: absent, empty and undefined all mean unrestricted", () => {
  const withFields: AllowlistEntry[] = [{ entity: "User", fields: ["userId"] }];
  assert.deepEqual(permittedFieldsFor(withFields, "User"), ["userId"]);
  assert.equal(permittedFieldsFor([{ entity: "User", fields: [] }], "User"), undefined);
  assert.equal(permittedFieldsFor([{ entity: "User" }], "User"), undefined);
  assert.equal(permittedFieldsFor(undefined, "User"), undefined);
});

// --- config plumbing ---------------------------------------------------------

test("fields parses on the allowlist and is rejected on the denylist", async () => {
  const ok = await configFor([{ entity: "User", fields: ["userId", "firstName"] }]);
  const loaded = await loadConfig({ configPath: ok, env: {} });
  assert.deepEqual(loaded.environments.prod!.entityAllowlist, [
    { entity: "User", fields: ["userId", "firstName"] },
  ]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-fields-"));
  const bad = path.join(dir, "config.json");
  await fs.writeFile(
    bad,
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://t.example.com",
          auth: { type: "basic", username: "u", password: "p" },
          entityDenylist: [{ entity: "User", fields: ["salary"] }],
        },
      },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadConfig({ configPath: bad, env: {} }),
    (error: unknown) => {
      assert.match((error as { message: string }).message, /Unrecognized key|fields/);
      return true;
    },
  );
});

// --- enforcement -------------------------------------------------------------

const RESTRICTED = [{ entity: "User", fields: ["firstName"] }, { entity: "EmpJob" }];

test("the payload is redacted even without $select: salary disappears", async () => {
  const { fetchImpl } = responder({ d: { results: [RECORD] } });
  await withTestServer({ configPath: await configFor(RESTRICTED), fetchImpl }, async (client) => {
    const result = await callTool(client, "query_entity", { environment: "prod", entityPath: "User" });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const record = (result.structuredContent as { records: Array<Record<string, unknown>> }).records[0]!;
    assert.equal(record.firstName, "Ana");
    assert.equal(record.salary, undefined);
    // The key stays readable (implicitly permitted) so the record stays referenceable.
    assert.equal(record.userId, "1027740");
    assert.ok("__metadata" in record);
  });
});

test("$select naming a non-permitted property is rejected", async () => {
  const { fetchImpl, calls } = responder({ d: { results: [RECORD] } });
  await withTestServer({ configPath: await configFor(RESTRICTED), fetchImpl }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User",
      select: "userId,salary",
    });
    assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
    assert.equal(calls.filter((url) => !url.includes("$metadata")).length, 0);
  });
});

test("$filter and $orderby naming a non-permitted property are rejected", async () => {
  const { fetchImpl, calls } = responder({ d: { results: [RECORD] } });
  await withTestServer({ configPath: await configFor(RESTRICTED), fetchImpl }, async (client) => {
    for (const args of [{ filter: "salary gt 100" }, { orderby: "salary desc" }]) {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "User",
        ...args,
      });
      assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED", JSON.stringify(args));
    }
    assert.equal(calls.filter((url) => !url.includes("$metadata")).length, 0);
  });
});

test("a property reached THROUGH a navigation is checked against that entity's fields", async () => {
  // EmpJob only exposes `id`; filtering on its `amount` must be rejected even
  // though User itself is unrestricted for that property.
  const restricted = [
    { entity: "User" },
    { entity: "EmpJob", fields: ["id"] },
  ];
  const { fetchImpl, calls } = responder({ d: { results: [RECORD] } });
  await withTestServer({ configPath: await configFor(restricted), fetchImpl }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User",
      filter: "job/amount gt 5",
    });
    assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
    assert.equal(calls.filter((url) => !url.includes("$metadata")).length, 0);
  });
});

test("an expanded entity is redacted with its own fields", async () => {
  const body = {
    d: {
      results: [
        {
          ...RECORD,
          salary: undefined,
          job: {
            __metadata: { uri: "https://t.example.com/odata/v2/EmpJob('1')", type: "SFOData.EmpJob" },
            id: "1",
            amount: 999,
          },
        },
      ],
    },
  };
  const restricted = [
    { entity: "User", fields: ["firstName"] },
    { entity: "EmpJob", fields: ["id"] },
  ];
  const { fetchImpl } = responder(body);
  await withTestServer({ configPath: await configFor(restricted), fetchImpl }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User",
      expand: "job",
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const record = (result.structuredContent as { records: Array<Record<string, unknown>> }).records[0]!;
    const job = record.job as Record<string, unknown>;
    assert.equal(job.id, "1");
    assert.equal(job.amount, undefined);
  });
});

test("xml is downgraded to JSON with a flag when fields apply", async () => {
  const { fetchImpl } = responder({ d: { results: [RECORD] } });
  await withTestServer({ configPath: await configFor(RESTRICTED), fetchImpl }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User",
      output: "xml",
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.outputDowngraded, true);
    assert.ok(Array.isArray(structured.records));
  });
});

test("without fields configured nothing changes: xml stays xml, salary stays", async () => {
  const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>https://t.example.com/odata/v2/User('1027740')</id>
    <content type="application/xml">
      <m:properties xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"
        xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">
        <d:userId>1027740</d:userId><d:firstName>Ana</d:firstName><d:salary>45000</d:salary>
      </m:properties>
    </content>
  </entry>
</feed>`;
  const fetchImpl = (async (url: string, init?: { headers?: unknown }) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(METADATA, 200, { "content-type": "application/xml" });
    }
    // The tool asks for Atom only when it means to return XML; every other data
    // request is the JSON call.
    if (JSON.stringify(init?.headers ?? {}).includes("application/atom+xml")) {
      return xmlResponse(atomFeed, 200, { "content-type": "application/atom+xml" });
    }
    return jsonResponse({ d: { results: [RECORD] } });
  }) as unknown as typeof fetch;
  await withTestServer(
    { configPath: await configFor([{ entity: "User" }, { entity: "EmpJob" }]), fetchImpl },
    async (client) => {
      // JSON path: salary survives untouched.
      const json = await callTool(client, "query_entity", { environment: "prod", entityPath: "User" });
      assert.equal(json.isError, undefined, JSON.stringify(json));
      const record = (json.structuredContent as { records: Array<Record<string, unknown>> }).records[0]!;
      assert.equal(record.salary, 45000, "without fields there is nothing to redact");
      assert.equal(record.firstName, "Ana");

      // XML path: the downgrade fires only when a restriction exists, so an
      // unrestricted entity keeps its Atom representation and every property.
      const xml = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "User",
        output: "xml",
      });
      assert.equal(xml.isError, undefined, JSON.stringify(xml));
      const structured = xml.structuredContent as Record<string, unknown>;
      assert.equal(structured.contentType, "xml");
      assert.equal(structured.outputDowngraded, undefined, "no restriction configured, no downgrade");
      const text = (xml.content[0] as { text: string }).text;
      assert.ok(text.includes("<d:salary>45000</d:salary>"), "salary survives the unrestricted xml path");
      assert.ok(text.includes("<d:firstName>Ana</d:firstName>"));
    },
  );
});

test("inspect_entity hides non-permitted properties from the schema", async () => {
  const { fetchImpl } = responder({ d: { results: [] } });
  await withTestServer({ configPath: await configFor(RESTRICTED), fetchImpl }, async (client) => {
    const result = await callTool(client, "inspect_entity", {
      environment: "prod",
      entitySet: "User",
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const schema = result.structuredContent as { properties: Array<{ name: string }> };
    const names = schema.properties.map((property) => property.name);
    assert.ok(names.includes("firstName"));
    assert.ok(names.includes("userId"), "the key stays visible");
    assert.ok(!names.includes("salary"));
  });
});

test("the schema resource hides non-permitted properties too", async () => {
  const { fetchImpl } = responder({ d: { results: [] } });
  await withTestServer({ configPath: await configFor(RESTRICTED), fetchImpl }, async (client) => {
    const response = await (client as TestClient).readResource({ uri: "sf://prod/entities/User" });
    const payload = JSON.parse(
      (response.contents[0] as { text: string }).text,
    ) as { properties: Array<{ name: string }> };
    const names = payload.properties.map((property) => property.name);
    assert.ok(!names.includes("salary"));
    assert.ok(names.includes("userId"));
  });
});

test("parseExpand selections carry the property lists the field policy needs", () => {
  const parsed = parseExpand("job($select=id,amount)");
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.selections, [{ route: ["job"], properties: ["id", "amount"] }]);
  }
});

test("a slash inside a $select within $expand never reaches the field checker", () => {
  // `$select` accepts a flat property list only; a navigation path is a parse
  // error, so no slash-containing string can reach assertPropertyPermitted.
  assert.equal(parseExpand("job($select=nav/field)").ok, false);
  assert.equal(parseExpand("job($select=nav)").ok, true);
});

/**
 * The metadata lists the entity set but omits its EntityType, so classification
 * passes while the schema does not resolve. A configured `fields` cannot be
 * enforced there, and silently returning the payload would leak exactly what the
 * config wanted hidden.
 */
const SCHEMALESS_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices>
    <Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="SFOData">
      <EntityContainer Name="EntityContainer">
        <EntitySet Name="User" EntityType="SFOData.Missing"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

/**
 * A configured field list that cannot be enforced must refuse, never pass the
 * payload through. The metadata fixture below cannot even reach this state: an
 * EntitySet without its EntityType still yields an (empty) schema, so the guard
 * is pinned directly rather than through a contrived document.
 */
test("a configured field list with an unresolvable schema fails closed", async () => {
  const allowlist: AllowlistEntry[] = [{ entity: "User", fields: ["firstName"] }];
  const noSchema = async (): Promise<undefined> => undefined;
  const noNavigation = async (): Promise<undefined> => undefined;

  await assert.rejects(
    () => allowedProperties(allowlist, "User", noSchema),
    (error: unknown) =>
      error instanceof FieldNotPermittedError && /schema could not be resolved/.test(error.message),
  );
  await assert.rejects(
    () => redactValue({ firstName: "Ana", salary: 45000 }, "User", allowlist, noSchema, noNavigation),
    (error: unknown) => error instanceof FieldNotPermittedError,
  );
  // Without configured fields the same unresolvable schema is harmless: there is
  // nothing to redact, so the value passes through.
  assert.equal(await allowedProperties([{ entity: "User" }], "User", noSchema), undefined);
});

test("the same unresolvable schema stays usable when no fields are configured", async () => {
  const configPath = await configFor([{ entity: "User" }]);
  await withTestServer(
    {
      configPath,
      disableDiskCache: true,
      logSink: () => {},
      fetchImpl: async (url) => {
        if (url.endsWith("/$metadata")) return xmlResponse(SCHEMALESS_METADATA);
        return jsonResponse({ d: { results: [RECORD] } });
      },
    },
    async (client) => {
      const result = await callTool(client, "query_entity", { environment: "prod", entityPath: "User" });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const record = (result.structuredContent as { records: Array<Record<string, unknown>> }).records[0]!;
      assert.equal(record.salary, 45000, "without fields there is nothing to redact");
    },
  );
});

for (const tool of ["query_entity", "batch_get"] as const) {
  for (const restricted of [true, false]) {
    test(`${tool}: XML expansion checks intermediate fields (${restricted ? "restricted" : "unrestricted"})`, async () => {
      const metadata = mdfMetadataXml([
        { name: "User", keys: ["userId"], navs: [["employment", "Employment"]] },
        { name: "Employment", keys: ["id"], navs: [["job", "EmpJob"]] },
        { name: "EmpJob", keys: ["id"] },
      ]);
      const record = {
        userId: "u1",
        employment: { id: "e1", secret: "must-not-leave", job: { id: "j1", label: "visible" } },
      };
      const configPath = await configFor([
        { entity: "User" },
        { entity: "Employment", ...(restricted ? { fields: ["id"] } : {}) },
        { entity: "EmpJob" },
      ]);
      let dataCalls = 0;
      await withTestServer({
        configPath,
        disableDiskCache: true,
        logSink: () => {},
        fetchImpl: async (url, init) => {
          if (url.endsWith("/$metadata")) return xmlResponse(metadata);
          dataCalls += 1;
          const body = restricted
            ? JSON.stringify({ d: { results: [record] } })
            : "<feed><entry>unchanged-atom</entry></feed>";
          const contentType = restricted ? "application/json" : "application/atom+xml";
          if (tool === "query_entity") {
            assert.equal(init.headers.Accept, contentType);
            return new FakeResponse(200, body, { "content-type": contentType });
          }
          assert.ok("body" in init);
          assert.match(init.body, new RegExp(`Accept: ${contentType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
          const part = ["--fields", "Content-Type: application/http", "",
            "HTTP/1.1 200 OK", `Content-Type: ${contentType}`, "", body,
            "--fields--", ""].join("\r\n");
          return new FakeResponse(200, part, { "content-type": "multipart/mixed; boundary=fields" });
        },
      }, async (client) => {
        const item = { entityPath: "User", expand: "employment/job" };
        const result = await callTool(client, tool, {
          environment: "prod",
          output: "xml",
          ...(tool === "query_entity" ? item : { requests: [item] }),
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.equal(dataCalls, 1);
        const payload = result.structuredContent as Record<string, unknown>;
        const entry = tool === "query_entity"
          ? payload
          : (payload.results as Array<Record<string, unknown>>)[0]!;
        if (restricted) {
          assert.equal(entry.outputDowngraded, true);
          const records = entry.records as Array<typeof record>;
          assert.equal(records[0]!.employment.id, "e1");
          assert.equal(records[0]!.employment.job.label, "visible");
          assert.equal("secret" in records[0]!.employment, false);
          assert.ok(!JSON.stringify(result).includes("must-not-leave"));
        } else {
          assert.equal(entry.outputDowngraded, undefined);
          assert.ok(JSON.stringify(result).includes("unchanged-atom"));
        }
      });
    });
  }
}
