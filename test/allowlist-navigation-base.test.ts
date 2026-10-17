import test from "node:test";
import assert from "node:assert/strict";
import { validateEntityPath } from "../src/odata.js";
import { isSanitizedError } from "../src/errors.js";
import {
  callTool,
  configJson,
  errorPayload,
  jsonResponse,
  recordingFetch,
  withTestServer,
  writeConfigFile,
  xmlResponse,
} from "./helpers.js";

/**
 * Regression tests for the two `$expand` bypasses an independent verification
 * found in the first cut of the navigation enforcement.
 *
 * The fixture is deliberately shaped so the bugs are observable:
 *   User   .job     -> EmpJob
 *   User   .manager -> User
 *   EmpJob .onlyHere -> User
 *   EmpJob .manager  -> Payroll        (Payroll is the denied one)
 */

const NAV_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices>
    <Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="SFOData">
      <EntityType Name="User">
        <Key><PropertyRef Name="userId"/></Key>
        <Property Name="userId" Type="Edm.String" Nullable="false"/>
        <NavigationProperty Name="job" Relationship="SFOData.A_job" FromRole="From" ToRole="To"/>
        <NavigationProperty Name="manager" Relationship="SFOData.A_manager" FromRole="From" ToRole="To"/>
      </EntityType>
      <EntityType Name="EmpJob">
        <Key><PropertyRef Name="id"/></Key>
        <Property Name="id" Type="Edm.String" Nullable="false"/>
        <NavigationProperty Name="onlyHere" Relationship="SFOData.A_onlyHere" FromRole="From" ToRole="To"/>
        <NavigationProperty Name="manager" Relationship="SFOData.A_empManager" FromRole="From" ToRole="To"/>
      </EntityType>
      <EntityType Name="Payroll">
        <Key><PropertyRef Name="id"/></Key>
        <Property Name="id" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <Association Name="A_job"><End Role="From" Type="SFOData.User" Multiplicity="*"/><End Role="To" Type="SFOData.EmpJob" Multiplicity="0..1"/></Association>
      <Association Name="A_manager"><End Role="From" Type="SFOData.User" Multiplicity="*"/><End Role="To" Type="SFOData.User" Multiplicity="0..1"/></Association>
      <Association Name="A_onlyHere"><End Role="From" Type="SFOData.EmpJob" Multiplicity="*"/><End Role="To" Type="SFOData.User" Multiplicity="0..1"/></Association>
      <Association Name="A_empManager"><End Role="From" Type="SFOData.EmpJob" Multiplicity="*"/><End Role="To" Type="SFOData.Payroll" Multiplicity="0..1"/></Association>
      <EntityContainer Name="EntityContainer">
        <EntitySet Name="User" EntityType="SFOData.User"/>
        <EntitySet Name="EmpJob" EntityType="SFOData.EmpJob"/>
        <EntitySet Name="Payroll" EntityType="SFOData.Payroll"/>
        <AssociationSet Name="A_job" Association="SFOData.A_job"><End Role="From" EntitySet="User"/><End Role="To" EntitySet="EmpJob"/></AssociationSet>
        <AssociationSet Name="A_manager" Association="SFOData.A_manager"><End Role="From" EntitySet="User"/><End Role="To" EntitySet="User"/></AssociationSet>
        <AssociationSet Name="A_onlyHere" Association="SFOData.A_onlyHere"><End Role="From" EntitySet="EmpJob"/><End Role="To" EntitySet="User"/></AssociationSet>
        <AssociationSet Name="A_empManager" Association="SFOData.A_empManager"><End Role="From" EntitySet="EmpJob"/><End Role="To" EntitySet="Payroll"/></AssociationSet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

function responder() {
  return recordingFetch((url) =>
    url.endsWith("/$metadata")
      ? xmlResponse(NAV_METADATA, 200, { "content-type": "application/xml" })
      : jsonResponse({ d: { results: [] } }),
  );
}

/** Payroll is deliberately NOT allowed: it is reachable only through EmpJob.manager. */
async function configPath(): Promise<string> {
  return await writeConfigFile(
    configJson({ prod: { allowlist: [{ entity: "User" }, { entity: "EmpJob" }] } }),
    { mode: 0o600 },
  );
}

test("$expand resolves from the entity the PATH reached, so a denied destination is denied", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    // The path reaches EmpJob; EmpJob.manager points at the denied Payroll.
    // Resolving from User instead would find User.manager -> User and let it through.
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User('1')/job",
      expand: "manager",
    });
    assert.equal(errorPayload(result).code, "ENTITY_NOT_ALLOWED");
  });
});

test("$expand resolves from the entity the PATH reached, so a legitimate one still works", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    // EmpJob.onlyHere -> User, which IS allowed. Resolving from User would find
    // no such navigation and wrongly reject the request.
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User('1')/job",
      expand: "onlyHere",
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
  });
});

test("a percent-encoded $expand is rejected: the service decodes what the parser does not check", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User",
      expand: "manager($select=userId%3B$expand=job)",
    });
    assert.equal(errorPayload(result).code, "OPTION_INVALID");
    assert.match(errorPayload(result).message, /percent-encoded/);
  });
});

test("an empty $select value is rejected instead of dispatched", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User",
      expand: "manager($select=)",
    });
    assert.equal(errorPayload(result).code, "OPTION_INVALID");
  });
});

test("an unbalanced $select value is rejected instead of dispatched", async () => {
  const { fetch } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User",
      expand: "manager($select=(userId)",
    });
    assert.equal(errorPayload(result).code, "OPTION_INVALID");
  });
});

test("percent-encoded characters in the entity path are rejected before parsing", () => {
  for (const path of [
    "User('a%27)",
    "User('a%27)/payrollNav(%27x')",
    "User('a%27)%2FpayrollNav%28%27x')",
    "User%28'1'%29",
  ]) {
    assert.throws(
      () => validateEntityPath(path),
      (error: unknown) => isSanitizedError(error) && error.code === "PATH_INVALID",
      path,
    );
  }
});

test("an encoded path cannot hide a denied navigation, and nothing is dispatched", async () => {
  const { fetch, requests } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    // Decoded by the service this reaches Payroll through a navigation the
    // checker never saw, because the raw path parses as a single segment.
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User('a%27)/payrollNav(%27x')",
    });
    assert.equal(errorPayload(result).code, "PATH_INVALID");
    assert.equal(requests.filter((r) => !r.url.includes("$metadata")).length, 0);
  });
});

test("an encoded path cannot move the entity an $expand resolves from", async () => {
  const { fetch, requests } = responder();
  await withTestServer({ configPath: await configPath(), fetchImpl: fetch }, async (client) => {
    const result = await callTool(client, "query_entity", {
      environment: "prod",
      entityPath: "User('a%27)/job(%27x')",
      expand: "manager",
    });
    assert.equal(errorPayload(result).code, "PATH_INVALID");
    assert.equal(requests.filter((r) => !r.url.includes("$metadata")).length, 0);
  });
});
