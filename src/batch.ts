/**
 * $batch transport for `batch_get` (Phase 2 D-28, FR-29..FR-31,
 * DS-P2-01/DS-P2-04).
 *
 * Contract enforced here:
 * - The multipart envelope is built EXCLUSIVELY by `odata-batch` 2.1.0's
 *   retrieve mode (`RetrieveCall[]`): direct `GET` parts, never `Call[]`,
 *   never changesets, never any library write surface (FR-31).
 * - `SsffBatchRepository` is a narrow adapter around that library: it
 *   validates the outbound envelope (fixed `${serviceRoot}$batch` URL,
 *   expected multipart media type/boundary, exactly N inner request lines,
 *   every line `GET ... HTTP/1.1`, no changeset delimiter, no absolute inner
 *   URLs) BEFORE dispatch, then performs the one fixed HTTPS POST with the
 *   existing auth policy (Basic or Bearer via the OAuth token manager).
 *   The adapter accepts only the controlled outer headers Authorization,
 *   Accept, Content-Type and User-Agent; model-supplied headers never reach
 *   the wire.
 * - The response is parsed by the library (`createBatchResponse`) with a
 *   parser subclass that keeps per-part failures per-item (tolerant JSON)
 *   and returns full raw bodies in xml mode.
 * - This POST is the only new data POST in the product (DS-P2-04); token
 *   POSTs stay in src/oauth.ts. No cross-host redirect is followed; OAuth
 *   401 invalidates the token and replays the whole batch exactly once
 *   (safe: every inner operation is a GET); Basic 401 never retries.
 */

import {
  createBatchResponse,
  ODataBatch,
  type BatchResponseConstructor,
  type BatchResponseParsed,
  type ODataBatchRepository,
  type RetrieveCall,
} from "odata-batch";
import { SanitizedError, redactUrls, sanitizeMessage } from "./errors.js";
import { getAuthorizationHeader, invalidateOAuthToken } from "./oauth.js";
import {
  defaultFetch,
  oauthCacheKey,
  hostOf,
  MAX_REDIRECT_HOPS,
  USER_AGENT,
  type EnvTarget,
  type FetchImpl,
} from "./http.js";

/** Same redirect semantics as dispatchGet, applied to the batch POST. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface BatchSendContext {
  env: EnvTarget;
  /** Expected number of embedded GET requests (validated against the body). */
  itemCount: number;
  /** Global representation of the call (D-32): shapes the inner Accept. */
  output: "json" | "xml";
  timeoutMs: number;
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Structural view of the runtime parser class odata-batch hands to the
 * repository. The package's public types only expose `response`; the runtime
 * class also carries `parseData`/`parseResponse`, which the subclasses below
 * override (verified against odata-batch@2.1.0 dist).
 */
interface BatchParserInstance {
  response: BatchResponseParsed[];
  parseData(sData: string): unknown;
  parseResponse(part: string): BatchResponseParsed;
}

type BatchParserClass = new (
  o: { data: string; headers: Record<string, string> },
  accept: string,
) => BatchParserInstance;

/**
 * Wrap the library's parser class for ssff-mcp's two response modes:
 * - json: tolerant embedded-body parse (an empty or non-JSON part body
 *   becomes `undefined` and surfaces as a sanitized per-item error instead
 *   of failing the whole envelope parse).
 * - xml: full raw bodies. The stock parser returns only the FIRST line for
 *   non-JSON accept and cuts the body at any embedded blank line; raw Atom
 *   bodies are required for `<entry>` counting and next-link extraction.
 * All multipart/status/header parsing stays in the library (FR-31).
 */
function buildSafeParser(
  BatchParser: BatchResponseConstructor,
  output: "json" | "xml",
): BatchResponseConstructor {
  const Base = BatchParser as BatchParserClass;
  if (output === "json") {
    return class extends Base {
      override parseData(sData: string): unknown {
        try {
          return JSON.parse(sData);
        } catch {
          return undefined;
        }
      }
    };
  }
  return class extends Base {
    override parseData(sData: string): string {
      return sData;
    }
    override parseResponse(part: string): BatchResponseParsed {
      const parsed = super.parseResponse(part);
      // Re-join body segments that were split on embedded blank lines.
      const pieces = part.split("\r\n\r\n");
      if (pieces.length > 2) {
        parsed.data = pieces.slice(2).join("\r\n\r\n");
      }
      return parsed;
    }
  };
}

/** Best-effort sanitized detail from an embedded (JSON or XML) error body. */
function embeddedErrorDetail(data: unknown): { code?: string; message?: string } {
  let text = "";
  let parsed: unknown = data;
  if (typeof data === "string") {
    text = data;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = undefined;
    }
  }
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
  if (text.trim().startsWith("<")) {
    const codeMatch = /<code[^>]*>([\s\S]*?)<\/code>/.exec(text);
    const messageMatch = /<message[^>]*>([\s\S]*?)<\/message>/.exec(text);
    if (codeMatch !== null || messageMatch !== null) {
      const decode = (value: string): string =>
        value
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, "&");
      return {
        code: codeMatch?.[1] !== undefined ? decode(codeMatch[1]) : undefined,
        message: messageMatch?.[1] !== undefined ? decode(messageMatch[1]) : undefined,
      };
    }
  }
  return {};
}

/** Sanitized per-item/outer failure payload: never echoes the raw body. */
export function sanitizeEmbeddedFailure(data: unknown, httpStatus: number | undefined): { code: string; message: string } {
  const detail = embeddedErrorDetail(data);
  const parts: string[] = [httpStatus === undefined ? "status unknown" : `status ${httpStatus}`];
  if (detail.code !== undefined && detail.code.length > 0) {
    parts.push(detail.code);
  }
  if (detail.message !== undefined && detail.message.length > 0) {
    parts.push(redactUrls(detail.message));
  }
  return { code: "HTTP_ERROR", message: sanitizeMessage(parts.join(": ")) };
}

const XML_INNER_ACCEPT = "Accept: application/xml";
const ATOM_INNER_ACCEPT = "Accept: application/atom+xml";

/**
 * Validate the library-built envelope before dispatch and, for xml output,
 * rewrite the per-part Accept to Atom. The library's retrieve mode can only
 * emit `Accept: application/xml` on embedded requests (individualResponseType
 * non-json), but SuccessFactors entity data answers 406 to `application/xml`
 * (that media type is only valid for `$metadata`); the raw-xml contract of
 * D-32 requires `application/atom+xml`. The rewrite replaces that exact
 * per-part line; the envelope structure stays 100% library-built.
 */
function validateAndPrepareEnvelope(body: string, boundary: string, itemCount: number, output: "json" | "xml"): string {
  if (!body.startsWith(`--${boundary}\r\n`) || !body.endsWith(`--${boundary}--`)) {
    throw new SanitizedError("BATCH_INVALID", "batch envelope delimiters are malformed");
  }

  let prepared = body;
  if (output === "xml") {
    const needle = `${XML_INNER_ACCEPT}\r\n`;
    const occurrences = body.split(needle).length - 1;
    if (occurrences !== itemCount) {
      throw new SanitizedError("BATCH_INVALID", "batch envelope part headers are invalid");
    }
    prepared = body.split(needle).join(`${ATOM_INNER_ACCEPT}\r\n`);
  }

  const requestLinePattern = /^([A-Za-z]+) (\S+) HTTP\/1\.[01]$/;
  let getRequestCount = 0;
  for (const line of prepared.split("\r\n")) {
    if (/changeset/i.test(line)) {
      throw new SanitizedError("BATCH_INVALID", "batch envelope must not contain changesets");
    }
    const requestLine = requestLinePattern.exec(line);
    if (requestLine === null) {
      continue;
    }
    if (requestLine[1] !== "GET") {
      throw new SanitizedError("BATCH_INVALID", "batch envelope must contain GET requests only");
    }
    const innerUrl = requestLine[2]!;
    if (innerUrl.startsWith("/") || /^https?:/i.test(innerUrl)) {
      throw new SanitizedError("BATCH_INVALID", "batch envelope inner requests must be relative to the service root");
    }
    getRequestCount += 1;
  }
  if (getRequestCount !== itemCount) {
    throw new SanitizedError("BATCH_INVALID", "batch envelope request count does not match the batch items");
  }
  return prepared;
}

/** Narrow odata-batch transport adapter (the only network path for $batch). */
export class SsffBatchRepository implements ODataBatchRepository {
  private readonly context: BatchSendContext;

  constructor(context: BatchSendContext) {
    this.context = context;
  }

  async send(
    url: string,
    batchRequest: string,
    config: { headers: Record<string, string> },
    accept: string,
    BatchParser: BatchResponseConstructor,
  ): Promise<BatchResponseParsed[]> {
    // Fixed destination (DS-P2-04): nothing but the environment's $batch.
    const expectedUrl = `${this.context.env.serviceRoot}$batch`;
    if (url !== expectedUrl) {
      throw new SanitizedError("BATCH_INVALID", "batch target URL is not the fixed $batch endpoint");
    }

    const contentType = config.headers["Content-Type"] ?? "";
    const boundaryMatch = /^multipart\/mixed; boundary=(batch_[A-Za-z0-9_-]+)$/.exec(contentType);
    if (boundaryMatch === null) {
      throw new SanitizedError("BATCH_INVALID", "batch content type or boundary is invalid");
    }
    const boundary = boundaryMatch[1]!;

    const body = validateAndPrepareEnvelope(batchRequest, boundary, this.context.itemCount, this.context.output);

    const fetchImpl = this.context.fetchImpl ?? defaultFetch;
    let current = new URL(url);
    let hops = 0;
    let authRetried = false;

    for (;;) {
      // Defense in depth: every request must stay on the configured https host.
      if (current.protocol !== "https:" || hostOf(current) !== this.context.env.expectedHost) {
        throw new SanitizedError(
          "REDIRECT_BLOCKED",
          "redirect to a host different from the configured environment host was blocked",
        );
      }

      const authorization = await this.buildAuthorization();
      // Controlled header set: nothing from the model, nothing extra, ever.
      const headers: Record<string, string> = {
        Authorization: authorization,
        Accept: "multipart/mixed",
        "Content-Type": contentType,
        "User-Agent": USER_AGENT,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.context.timeoutMs);
      let response;
      try {
        response = await fetchImpl(current.toString(), {
          method: "POST",
          headers,
          redirect: "manual",
          body,
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new SanitizedError("TIMEOUT", "request to the configured environment timed out");
        }
        throw new SanitizedError("NETWORK_ERROR", "request to the configured environment failed");
      } finally {
        clearTimeout(timer);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (location === null || location.length === 0) {
          throw await this.outerHttpError(response, "missing redirect location");
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
        if (hostOf(next) !== this.context.env.expectedHost) {
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

      // OAuth 401 recovery (mirrors dispatchGet): drop the cached token and
      // replay the whole batch exactly once — safe, every inner op is a GET.
      // Basic environments never retry (no error amplification).
      if (response.status === 401 && this.context.env.auth.kind === "oauth" && !authRetried) {
        invalidateOAuthToken(oauthCacheKey(this.context.env));
        authRetried = true;
        continue;
      }

      if (!(response.status >= 200 && response.status <= 299)) {
        throw await this.outerHttpError(response);
      }

      const responseText = await response.text();
      const responseContentType = response.headers.get("content-type") ?? "";
      try {
        const Parser = buildSafeParser(BatchParser, this.context.output);
        return createBatchResponse(
          Parser,
          { data: responseText, headers: { "content-type": responseContentType } },
          accept,
        ).response;
      } catch {
        throw new SanitizedError("RESPONSE_INVALID", "the batch response could not be parsed");
      }
    }
  }

  private async buildAuthorization(): Promise<string> {
    const auth = this.context.env.auth;
    if (auth.kind === "basic") {
      return "Basic " + Buffer.from(`${auth.username}:${auth.password}`, "utf-8").toString("base64");
    }
    return await getAuthorizationHeader(oauthCacheKey(this.context.env), auth.config, {
      fetchImpl: this.context.fetchImpl,
      now: this.context.now,
      sleep: this.context.sleep,
    });
  }

  /** Sanitized error for the OUTER batch POST (status + best-effort detail). */
  private async outerHttpError(response: { status: number; text(): Promise<string> }, extraReason?: string): Promise<SanitizedError> {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // Body is best-effort only.
    }
    const parts: string[] = [`status ${response.status}`];
    const detail = embeddedErrorDetail(body);
    if (detail.code !== undefined && detail.code.length > 0) {
      parts.push(detail.code);
    }
    if (detail.message !== undefined && detail.message.length > 0) {
      parts.push(redactUrls(detail.message));
    } else if (extraReason !== undefined) {
      parts.push(extraReason);
    }
    return new SanitizedError("HTTP_ERROR", sanitizeMessage(parts.join(": ")), response.status);
  }
}

export interface ExecuteBatchOptions {
  env: EnvTarget;
  output: "json" | "xml";
  timeoutMs: number;
  /** Pre-validated relative URLs (path + query), one per item, in order. */
  requests: RetrieveCall[];
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the GET-only envelope with odata-batch's retrieve mode and dispatch
 * it as the single fixed $batch POST. Returns one parsed response per item,
 * in input order.
 *
 * Inner request targets are embedded EXACTLY as `buildQuery` produced them;
 * there is deliberately no URL rewriting here. The contract, measured live
 * against a SuccessFactors tenant (odd/tasks/odata-query-fidelity.md, L12):
 *
 * - Percent-encoding in option VALUES is decoded once by SAP's batch parser,
 *   so `%20` for a space behaves identically to a direct GET. (A `+` for a
 *   space is NOT accepted there: the part answers 400.)
 * - Option NAMES are matched verbatim, with no decoding. A name that reaches
 *   the inner request line as `%24filter`/`%24top` is silently IGNORED: the
 *   part still answers 200 but runs the query unfiltered (1000 default rows
 *   instead of the filtered one). That is why `buildQuery` must emit every
 *   system option name with a literal `$`, and why this layer must never
 *   re-encode the target.
 *
 * A blanket `%24` -> `$` rewrite of the whole URL (the previous workaround for
 * `URLSearchParams` output) is no longer needed and would be harmful: it also
 * mutates a literal `%24` that a caller placed inside an option value.
 */
export async function executeBatchGet(options: ExecuteBatchOptions): Promise<BatchResponseParsed[]> {
  const repository = new SsffBatchRepository({
    env: options.env,
    itemCount: options.requests.length,
    output: options.output,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    now: options.now,
    sleep: options.sleep,
  });
  // `auth` is unused by the adapter (headers.Authorization fallback never
  // fires because the adapter builds its own Authorization per attempt);
  // the auth policy stays in ssff-mcp's transport, never in the library.
  const batch = new ODataBatch(
    {
      url: `${options.env.serviceRoot}$batch`,
      auth: "",
      retrieve: options.requests.map((call) => ({ url: call.url })),
      batchResponseType: options.output,
      individualResponseType: options.output,
    },
    repository,
  );
  const responses = await batch.send();
  if (responses.length !== options.requests.length) {
    throw new SanitizedError("RESPONSE_INVALID", "the batch response did not contain exactly one response per request");
  }
  return responses;
}
