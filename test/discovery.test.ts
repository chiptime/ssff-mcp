import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { discoverEntities } from "../src/cli/discovery.js";
import { SAMPLE_METADATA_XML, jsonResponse, recordingFetch, xmlResponse } from "./helpers.js";

const ENVIRONMENT = {
  baseUrl: "https://api2.successfactors.eu",
  auth: { type: "basic", username: "u", password: "p" } as const,
};

function metadataResponder() {
  return recordingFetch((url: string) =>
    url.endsWith("/$metadata")
      ? xmlResponse(SAMPLE_METADATA_XML, 200, { "content-type": "application/xml" })
      : jsonResponse({}),
  );
}

async function tempCacheDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ssff-discovery-"));
}

test("discoverEntities returns sorted entity sets parsed from $metadata", async () => {
  const { fetch } = metadataResponder();
  const entities = await discoverEntities({
    environment: ENVIRONMENT,
    alias: "prod",
    fetchImpl: fetch,
    cacheDir: await tempCacheDir(),
  });
  assert.deepEqual(entities, ["FOOBar", "User"]);
});

test("discoverEntities prewarms the disk cache under the given alias", async () => {
  const cacheDir = await tempCacheDir();
  const { fetch } = metadataResponder();
  await discoverEntities({ environment: ENVIRONMENT, alias: "prod", fetchImpl: fetch, cacheDir });
  const cacheFile = path.join(cacheDir, "metadata-prod.json");
  const parsed = JSON.parse(await fs.readFile(cacheFile, "utf-8")) as { data: { entitySets: string[] } };
  assert.ok(parsed.data.entitySets.includes("User"), "cache should contain the parsed entity sets");
});

test("discoverEntities rejects when the tenant cannot be reached", async () => {
  const cacheDir = await tempCacheDir();
  const { fetch } = recordingFetch(() => jsonResponse({ error: "denied" }, 401));
  await assert.rejects(() =>
    discoverEntities({ environment: ENVIRONMENT, alias: "prod", fetchImpl: fetch, cacheDir }),
  );
});
