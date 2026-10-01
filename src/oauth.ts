/**
 * OAuth 2.0 token acquisition for SAP SuccessFactors (FR-32/FR-33,
 * PRD-phase2.md): two-step SAML 2.0 Bearer flow via SAP's IdP helper.
 *
 *   Step 1: POST {idpUrl}  {client_id, user_id, token_url, private_key}
 *           -> base64 SAML assertion (signed by SAP; no local XML crypto).
 *   Step 2: POST {tokenUrl} {client_id, grant_type=saml2-bearer,
 *            company_id, assertion} -> {access_token, expires_in}
 *
 * Security contract:
 * - These are the ONLY POSTs in the codebase besides none: data reads stay
 *   GET-only (DS-P2-04/05). Both endpoints are fixed per environment config
 *   and use TLS; no model input ever reaches this module's URLs.
 * - Errors are sanitized: never include client_id, company_id, user_id,
 *   private_key, assertion, or token values.
 * - Tokens live only in this process's memory (per environment alias),
 *   with a 60s/10% expiry safety margin, single-flight acquisition,
 *   a strict payload guard (SAP can answer 200 with an HTML error page),
 *   and up to 3 attempts with linear backoff.
 */

import { SanitizedError, redactUrls, sanitizeMessage } from "./errors.js";
import { USER_AGENT } from "./http.js";
import type { MinimalResponse } from "./http.js";
import type { OAuthAuthConfig } from "./config.js";

export const SAML2_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:saml2-bearer";

const MAX_ATTEMPTS = 3;
const SAFETY_BUFFER_MIN_MS = 60_000;
const OAUTH_POST_TIMEOUT_MS = 30_000;

export interface OAuthPostInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type OAuthFetch = (url: string, init: OAuthPostInit) => Promise<MinimalResponse>;

export interface OAuthRuntimeOptions {
  fetchImpl?: OAuthFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CachedToken {
  accessToken: string;
  obtainedAtMs: number;
  expiresInSeconds: number;
}

interface EnvTokenState {
  token: CachedToken | null;
  inflight: Promise<string> | null;
}

/** Process-lifetime token state, keyed by environment alias. */
const states = new Map<string, EnvTokenState>();

function stateFor(alias: string): EnvTokenState {
  let state = states.get(alias);
  if (state === undefined) {
    state = { token: null, inflight: null };
    states.set(alias, state);
  }
  return state;
}

/** Drop the cached token for an environment (used after a 401 on a data read). */
export function invalidateOAuthToken(alias: string): void {
  stateFor(alias).token = null;
}

function isFresh(token: CachedToken, nowMs: number): boolean {
  const safetyMs = Math.min(SAFETY_BUFFER_MIN_MS, (token.expiresInSeconds * 1000) / 10);
  return token.obtainedAtMs + token.expiresInSeconds * 1000 - safetyMs > nowMs;
}

/**
 * Returns `Authorization: Bearer <token>` for the environment, acquiring or
 * refreshing as needed. Concurrent callers share one in-flight acquisition.
 */
export async function getAuthorizationHeader(
  alias: string,
  config: OAuthAuthConfig,
  options: OAuthRuntimeOptions = {},
): Promise<string> {
  const state = stateFor(alias);
  const now = options.now ?? Date.now;
  if (state.token !== null && isFresh(state.token, now())) {
    return `Bearer ${state.token.accessToken}`;
  }
  if (state.inflight !== null) {
    return await state.inflight;
  }
  const pending = acquireBearerToken(config, options)
    .then((accessToken) => {
      state.token = {
        accessToken,
        obtainedAtMs: (options.now ?? Date.now)(),
        expiresInSeconds: lastExpiresInSeconds,
      };
      return `Bearer ${accessToken}`;
    })
    .finally(() => {
      state.inflight = null;
    });
  state.inflight = pending;
  return await pending;
}

/** Set by acquireBearerToken so the cache builder can read the observed expiry. */
let lastExpiresInSeconds = 0;

async function acquireBearerToken(config: OAuthAuthConfig, options: OAuthRuntimeOptions): Promise<string> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const assertion = await requestAssertion(config, options);
      const { accessToken, expiresInSeconds } = await requestToken(config, assertion, options);
      lastExpiresInSeconds = expiresInSeconds;
      return accessToken;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 500);
      }
    }
  }
  throw lastError;
}

async function postForm(
  url: string,
  accept: string,
  form: Record<string, string>,
  options: OAuthRuntimeOptions,
): Promise<MinimalResponse> {
  const fetchImpl = options.fetchImpl ?? ((u, init) => fetch(u, init as never) as Promise<MinimalResponse>);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_POST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: accept,
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new SanitizedError("TIMEOUT", "oauth request to the configured environment timed out");
    }
    throw new SanitizedError("OAUTH_TOKEN_ERROR", "oauth request to the configured environment failed");
  } finally {
    clearTimeout(timer);
  }
}

/** Extract error detail from an OAuth JSON error body (RFC 6749 shape or SAP's
 * `errorHttpCode`/`errorMessage` shape), sanitized. */
function oauthErrorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const e = parsed as { error?: unknown; error_description?: unknown; errorMessage?: unknown };
      const parts: string[] = [];
      if (typeof e.error === "string" && e.error.length > 0) parts.push(e.error);
      if (typeof e.error_description === "string" && e.error_description.length > 0) {
        parts.push(redactUrls(e.error_description));
      }
      // SAP /oauth endpoints answer with {"errorHttpCode": "...", "errorMessage": "..."}.
      if (typeof e.errorMessage === "string" && e.errorMessage.length > 0) {
        parts.push(redactUrls(e.errorMessage));
      }
      if (parts.length > 0) return sanitizeMessage(parts.join(": "), 300);
    }
  } catch {
    // Not JSON: nothing safe to surface.
  }
  return "";
}

async function requestAssertion(config: OAuthAuthConfig, options: OAuthRuntimeOptions): Promise<string> {
  const response = await postForm(
    config.idpUrl,
    "text/plain",
    {
      client_id: config.clientId,
      user_id: config.userId,
      // Must equal tokenUrl EXACTLY: SAP embeds it in the AudienceRestriction.
      token_url: config.tokenUrl,
      private_key: config.privateKey,
    },
    options,
  );
  const body = await response.text().catch(() => "");
  if (!(response.status >= 200 && response.status <= 299)) {
    const detail = oauthErrorDetail(body);
    throw new SanitizedError(
      "OAUTH_ASSERTION_ERROR",
      `assertion endpoint returned status ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  const trimmed = body.trim();
  // Guard against SAP's 200-with-HTML-error behavior: a real assertion is a
  // single non-empty base64 payload, never markup.
  if (trimmed.length < 50 || trimmed.startsWith("<") || /\s/.test(trimmed)) {
    throw new SanitizedError("OAUTH_ASSERTION_ERROR", "assertion endpoint returned an unexpected body");
  }
  return trimmed;
}

interface TokenPayload {
  accessToken: string;
  expiresInSeconds: number;
}

async function requestToken(
  config: OAuthAuthConfig,
  assertion: string,
  options: OAuthRuntimeOptions,
): Promise<TokenPayload> {
  const response = await postForm(
    config.tokenUrl,
    "application/json",
    {
      client_id: config.clientId,
      grant_type: SAML2_BEARER_GRANT,
      company_id: config.companyId,
      assertion,
    },
    options,
  );
  const body = await response.text().catch(() => "");
  if (!(response.status >= 200 && response.status <= 299)) {
    const detail = oauthErrorDetail(body);
    throw new SanitizedError(
      "OAUTH_TOKEN_ERROR",
      `token endpoint returned status ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SanitizedError("OAUTH_TOKEN_ERROR", "token endpoint returned a non-JSON body");
  }
  const candidate = parsed as { access_token?: unknown; expires_in?: unknown };
  const accessToken = candidate.access_token;
  const expiresIn = candidate.expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new SanitizedError("OAUTH_TOKEN_ERROR", "token endpoint returned an invalid payload");
  }
  return { accessToken, expiresInSeconds: expiresIn };
}

/** Test-only: reset all cached token state (module-level singletons). */
export function resetOAuthStateForTests(): void {
  states.clear();
  lastExpiresInSeconds = 0;
}
