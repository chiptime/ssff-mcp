import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { recordingFetch, standardSfResponder, withTestServer, callTool } from "./helpers.js";

/** Run `fn` with the given SF_* process env vars set (undefined deletes), restoring afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(vars);
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key]!;
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key]!;
      }
    }
  }
}

function missingPath(): string {
  return path.join(os.tmpdir(), `ssff-mcp-inline-tools-missing-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

const INLINE_ENV = {
  SF_BASE_URL: "https://api2.successfactors.eu",
  SF_USERNAME: "u",
  SF_PASSWORD: "p",
  SF_ENVIRONMENT: undefined,
  SF_ENTITY_ALLOWLIST: undefined,
  SF_CLIENT_ID: undefined,
  SF_COMPANY_ID: undefined,
  SF_USER_ID: undefined,
  SF_TOKEN_URL: undefined,
  SF_IDP_URL: undefined,
  SF_PRIVATE_KEY: undefined,
} as const;

test("inline: query_entity accepts an omitted environment and resolves the inline alias", async () => {
  await withEnv({ ...INLINE_ENV }, async () => {
    const { fetch } = recordingFetch(standardSfResponder({ d: { results: [{ userId: "u1" }] } }));
    await withTestServer({ configPath: missingPath(), fetchImpl: fetch }, async (client) => {
      const omitted = await callTool(client, "query_entity", { entityPath: "User" });
      const explicit = await callTool(client, "query_entity", { environment: "default", entityPath: "User" });
      assert.equal(omitted.isError ?? false, false);
      assert.deepEqual(omitted.structuredContent, explicit.structuredContent);
      const structured = omitted.structuredContent as { environment?: string; recordCount?: number };
      assert.equal(structured.environment, "default");
      assert.equal(structured.recordCount, 1);
    });
  });
});

test("inline: batch_get accepts an omitted environment and resolves the inline alias", async () => {
  await withEnv({ ...INLINE_ENV }, async () => {
    const { fetch } = recordingFetch(standardSfResponder({ d: {} }));
    await withTestServer({ configPath: missingPath(), fetchImpl: fetch }, async (client) => {
      const omitted = await callTool(client, "batch_get", { requests: [{ entityPath: "User" }] });
      const explicit = await callTool(client, "batch_get", { environment: "default", requests: [{ entityPath: "User" }] });
      assert.equal(omitted.isError ?? false, explicit.isError ?? false);
      assert.deepEqual(omitted.structuredContent, explicit.structuredContent);
    });
  });
});
