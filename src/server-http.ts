/**
 * The hosted edge: `ssff-mcp serve` (PRD-feature-multitenant-hosting.md,
 * D-115/D-116/D-123, FR-154..FR-166).
 *
 * One Streamable HTTP endpoint (`/mcp`) plus a public health probe
 * (`/healthz`). Every request re-authenticates: the presented API key
 * resolves `{ tenant, allowedEnvironments }` (fail-closed — never a default
 * tenant), each MCP session is bound to the tenant that opened it, and the
 * session's server is pinned to that tenant's config slice (D-118) with the
 * key's environment scope enforced inside the engine boundary (FR-160).
 *
 * The engine (`createMcpServer`) stays tenant-agnostic: it only receives a
 * pinned `tenantId` and an optional alias scope, exactly like stdio receives
 * a single-tenant config.
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "./tools.js";
import { loadTenantKeyDirectory } from "./config.js";
import { resolveTenant, sha256Hex, type TenantResolution } from "./tenancy.js";
import { PACKAGE_VERSION } from "./version.js";
import type { FetchImpl } from "./http.js";
import { isSanitizedError } from "./errors.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_PORT = 8080;
const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_SESSION_IDLE_MS = 5 * 60 * 1000;

export interface ServeHttpOptions {
  configPath?: string;
  port?: number;
  host?: string;
  /**
   * Concurrent session cap (FR-164); default SSFF_MAX_SESSIONS or 50.
   */
  maxSessions?: number;
  /**
   * Sessions idle longer than this are closed (clients that vanish without a
   * DELETE leak otherwise). Default SSFF_SESSION_IDLE_MS or 5 minutes.
   */
  sessionIdleMs?: number;
  /** Maximum drain time before remaining connections are forced closed. */
  shutdownTimeoutMs?: number;
  /**
   * Port-agnostic Host allowlist (DS-MTH-05, DNS-rebinding protection).
   * Default: SSFF_ALLOWED_HOSTS split by comma; when unset only a present,
   * non-empty Host header is required (the proxy owns routing in practice).
   */
  allowedHosts?: string[];
  fetchImpl?: FetchImpl;
  cacheDir?: string;
  disableDiskCache?: boolean;
  /** Structured request log (FR-166); defaults to stderr. Never receives keys. */
  log?: (line: string) => void;
}

export interface RunningHttpServer {
  port: number;
  sessionsCount(): number;
  /** Stop accepting connections and close every session. Resolves when done. */
  close(): Promise<void>;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tenantId: string;
  keyDigest: string;
  scope: string;
  lastActivity: number;
  activeRequests: number;
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (typeof hostHeader !== "string" || hostHeader.trim().length === 0) {
    return undefined;
  }
  // Port-agnostic comparison; IPv6 keeps its brackets.
  const host = hostHeader.trim().toLowerCase();
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function presentedKey(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    const key = authorization.slice(7).trim();
    if (key.length > 0) {
      return key;
    }
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  return undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

class BodyTooLargeError extends Error {}

export function startHttpServer(options: ServeHttpOptions = {}): Promise<RunningHttpServer> {
  const log =
    options.log ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const maxSessions = options.maxSessions ?? envInt("SSFF_MAX_SESSIONS") ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleMs =
    options.sessionIdleMs ?? envInt("SSFF_SESSION_IDLE_MS") ?? DEFAULT_SESSION_IDLE_MS;
  const allowedHosts =
    options.allowedHosts ??
    (process.env.SSFF_ALLOWED_HOSTS !== undefined && process.env.SSFF_ALLOWED_HOSTS.trim().length > 0
      ? process.env.SSFF_ALLOWED_HOSTS!.split(",").map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
      : ["localhost", "127.0.0.1", "[::1]"]);
  const port = options.port ?? envInt("PORT") ?? DEFAULT_PORT;
  const host = options.host ?? "0.0.0.0";
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535");
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("maxSessions must be a positive integer");
  if (!Number.isFinite(sessionIdleMs) || sessionIdleMs < 1) throw new Error("sessionIdleMs must be positive");
  let closing = false;
  let pendingInitializations = 0;
  let inFlight = 0;

  const sessions = new Map<string, SessionEntry>();

  function requestLog(
    req: IncomingMessage,
    status: number,
    startedAt: number,
    extra: { tenantId?: string; sessionId?: string } = {},
  ): void {
    // Metadata only (FR-166): no keys, no tokens, no payload.
    log(
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: (req.url ?? "").split("?")[0],
        status,
        durationMs: Date.now() - startedAt,
        ...extra,
      }),
    );
  }

  async function authenticate(req: IncomingMessage): Promise<TenantResolution | null> {
    // The mounted config is re-read per request (D-124): a tenant added on
    // the volume is picked up without a redeploy. No secrets are resolved.
    let directory: Awaited<ReturnType<typeof loadTenantKeyDirectory>>;
    try {
      directory = await loadTenantKeyDirectory({ configPath: options.configPath });
    } catch (error) {
      const message = isSanitizedError(error) ? error.message : "configuration could not be read";
      log(JSON.stringify({ ts: new Date().toISOString(), event: "config-error", message }));
      return null;
    }
    return resolveTenant(directory, presentedKey(req));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const path = (req.url ?? "").split("?")[0]!;

    if (req.method === "GET" && path === "/healthz") {
      // Public probe (FR-162): no auth, no SAP, no sessions disclosed.
      sendJson(res, 200, {
        status: "ok",
        version: PACKAGE_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
      });
      requestLog(req, 200, startedAt);
      return;
    }

    if (path !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      requestLog(req, 404, startedAt);
      return;
    }
    if (closing) { sendJson(res, 503, { error: "server shutting down" }); return; }
    if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
      res.setHeader("Allow", "GET, POST, DELETE");
      sendJson(res, 405, { error: "method not allowed" }); return;
    }

    // DS-MTH-05: Host validation (port-agnostic) against the optional list.
    const hostname = hostnameOf(req.headers.host);
    if (hostname === undefined || (allowedHosts !== undefined && !allowedHosts.includes(hostname))) {
      sendJson(res, 400, { error: "bad host" });
      requestLog(req, 400, startedAt);
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let trusted = false;
      try {
        const url = new URL(origin);
        trusted = ["https:", "http:"].includes(url.protocol) && url.username === "" && url.password === "" &&
          url.host.toLowerCase() === req.headers.host?.toLowerCase();
      } catch { /* Invalid and opaque origins are denied. */ }
      if (!trusted) { sendJson(res, 403, { error: "origin not allowed" }); return; }
    }

    const resolution = await authenticate(req);
    if (resolution === null) {
      // Fail-closed (FR-159): no key, unknown key or unreadable config.
      res.setHeader("WWW-Authenticate", 'Bearer realm="ssff-mcp"');
      sendJson(res, 401, { error: "unauthorized" });
      requestLog(req, 401, startedAt);
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" && sessionIdHeader.length > 0 ? sessionIdHeader : undefined;

    if (sessionId === undefined && req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: "payload too large" });
          requestLog(req, 413, startedAt);
          return;
        }
        sendJson(res, 400, { error: "invalid JSON body" });
        requestLog(req, 400, startedAt);
        return;
      }
      if (!isInitializeRequest(body)) {
        sendJson(res, 400, { error: "initialize required before other requests" });
        requestLog(req, 400, startedAt);
        return;
      }
      if (sessions.size + pendingInitializations >= maxSessions) {
        sendJson(res, 503, { error: "too many concurrent sessions" });
        requestLog(req, 503, startedAt, { tenantId: resolution.tenantId });
        return;
      }

      pendingInitializations += 1;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          // Registered after a successful initialize response.
          sessions.set(id, entry);
          log(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: "session-open",
              tenantId: entry.tenantId,
              sessionId: id,
              activeSessions: sessions.size,
            }),
          );
        },
      });
      const server = createMcpServer({
        configPath: options.configPath,
        fetchImpl: options.fetchImpl,
        cacheDir: options.cacheDir,
        disableDiskCache: options.disableDiskCache,
        tenantId: resolution.tenantId,
        allowedEnvironments: resolution.allowedEnvironments,
        onConfigWarning: () => log(JSON.stringify({ event: "config-warning", tenantId: resolution.tenantId })),
        logSink: (line) => log(JSON.stringify({ ...JSON.parse(line),
          tenantId: resolution.tenantId, sessionId: transport.sessionId })),
      });
      const entry: SessionEntry = { transport, server, tenantId: resolution.tenantId,
        keyDigest: sha256Hex(presentedKey(req)!), scope: JSON.stringify(resolution.allowedEnvironments),
        lastActivity: Date.now(), activeRequests: 0 };
      try { await server.connect(transport); }
      catch (error) { pendingInitializations -= 1; throw error; }
      // Compose with the SDK's bookkeeping; never overwrite its close hook.
      const sdkClose = transport.onclose;
      transport.onclose = () => {
        sdkClose?.();
        const id = transport.sessionId;
        if (id !== undefined && sessions.get(id) === entry) {
          sessions.delete(id);
          log(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: "session-close",
              tenantId: entry.tenantId,
              sessionId: id,
              activeSessions: sessions.size,
            }),
          );
        }
      };
      try { await transport.handleRequest(req, res, body); }
      finally {
        pendingInitializations -= 1;
        if (transport.sessionId === undefined) await server.close();
      }
      requestLog(req, res.statusCode, startedAt, { tenantId: resolution.tenantId });
      return;
    }

    if (sessionId === undefined) {
      sendJson(res, 400, { error: "missing Mcp-Session-Id" });
      requestLog(req, 400, startedAt);
      return;
    }

    const entry = sessions.get(sessionId);
    if (entry === undefined) {
      sendJson(res, 404, { error: "session not found" });
      requestLog(req, 404, startedAt, { tenantId: resolution.tenantId, sessionId });
      return;
    }
    // A session belongs to the tenant that opened it (invariant 1): a key of
    // another tenant must never ride an existing session.
    if (resolution.tenantId !== entry.tenantId || entry.keyDigest !== sha256Hex(presentedKey(req)!) ||
        entry.scope !== JSON.stringify(resolution.allowedEnvironments)) {
      sendJson(res, 401, { error: "unauthorized" });
      requestLog(req, 401, startedAt, { tenantId: resolution.tenantId, sessionId });
      return;
    }
    entry.lastActivity = Date.now();

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: "payload too large" });
          requestLog(req, 413, startedAt);
          return;
        }
        sendJson(res, 400, { error: "invalid JSON body" });
        requestLog(req, 400, startedAt);
        return;
      }
      entry.activeRequests += 1;
      try { await entry.transport.handleRequest(req, res, body); }
      finally { entry.activeRequests -= 1; entry.lastActivity = Date.now(); }
    } else {
      // GET (standalone SSE) and DELETE (terminate the session).
      await entry.transport.handleRequest(req, res);
    }
    requestLog(req, res.statusCode, startedAt, { tenantId: resolution.tenantId, sessionId });
  }

  return new Promise<RunningHttpServer>((resolve, reject) => {
    const httpServer = createServer((req, res) => {
      const tracked = req.method !== "GET";
      if (tracked) inFlight += 1;
      handle(req, res).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal error" });
        } else {
          res.end();
        }
      }).finally(() => { if (tracked) inFlight -= 1; });
    });
    httpServer.on("error", reject);

    // Idle sweep: clients that vanish without a DELETE must not leak sessions.
    // transport.close() runs the onclose bookkeeping for each swept session.
    const sweepInterval = setInterval(
      () => {
        const now = Date.now();
        for (const [id, entry] of sessions) {
          if (entry.activeRequests === 0 && now - entry.lastActivity > sessionIdleMs) {
            log(
              JSON.stringify({
                ts: new Date().toISOString(),
                event: "session-idle-close",
                tenantId: entry.tenantId,
                sessionId: id,
              }),
            );
            void entry.transport.close().catch(() => undefined);
          }
        }
      },
      Math.max(50, Math.min(sessionIdleMs / 2, 60_000)),
    );
    sweepInterval.unref();

    httpServer.listen(port, host, () => {
      const bound = httpServer.address();
      const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;
      resolve({
        port: boundPort,
        sessionsCount: () => sessions.size,
        close: async () => {
          closing = true;
          clearInterval(sweepInterval);
          const stopped = new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
          const deadline = Date.now() + (options.shutdownTimeoutMs ?? 10_000);
          while (inFlight > 0 && Date.now() < deadline) {
            await new Promise((resolveDrain) => setTimeout(resolveDrain, 10));
          }
          for (const entry of sessions.values()) {
            await entry.transport.close().catch(() => undefined);
          }
          sessions.clear();
          httpServer.closeAllConnections();
          await stopped;
        },
      });
    });
  });
}
