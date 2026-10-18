import test from "node:test";
import assert from "node:assert/strict";
import {
  callTool,
  configJson,
  errorPayload,
  jsonResponse,
  mdfMetadataXml,
  recordingFetch,
  withTestServer,
  writeConfigFile,
  xmlResponse,
} from "./helpers.js";

/**
 * Integration coverage for the navigation vector: the resolver reads the REAL
 * metadata (`EntitySchema.navigationProperties`), not an injected graph.
 *
 * The fixture models `cust_Equipo -> externalCodeNav -> User` (plus the audit
 * navs to User), so `User` can be reached as a navigation destination while
 * being absent from the allowlist.
 */

function responder() {
  return recordingFetch((url) =>
    url.endsWith("/$metadata")
      ? xmlResponse(mdfMetadataXml(), 200, { "content-type": "application/xml" })
      : jsonResponse({ d: { results: [] } }),
  );
}

async function configPath(
  allowlist: Array<{ entity: string }>,
  denylist?: Array<{ entity: string }>,
): Promise<string> {
  const spec = denylist === undefined ? { allowlist } : { allowlist, denylist };
  return await writeConfigFile(configJson({ prod: spec }), { mode: 0o600 });
}

const dataRequests = (requests: Array<{ url: string }>) =>
  requests.filter((request) => !request.url.includes("$metadata")).length;

test("a navigation to an entity absent from the allowlist is denied", async () => {
  const { fetch, requests } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }]), fetchImpl: fetch },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo('x')/externalCodeNav",
      });
      assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
      assert.equal(dataRequests(requests), 0);
    },
  );
});

test("the same navigation is permitted when its destination is allowed", async () => {
  const { fetch } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }, { entity: "User" }]), fetchImpl: fetch },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo('x')/externalCodeNav",
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    },
  );
});

test("the denylist wins on a navigation destination", async () => {
  const { fetch } = responder();
  await withTestServer(
    {
      configPath: await configPath(
        [{ entity: "cust_Equipo" }, { entity: "User" }],
        [{ entity: "User" }],
      ),
      fetchImpl: fetch,
    },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo('x')/externalCodeNav",
      });
      assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
    },
  );
});

test("$expand to a denied destination is denied and returns no data", async () => {
  const { fetch, requests } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }]), fetchImpl: fetch },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo",
        expand: "externalCodeNav",
      });
      assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
      assert.equal(dataRequests(requests), 0);
    },
  );
});

test("$expand to an allowed destination still works", async () => {
  const { fetch } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }, { entity: "User" }]), fetchImpl: fetch },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo",
        expand: "externalCodeNav",
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    },
  );
});

test("$expand with a sub-$filter is rejected: that belongs to the filter vector", async () => {
  const { fetch } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }, { entity: "User" }]), fetchImpl: fetch },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo",
        expand: "externalCodeNav($filter=userId eq '1')",
      });
      assert.equal(errorPayload(result).code, "OPTION_INVALID");
    },
  );
});

test("a $filter that navigates to a denied entity set is denied", async () => {
  const { fetch, requests } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }]), fetchImpl: fetch },
    async (client) => {
      // The production-verified shape: <navProp>/<field> eq '<value>'.
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo",
        filter: "externalCodeNav/userId eq '1'",
      });
      assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
      assert.equal(dataRequests(requests), 0);
    },
  );
});

test("the same $filter is allowed when its destination is allowed", async () => {
  const { fetch } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }, { entity: "User" }]), fetchImpl: fetch },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo",
        filter: "externalCodeNav/userId eq '1'",
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    },
  );
});

test("a scalar $filter is not disturbed, even with a slash in its literal", async () => {
  const { fetch } = responder();
  await withTestServer(
    { configPath: await configPath([{ entity: "cust_Equipo" }]), fetchImpl: fetch },
    async (client) => {
      const result = await callTool(client, "query_entity", {
        environment: "prod",
        entityPath: "cust_Equipo",
        filter: "userId eq 'a/b'",
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    },
  );
});
