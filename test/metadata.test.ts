import test from "node:test";
import assert from "node:assert/strict";
import { MetadataService, METADATA_TTL_MS, parseMetadataXml } from "../src/metadata.js";
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
