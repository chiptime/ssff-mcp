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
import type { EnvironmentConfig } from "./config.js";

export const USER_AGENT = "ssff-mcp/0.1.0 (+mcp; linux)";
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
  /** Absolute service root, always ending with `/` (e.g. https://host/odata/v2/). */
  serviceRoot: string;
  /** hostname(+port) every request/redirect must match. */
  expectedHost: string;
  username: string;
  password: string;
}

/** Normalize a URL's host to hostname(:port) with default ports collapsed. */
function hostOf(url: URL): string {
  let port = url.port;
  if ((url.protocol === "https:" && port === "443") || (url.protocol === "http:" && port === "80")) {
    port = "";
  }
  return port === "" ? url.hostname : `${url.hostname}:${port}`;
}

export function envTargetFor(env: EnvironmentConfig): EnvTarget {
  const rootUrl = new URL(env.baseUrl);
  const serviceRoot = env.baseUrl.replace(/\/+$/, "") + "/odata/v2/";
  return {
    serviceRoot,
    expectedHost: hostOf(rootUrl),
    username: env.auth.username,
    password: env.auth.password,
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

export type FetchImpl = (url: string, init: FetchInitLike) => Promise<MinimalResponse>;

const defaultFetch: FetchImpl = (url, init) => fetch(url, init);

export interface DispatchOptions {
  accept: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
}

export interface DispatchResult {
  status: number;
  body: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function dispatchGet(
  env: EnvTarget,
  pathAndQuery: string,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const authorization =
    "Basic " + Buffer.from(`${env.username}:${env.password}`, "utf-8").toString("base64");
  const headers = buildHeaders(options.accept, authorization);

  // The URL is built exclusively from the configured service root; tool
  // inputs never touch scheme, host or base URL.
  let current = new URL(pathAndQuery, env.serviceRoot);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    // Defense in depth: every request must stay on the configured https host.
    if (current.protocol !== "https:" || hostOf(current) !== env.expectedHost) {
      throw new SanitizedError(
        "REDIRECT_BLOCKED",
        "redirect to a host different from the configured environment host was blocked",
      );
    }

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
      if (hop === MAX_REDIRECT_HOPS) {
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
      continue;
    }

    if (!(response.status >= 200 && response.status <= 299)) {
      throw await httpError(response);
    }

    return { status: response.status, body: await response.text() };
  }

  // Unreachable: the loop either returns or throws.
  throw new SanitizedError("INTERNAL_ERROR", "an unexpected internal error occurred");
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
