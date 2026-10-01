/**
 * Sanitized error type and redaction helpers.
 *
 * Everything returned to the model is `{ code, message }` (+ optional
 * `httpStatus`). Messages must never contain secrets, tokens, tenant URLs or
 * hosts. Never echo raw path/query values or service error bodies verbatim.
 */

export type SanitizedErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "ENVIRONMENT_REQUIRED"
  | "ENVIRONMENT_UNKNOWN"
  | "PATH_INVALID"
  | "OPTION_INVALID"
  | "CURSOR_INVALID"
  | "FUNCTION_IMPORT_UNSUPPORTED"
  | "METADATA_UNAVAILABLE"
  | "REDIRECT_BLOCKED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "RESPONSE_INVALID"
  | "OAUTH_ASSERTION_ERROR"
  | "OAUTH_TOKEN_ERROR"
  | "INTERNAL_ERROR";

export class SanitizedError extends Error {
  readonly code: SanitizedErrorCode;
  readonly httpStatus?: number;

  constructor(code: SanitizedErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "SanitizedError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isSanitizedError(value: unknown): value is SanitizedError {
  return value instanceof SanitizedError;
}

/** Replace any URL-looking substring with a placeholder (defense against host/tenant leaks). */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[redacted-url]");
}

/** Collapse whitespace and clamp length so service-provided text stays bounded. */
export function sanitizeMessage(text: string, maxLength = 500): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return collapsed.slice(0, maxLength - 3) + "...";
}

/** Normalize any thrown value into a SanitizedError without leaking details. */
export function toSanitizedError(value: unknown): SanitizedError {
  if (isSanitizedError(value)) {
    return value;
  }
  // Deliberately generic: internal error details (stacks, Node fetch errors,
  // file paths) must not reach the model.
  return new SanitizedError("INTERNAL_ERROR", "an unexpected internal error occurred");
}
