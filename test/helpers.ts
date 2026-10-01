/**
 * Shared test helpers: fake fetch (request capture + canned responses),
 * config file factory, and an in-memory MCP client/server harness.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyFetchInit, FetchImpl, MinimalResponse } from "../src/http.js";
import { createMcpServer, type ServerDeps } from "../src/tools.js";

export class FakeResponse implements MinimalResponse {
  readonly headers: { get(name: string): string | null };

  constructor(
    readonly status: number,
    private readonly bodyText: string,
    hdrs: Record<string, string> = {},
  ) {
    const lower: Record<string, string> = {};
    for (const [key, value] of Object.entries(hdrs)) {
      lower[key.toLowerCase()] = value;
    }
    this.headers = {
      get: (name: string) => lower[name.toLowerCase()] ?? null,
    };
  }

  async text(): Promise<string> {
    return this.bodyText;
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): FakeResponse {
  return new FakeResponse(status, JSON.stringify(body), headers);
}

export function xmlResponse(body: string, status = 200, headers: Record<string, string> = {}): FakeResponse {
  return new FakeResponse(status, body, headers);
}

export function redirectResponse(location: string, status = 302): FakeResponse {
  return new FakeResponse(status, "", { location });
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type Responder = (
  url: string,
  init: AnyFetchInit,
  callIndex: number,
) => MinimalResponse | Promise<MinimalResponse>;

export interface RecordingFetch {
  fetch: FetchImpl;
  requests: CapturedRequest[];
}

export function recordingFetch(responder: Responder): RecordingFetch {
  const requests: CapturedRequest[] = [];
  const impl: FetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: { ...init.headers } });
    return await responder(url, init, requests.length - 1);
  };
  return { fetch: impl, requests };
}

export const SAMPLE_METADATA_XML = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="1.0">
    <Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="SFOData">
      <EntityType Name="User">
        <Key><PropertyRef Name="userId"/></Key>
        <Property Name="userId" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntityType Name="FOOBar">
        <Key><PropertyRef Name="id"/></Key>
        <Property Name="id" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="EntityContainer" m:IsDefaultEntityContainer="true">
        <EntitySet Name="User" EntityType="SFOData.User"/>
        <EntitySet Name="FOOBar" EntityType="SFOData.FOOBar"/>
        <FunctionImport Name="doThing" ReturnType="Edm.String" m:HttpMethod="GET"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

/** Default success responder: serves $metadata plus one canned query page. */
export function standardSfResponder(queryBody: unknown): Responder {
  return (url) => {
    if (url.endsWith("/$metadata")) {
      return xmlResponse(SAMPLE_METADATA_XML, 200, { "content-type": "application/xml" });
    }
    return jsonResponse(queryBody);
  };
}

export interface TestEnvSpec {
  baseUrl?: string;
  username?: string;
  password?: string;
}

export function configJson(environments: Record<string, TestEnvSpec>): string {
  const entries = Object.entries(environments).map(([alias, spec]) => {
    const baseUrl = spec.baseUrl ?? "https://tenant-a.example.com";
    const username = spec.username ?? "apiuser@tenantA";
    const password = spec.password ?? "secret-password-a";
    return `    "${alias}": {
      "baseUrl": "${baseUrl}",
      "auth": { "type": "basic", "username": "${username}", "password": "${password}" }
    }`;
  });
  return `{\n  "environments": {\n${entries.join(",\n")}\n  }\n}\n`;
}

export async function writeConfigFile(
  contents: string,
  options: { mode?: number } = {},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-test-"));
  const filePath = path.join(dir, "config.json");
  await fs.writeFile(filePath, contents, "utf-8");
  if (options.mode !== undefined) {
    await fs.chmod(filePath, options.mode);
  }
  return filePath;
}

export async function writeStandardConfig(
  environments: Record<string, TestEnvSpec> = { "tenant-a": {} },
): Promise<string> {
  return await writeConfigFile(configJson(environments), { mode: 0o600 });
}

export type TestClient = Client;

export async function withTestServer<T>(
  deps: ServerDeps,
  fn: (client: TestClient) => Promise<T>,
): Promise<T> {
  const server = createMcpServer(deps);
  const client = new Client({ name: "ssff-mcp-test", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export type CallResult = CallToolResult & {
  structuredContent?: Record<string, unknown>;
};

export async function callTool(
  client: TestClient,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

/** Extract the sanitized error payload `{code, message, httpStatus?}` from an isError result. */
export function errorPayload(result: CallResult): { code: string; message: string; httpStatus?: number } {
  if (!result.isError) {
    throw new Error("expected an isError result");
  }
  return result.structuredContent as { code: string; message: string; httpStatus?: number };
}
