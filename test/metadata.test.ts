import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MetadataService, METADATA_TTL_MS, METADATA_DISK_TTL_MS, parseMetadataXml, parseMetadata } from "../src/metadata.js";
import { envTargetFor } from "../src/http.js";
import { isSanitizedError } from "../src/errors.js";
import { SAMPLE_METADATA_XML, FakeResponse, recordingFetch, xmlResponse } from "./helpers.js";

const ENV = envTargetFor({
  baseUrl: "https://tenant-a.example.com",
  auth: { type: "basic" as const, username: "u", password: "p" },
});

test("EDMX parsing extracts entity set and function import names", () => {
  const sets = parseMetadataXml(SAMPLE_METADATA_XML);
  assert.deepEqual([...sets.entitySets].sort(), ["FOOBar", "User"]);
  assert.deepEqual([...sets.functionImports], ["doThing"]);
});

test("name sets are cached per alias within the TTL and refetched on expiry", async () => {
  let clock = 1_000_000;
  const now = () => clock;
  let fetches = 0;
  const { fetch } = recordingFetch(() => {
    fetches += 1;
    return xmlResponse(SAMPLE_METADATA_XML);
  });
  const service = new MetadataService({ fetchImpl: fetch, now });

  await service.getNameSets(ENV, "tenant-a");
  assert.equal(fetches, 1);

  // Within TTL: no refetch.
  clock += METADATA_TTL_MS - 1;
  await service.getNameSets(ENV, "tenant-a");
  assert.equal(fetches, 1);

  // Beyond TTL: refetch.
  clock += 1;
  await service.getNameSets(ENV, "tenant-a");
  assert.equal(fetches, 2);

  // Different alias: separate cache entry.
  await service.getNameSets(ENV, "tenant-b");
  assert.equal(fetches, 3);
});

test("classifyFirstSegment distinguishes entity sets, function imports and unknowns", async () => {
  const { fetch } = recordingFetch(() => xmlResponse(SAMPLE_METADATA_XML));
  const service = new MetadataService({ fetchImpl: fetch });

  assert.deepEqual(await service.classifyFirstSegment(ENV, "a", "User"), { kind: "entity-set" });
  assert.deepEqual(await service.classifyFirstSegment(ENV, "a", "doThing"), { kind: "function-import" });
  assert.deepEqual(await service.classifyFirstSegment(ENV, "a", "NotAnEntity"), { kind: "unknown" });
});

test("metadata fetch failure yields METADATA_UNAVAILABLE without host details", async () => {
  const { fetch } = recordingFetch(() => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND tenant-a.example.com");
  });
  const service = new MetadataService({ fetchImpl: fetch });
  await assert.rejects(
    () => service.getNameSets(ENV, "tenant-a"),
    (error: unknown) => {
      if (!isSanitizedError(error)) {
        return false;
      }
      assert.equal(error.code, "METADATA_UNAVAILABLE");
      assert.ok(!error.message.includes("tenant-a"));
      assert.ok(!error.message.includes("ENOTFOUND"));
      return true;
    },
  );
});

test("malformed metadata XML yields METADATA_UNAVAILABLE", async () => {
  const { fetch } = recordingFetch(() => xmlResponse("<edmx:Edmx><unclosed"));
  const service = new MetadataService({ fetchImpl: fetch });
  await assert.rejects(
    () => service.getNameSets(ENV, "tenant-a"),
    (error: unknown) => {
      if (!isSanitizedError(error)) {
        return false;
      }
      assert.equal(error.code, "METADATA_UNAVAILABLE");
      return true;
    },
  );
});

test("an HTTP error from $metadata propagates as sanitized HTTP_ERROR (not masked)", async () => {
  const { fetch } = recordingFetch(
    () =>
      new FakeResponse(403, JSON.stringify({ error: { code: "403", message: { value: "Forbidden" } } })),
  );
  const service = new MetadataService({ fetchImpl: fetch });
  await assert.rejects(
    () => service.getNameSets(ENV, "tenant-a"),
    (error: unknown) => {
      if (!isSanitizedError(error)) {
        return false;
      }
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.httpStatus, 403);
      return true;
    },
  );
});

const DETAILED_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="1.0">
    <Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="SFOData">
      <EntityType Name="User">
        <Key><PropertyRef Name="userId"/></Key>
        <Property Name="userId" Type="Edm.String" Nullable="false" MaxLength="100"/>
        <Property Name="username" Type="Edm.String" Nullable="true"/>
        <NavigationProperty Name="jobInfoNav" Relationship="SFOData.User_jobInfoNav" FromRole="User" ToRole="EmpJob"/>
        <NavigationProperty Name="personalInfoNav" Relationship="SFOData.User_personalInfoNav" FromRole="User" ToRole="PerPersonal"/>
      </EntityType>
      <EntityType Name="EmpJob">
        <Key><PropertyRef Name="seqNumber"/></Key>
        <Property Name="seqNumber" Type="Edm.Int64" Nullable="false"/>
      </EntityType>
      <EntityType Name="PerPersonal">
        <Key><PropertyRef Name="personId"/></Key>
        <Property Name="personId" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <Association Name="User_jobInfoNav">
        <End Role="User" Type="SFOData.User" Multiplicity="1"/>
        <End Role="EmpJob" Type="SFOData.EmpJob" Multiplicity="*"/>
      </Association>
      <Association Name="User_personalInfoNav">
        <End Role="User" Type="SFOData.User" Multiplicity="1"/>
        <End Role="PerPersonal" Type="SFOData.PerPersonal" Multiplicity="0..1"/>
      </Association>
      <EntityContainer Name="EntityContainer" m:IsDefaultEntityContainer="true">
        <EntitySet Name="User" EntityType="SFOData.User"/>
        <EntitySet Name="EmpJob" EntityType="SFOData.EmpJob"/>
        <EntitySet Name="PerPersonal" EntityType="SFOData.PerPersonal"/>
        <AssociationSet Name="User_jobInfoNav" Association="SFOData.User_jobInfoNav">
          <End Role="User" EntitySet="User"/>
          <End Role="EmpJob" EntitySet="EmpJob"/>
        </AssociationSet>
        <AssociationSet Name="User_personalInfoNav" Association="SFOData.User_personalInfoNav">
          <End Role="User" EntitySet="User"/>
          <End Role="PerPersonal" EntitySet="PerPersonal"/>
        </AssociationSet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

test("parseMetadata extracts exhaustive schema details with navigation and multiplicity", () => {
  const parsed = parseMetadata(DETAILED_EDMX);
  assert.deepEqual(parsed.entitySets.sort(), ["EmpJob", "PerPersonal", "User"]);

  const userSchema = parsed.entitySchemas["User"];
  assert.ok(userSchema);
  assert.equal(userSchema.entitySet, "User");
  assert.equal(userSchema.entityType, "SFOData.User");
  assert.deepEqual(userSchema.keys, ["userId"]);
  assert.deepEqual(userSchema.properties, [
    { name: "userId", type: "Edm.String", nullable: false, maxLength: 100 },
    { name: "username", type: "Edm.String", nullable: true },
  ]);

  assert.equal(userSchema.navigationProperties.length, 2);
  const jobNav = userSchema.navigationProperties.find((n) => n.name === "jobInfoNav");
  assert.ok(jobNav);
  assert.equal(jobNav.targetEntitySet, "EmpJob");
  assert.equal(jobNav.relationship, "SFOData.User_jobInfoNav");
  assert.equal(jobNav.multiplicity, "*");

  const personalNav = userSchema.navigationProperties.find((n) => n.name === "personalInfoNav");
  assert.ok(personalNav);
  assert.equal(personalNav.targetEntitySet, "PerPersonal");
  assert.equal(personalNav.relationship, "SFOData.User_personalInfoNav");
  assert.equal(personalNav.multiplicity, "0..1");
});

test("MetadataService caches parsed metadata to local disk and reloads it without network calls", async () => {
  const tmpCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-metadata-cache-"));
  try {
    let fetches = 0;
    const { fetch } = recordingFetch(() => {
      fetches += 1;
      return xmlResponse(DETAILED_EDMX);
    });

    let clock = 10_000_000;
    const now = () => clock;

    // Service instance 1: fetches from network and writes to disk
    const service1 = new MetadataService({
      fetchImpl: fetch,
      now,
      cacheDir: tmpCacheDir,
      ttlMs: METADATA_TTL_MS,
      diskTtlMs: METADATA_DISK_TTL_MS,
    });

    const parsed1 = await service1.getParsedMetadata(ENV, "test-tenant");
    assert.equal(fetches, 1);
    assert.equal(parsed1.entitySets.length, 3);

    // Verify cache file was created on disk
    const cacheFile = path.join(tmpCacheDir, "metadata-test-tenant.json");
    const diskContent = await fs.readFile(cacheFile, "utf-8");
    const json = JSON.parse(diskContent) as { fetchedAt: number; data: unknown };
    assert.equal(json.fetchedAt, clock);

    // Service instance 2: brand new process/instance with empty in-memory cache
    const service2 = new MetadataService({
      fetchImpl: fetch,
      now,
      cacheDir: tmpCacheDir,
      ttlMs: METADATA_TTL_MS,
      diskTtlMs: METADATA_DISK_TTL_MS,
    });

    const parsed2 = await service2.getParsedMetadata(ENV, "test-tenant");
    // fetches must STILL be 1 because it read from disk!
    assert.equal(fetches, 1);
    assert.deepEqual(parsed2.entitySets, parsed1.entitySets);

    // Advance clock past disk TTL: must refetch and update disk
    clock += METADATA_DISK_TTL_MS + 1000;
    const service3 = new MetadataService({
      fetchImpl: fetch,
      now,
      cacheDir: tmpCacheDir,
      ttlMs: METADATA_TTL_MS,
      diskTtlMs: METADATA_DISK_TTL_MS,
    });
    await service3.getParsedMetadata(ENV, "test-tenant");
    assert.equal(fetches, 2);
  } finally {
    await fs.rm(tmpCacheDir, { recursive: true, force: true });
  }
});

