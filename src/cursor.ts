/**
 * Opaque stateless continuation cursor (Phase 2 D-27 / FR-25, PRD C.2).
 *
 * The cursor wraps the service-provided `$skiptoken` in a signed envelope:
 *
 *   token = base64url(payloadJson) + "." + base64url(HMAC-SHA256(secret, payloadJson))
 *   payload = { v: 1, env, path, options, skiptoken }
 *
 * - The HMAC secret is ephemeral process memory (random per run, never
 *   persisted): a cursor issued before a restart is rejected afterwards.
 * - The payload is bound to { environment alias, entity path, canonical query
 *   options }; any mismatch with the CURRENT call is rejected pre-dispatch.
 * - No clock-based TTL, no storage of any kind (D-27).
 * - Failures are sanitized CURSOR_INVALID errors that never echo the token,
 *   the payload or the skiptoken.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SanitizedError } from "./errors.js";

export const CURSOR_VERSION = 1;
/** Maximum accepted cursor token length (characters). */
export const MAX_CURSOR_TOKEN_LENGTH = 4096;

export interface CursorPayload {
  v: typeof CURSOR_VERSION;
  env: string;
  path: string;
  /** Canonical query options object (stable-key-sorted on serialization). */
  options: Record<string, unknown>;
  skiptoken: string;
}

/** The call-side binding a cursor must match to be accepted. */
export interface CursorBinding {
  env: string;
  path: string;
  options: Record<string, unknown>;
}

export interface CursorCodec {
  encode(payload: CursorPayload): string;
  decode(token: string, expectedBinding: CursorBinding): CursorPayload;
}

function cursorInvalid(message = "cursor is invalid"): SanitizedError {
  return new SanitizedError("CURSOR_INVALID", message);
}

/** Deterministic JSON serialization: object keys sorted at every level. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Strict base64url decode: returns null for any non-alphabet input. */
function base64UrlDecode(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  return Buffer.from(text, "base64url");
}

export function createCursorCodec(config: { secret?: Buffer } = {}): CursorCodec {
  // Default secret: 32 random bytes generated once per codec (per process for
  // the module-level default codec). Never written anywhere.
  const secret = config.secret ?? randomBytes(32);

  function sign(payloadJson: string): Buffer {
    return createHmac("sha256", secret).update(payloadJson, "utf8").digest();
  }

  return {
    encode(payload: CursorPayload): string {
      const payloadJson = stableStringify({ ...payload, v: CURSOR_VERSION });
      const payloadBytes = Buffer.from(payloadJson, "utf8");
      return `${payloadBytes.toString("base64url")}.${sign(payloadJson).toString("base64url")}`;
    },

    decode(token: string, expectedBinding: CursorBinding): CursorPayload {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_CURSOR_TOKEN_LENGTH) {
        throw cursorInvalid();
      }
      const parts = token.split(".");
      if (parts.length !== 2) {
        throw cursorInvalid();
      }
      const payloadBytes = base64UrlDecode(parts[0]!);
      const signature = base64UrlDecode(parts[1]!);
      if (payloadBytes === null || signature === null || payloadBytes.length === 0 || signature.length === 0) {
        throw cursorInvalid();
      }

      const expectedSignature = sign(payloadBytes.toString("utf8"));
      if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
        throw cursorInvalid();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadBytes.toString("utf8"));
      } catch {
        throw cursorInvalid();
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw cursorInvalid();
      }
      const record = parsed as Record<string, unknown>;
      if (record.v !== CURSOR_VERSION) {
        throw cursorInvalid();
      }
      if (
        typeof record.env !== "string" ||
        typeof record.path !== "string" ||
        typeof record.options !== "object" ||
        record.options === null ||
        Array.isArray(record.options) ||
        typeof record.skiptoken !== "string" ||
        record.skiptoken.length === 0
      ) {
        throw cursorInvalid();
      }
      const payloadOptions = record.options as Record<string, unknown>;

      // Binding check against the CURRENT call: same environment, same entity
      // path, same canonical options. Generic error; nothing is echoed.
      if (
        record.env !== expectedBinding.env ||
        record.path !== expectedBinding.path ||
        stableStringify(record.options) !== stableStringify(expectedBinding.options)
      ) {
        throw cursorInvalid("cursor does not match the current query");
      }

      return {
        v: CURSOR_VERSION,
        env: record.env,
        path: record.path,
        options: payloadOptions,
        skiptoken: record.skiptoken,
      };
    },
  };
}

/**
 * Process-default codec: the HMAC secret is generated once per process and
 * never persisted. Every cursor becomes invalid when the process restarts
 * (documented behavior, D-27 — not an error condition of the mechanism).
 */
export const defaultCursorCodec: CursorCodec = createCursorCodec();
