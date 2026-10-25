/**
 * HTTP dispatch for tenant reads. GET-only by construction: this module has
 * exactly one code path, it always sends method GET, and there is no input
 * surface (tool argument or config field) that can change the method, add
 * headers, or override the host/scheme/base URL.
 *
 * - Host/scheme come only from the environment config.
 * - Redirects are handled manually: same host + https only, max 5 hops.
 * - Timeouts via AbortController -> TIMEOUT.
 * - Network failures -> generic NETWORK_ERROR (never leaks hostnames from
 *   Node fetch errors).
 * - Non-2xx -> sanitized HTTP_ERROR with best-effort OData error parsing.
 */

import { SanitizedError, redactUrls, sanitizeMessage } from "./errors.js";
import type { EnvironmentConfig, OAuthAuthConfig } from "./config.js";
import { getAuthorizationHeader, invalidateOAuthToken } from "./oauth.js";
import { createHash } from "node:crypto";
import type { OAuthFetch, OAuthPostInit } from "./oauth.js";
import { PACKAGE_VERSION } from "./version.js";

/**
 * The `User-Agent` this server sends to SuccessFactors: name, version and the
 * platform it is actually running on. The tenant sees this on every request, so
 * the platform must be the real one, never a fixed token.
 */
export function userAgentFor(platform: string, version: string): string {
  return `ssff-mcp/${version} (+mcp; ${platform})`;
}

export const USER_AGENT = userAgentFor(process.platform, PACKAGE_VERSION);
export const MAX_REDIRECT_HOPS = 5;

/** Exactly the headers every request carries. Nothing else, ever. */
export function buildHeaders(accept: string, authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    Accept: accept,
    "User-Agent": USER_AGENT,
  };
}

export interface EnvTarget {
  /** Namespace for the hosted edge; absent preserves the local API contract. */
  tenantId?: string;
  /** Environment alias (OAuth token cache key; "" only in basic-auth unit tests). */
  alias: string;
  /** Absolute service root, always ending with `/` (e.g. https://host/odata/v2/). */
  serviceRoot: string;
  /** hostname(+port) every request/redirect must match. */
  expectedHost: string;
  auth:
    | { kind: "basic"; username: string; password: string }
    | { kind: "oauth"; config: OAuthAuthConfig };
}

/** Normalize a URL's host to hostname(:port) with default ports collapsed. */
export function hostOf(url: URL): string {
  let port = url.port;
  if ((url.protocol === "https:" && port === "443") || (url.protocol === "http:" && port === "80")) {
    port = "";
  }
  return port === "" ? url.hostname : `${url.hostname}:${port}`;
}

export function envTargetFor(env: Pick<EnvironmentConfig, "baseUrl" | "auth">, alias = "", tenantId?: string): EnvTarget {
  const rootUrl = new URL(env.baseUrl);
  const serviceRoot = env.baseUrl.replace(/\/+$/, "") + "/odata/v2/";
  return {
    alias,
    ...(tenantId === undefined ? {} : { tenantId }),
    serviceRoot,
    expectedHost: hostOf(rootUrl),
    auth:
      env.auth.type === "basic"
        ? { kind: "basic", username: env.auth.username, password: env.auth.password }
        : { kind: "oauth", config: env.auth },
  };
}

export interface MinimalResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: "GET";
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
}

/**
 * The single fixed `$batch` POST of batch_get (DS-P2-04): body is the
 * GET-only multipart envelope built by odata-batch's retrieve mode; the
 * transport validates it before dispatch (src/batch.ts).
 */
export interface BatchPostInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  redirect: "manual";
  signal: AbortSignal;
}

/**
 * Injectable fetch union: data reads are always GET (dispatchGet); the only
 * POSTs in this codebase are the two fixed OAuth endpoints (src/oauth.ts,
 * DS-P2-05) and the single fixed `$batch` POST of batch_get (src/batch.ts,
 * DS-P2-04 — GET-only multipart envelope). No other method shape exists.
 */
export type AnyFetchInit = FetchInitLike | OAuthPostInit | BatchPostInit;

export type FetchImpl = (url: string, init: AnyFetchInit) => Promise<MinimalResponse>;

export const defaultFetch: FetchImpl = (url, init) => fetch(url, init);

export interface DispatchOptions {
  accept: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
  /** Injectable clock/sleep forwarded to the OAuth token manager (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DispatchResult {
  status: number;
  body: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Resolve the Authorization header: Basic (sync) or Bearer via the OAuth token manager. */
async function buildAuthorization(env: EnvTarget, options: DispatchOptions): Promise<string> {
  if (env.auth.kind === "basic") {
    return "Basic " + Buffer.from(`${env.auth.username}:${env.auth.password}`, "utf-8").toString("base64");
  }
  return await getAuthorizationHeader(oauthCacheKey(env), env.auth.config, {
    fetchImpl: options.fetchImpl,
    now: options.now,
    sleep: options.sleep,
  });
}

export function oauthCacheKey(env: EnvTarget): string {
  return env.tenantId === undefined ? env.alias : createHash("sha256")
    .update(JSON.stringify([env.tenantId, env.alias, env.serviceRoot, env.auth])).digest("hex");
}

export async function dispatchGet(
  env: EnvTarget,
  pathAndQuery: string,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;

  // The URL is built exclusively from the configured service root; tool
  // inputs never touch scheme, host or base URL.
  let current = new URL(pathAndQuery, env.serviceRoot);
  let hops = 0;
  let authRetried = false;

  for (;;) {
    // Defense in depth: every request must stay on the configured https host.
    if (current.protocol !== "https:" || hostOf(current) !== env.expectedHost) {
      throw new SanitizedError(
        "REDIRECT_BLOCKED",
        "redirect to a host different from the configured environment host was blocked",
      );
    }

    const authorization = await buildAuthorization(env, options);
    const headers = buildHeaders(options.accept, authorization);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: MinimalResponse;
    try {
      response = await fetchImpl(current.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SanitizedError("TIMEOUT", "request to the configured environment timed out");
      }
      // Never include the raw error: Node fetch errors embed hostnames.
      throw new SanitizedError("NETWORK_ERROR", "request to the configured environment failed");
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location.length === 0) {
        throw await httpError(response, "missing redirect location");
      }
      if (hops >= MAX_REDIRECT_HOPS) {
        throw new SanitizedError("REDIRECT_BLOCKED", `too many redirects (limit ${MAX_REDIRECT_HOPS})`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SanitizedError("REDIRECT_BLOCKED", "redirect target was invalid and was blocked");
      }
      if (hostOf(next) !== env.expectedHost) {
        throw new SanitizedError(
          "REDIRECT_BLOCKED",
          "redirect to a host different from the configured environment host was blocked",
        );
      }
      if (next.protocol !== "https:") {
        throw new SanitizedError("REDIRECT_BLOCKED", "redirect to a non-https target was blocked");
      }
      current = next;
      hops += 1;
      continue;
    }

    // OAuth 401 recovery (FR-33): drop the cached token and retry the GET
    // exactly once with a freshly acquired header. Basic environments never
    // retry (no error amplification).
    if (response.status === 401 && env.auth.kind === "oauth" && !authRetried) {
      invalidateOAuthToken(oauthCacheKey(env));
      authRetried = true;
      continue;
    }

    if (!(response.status >= 200 && response.status <= 299)) {
      throw await httpError(response);
    }

    return { status: response.status, body: await response.text() };
  }
}

const STATUS_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method not allowed",
  406: "Not acceptable",
  429: "Too many requests",
  500: "internal server error",
  502: "bad gateway",
  503: "service unavailable",
  504: "gateway timeout",
};

interface ServiceError {
  code?: string;
  message?: string;
}

/** Best-effort parse of OData v2 error bodies (JSON or XML). */
async function parseServiceError(body: string): Promise<ServiceError> {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const err = (parsed as { error: unknown }).error;
        if (typeof err === "object" && err !== null) {
          const e = err as Record<string, unknown>;
          const code = typeof e.code === "string" ? e.code : undefined;
          let message: string | undefined;
          if (typeof e.message === "string") {
            message = e.message;
          } else if (
            typeof e.message === "object" &&
            e.message !== null &&
            typeof (e.message as { value?: unknown }).value === "string"
          ) {
            message = (e.message as { value: string }).value;
          }
          return { code, message };
        }
      }
    } catch {
      // fall through
    }
    return {};
  }
  if (trimmed.startsWith("<")) {
    const codeMatch = /<code[^>]*>([\s\S]*?)<\/code>/.exec(trimmed);
    const messageMatch = /<message[^>]*>([\s\S]*?)<\/message>/.exec(trimmed);
    const decode = (value: string): string =>
      value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
    if (codeMatch !== null || messageMatch !== null) {
      return {
        code: codeMatch?.[1] !== undefined ? decode(codeMatch[1]) : undefined,
        message: messageMatch?.[1] !== undefined ? decode(messageMatch[1]) : undefined,
      };
    }
  }
  return {};
}

async function httpError(response: MinimalResponse, extraReason?: string): Promise<SanitizedError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // Body is best-effort only.
  }
  const service = await parseServiceError(body);
  const parts: string[] = [`status ${response.status}`];
  if (service.code !== undefined && service.code.length > 0) {
    parts.push(service.code);
  }
  if (service.message !== undefined && service.message.length > 0) {
    parts.push(redactUrls(service.message));
  } else if (extraReason !== undefined) {
    parts.push(extraReason);
  } else {
    const phrase = STATUS_PHRASES[response.status] ?? "http error";
    parts.push(phrase);
  }
  const message = sanitizeMessage(parts.join(": "));
  return new SanitizedError("HTTP_ERROR", message, response.status);
}
