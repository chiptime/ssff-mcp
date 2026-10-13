import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  CURSOR_VERSION,
  MAX_CURSOR_TOKEN_LENGTH,
  createCursorCodec,
  defaultCursorCodec,
  stableStringify,
  type CursorBinding,
  type CursorPayload,
} from "../src/cursor.js";
import { isSanitizedError } from "../src/errors.js";

const SECRET_A = Buffer.alloc(32, 0x01);
const SECRET_B = Buffer.alloc(32, 0x02);
const SKIPTOKEN = "opaque-service-token-1000-2000";

function samplePayload(): CursorPayload {
  return {
    v: CURSOR_VERSION,
    env: "tenant-a",
    path: "User",
    options: { filter: "userId eq 'u1'", top: 100, inlinecount: "allpages" },
    skiptoken: SKIPTOKEN,
  };
}

function sampleBinding(): CursorBinding {
  return {
    env: "tenant-a",
    path: "User",
    options: { filter: "userId eq 'u1'", top: 100, inlinecount: "allpages" },
  };
}

function assertCursorInvalid(fn: () => unknown, token?: string): { message: string } {
  assert.throws(fn, (error: unknown) => {
    if (!isSanitizedError(error)) {
      return false;
    }
    assert.equal(error.code, "CURSOR_INVALID");
    return true;
  });
  // Second pass to capture the message without assert interference.
  try {
    fn();
  } catch (error) {
    assert.ok(isSanitizedError(error));
    if (token !== undefined && token.length > 0) {
      assert.ok(!error.message.includes(token), "error message must not echo the token");
    }
    assert.ok(!error.message.includes(SKIPTOKEN), "error message must not echo the skiptoken");
    return { message: error.message };
  }
  throw new Error("expected a CURSOR_INVALID error");
}

test("cursor round trip returns the original payload", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());
  const decoded = codec.decode(token, sampleBinding());
  assert.deepEqual(decoded, samplePayload());
});

test("cursor round trip is stable regardless of option key order", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const payload = samplePayload();
  // Same options, different key insertion order.
  const reorderedBinding: CursorBinding = {
    env: "tenant-a",
    path: "User",
    options: { inlinecount: "allpages", top: 100, filter: "userId eq 'u1'" },
  };
  const token = codec.encode(payload);
  assert.deepEqual(codec.decode(token, reorderedBinding), payload);
});

test("tampered payload (re-signed content change) is rejected", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());
  const [payloadPart, signaturePart] = token.split(".");

  // Forge a well-formed payload with a different skiptoken, keep the old signature.
  const payloadJson = Buffer.from(payloadPart!, "base64url").toString("utf8");
  const forged = JSON.parse(payloadJson) as CursorPayload;
  forged.skiptoken = "forged-token";
  const forgedPart = Buffer.from(JSON.stringify(forged), "utf8").toString("base64url");
  assertCursorInvalid(() => codec.decode(`${forgedPart}.${signaturePart}`, sampleBinding()), token);
});

test("tampered signature is rejected", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());
  const [payloadPart, signaturePart] = token.split(".");
  // Flip the last character of the signature (still valid base64url alphabet).
  const last = signaturePart!.slice(-1);
  const flipped = last === "A" ? "B" : "A";
  const tampered = `${payloadPart}.${signaturePart!.slice(0, -1)}${flipped}`;
  assert.notEqual(tampered, token);
  assertCursorInvalid(() => codec.decode(tampered, sampleBinding()), token);
});

test("a cursor signed by a different secret (simulated restart) is rejected", () => {
  const before = createCursorCodec({ secret: SECRET_A });
  const after = createCursorCodec({ secret: SECRET_B });
  const token = before.encode(samplePayload());
  assertCursorInvalid(() => after.decode(token, sampleBinding()), token);
});

test("binding mismatch on env is rejected", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());
  const binding = { ...sampleBinding(), env: "tenant-b" };
  assertCursorInvalid(() => codec.decode(token, binding), token);
});

test("binding mismatch on path is rejected", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());
  const binding = { ...sampleBinding(), path: "Position" };
  assertCursorInvalid(() => codec.decode(token, binding), token);
});

test("binding mismatch on options is rejected", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());

  const changedFilter: CursorBinding = {
    ...sampleBinding(),
    options: { ...sampleBinding().options, filter: "userId eq 'OTHER'" },
  };
  assertCursorInvalid(() => codec.decode(token, changedFilter), token);

  const removedTop: CursorBinding = {
    env: "tenant-a",
    path: "User",
    options: { filter: "userId eq 'u1'", inlinecount: "allpages" },
  };
  assertCursorInvalid(() => codec.decode(token, removedTop), token);
});

test("skip is not part of the binding", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());
  // The binding never carries skip; adding it cannot cause a mismatch.
  const binding: CursorBinding = {
    env: "tenant-a",
    path: "User",
    options: { filter: "userId eq 'u1'", top: 100, inlinecount: "allpages" },
  };
  assert.deepEqual(codec.decode(token, binding), samplePayload());
});

test("oversized token (> 4096 chars, correctly signed) is rejected", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const payload: CursorPayload = {
    ...samplePayload(),
    skiptoken: "x".repeat(MAX_CURSOR_TOKEN_LENGTH),
  };
  const token = codec.encode(payload);
  assert.ok(token.length > MAX_CURSOR_TOKEN_LENGTH);
  assertCursorInvalid(() => codec.decode(token, sampleBinding()), token);
});

test("unknown cursor version is rejected even with a valid signature", () => {
  // Hand-craft a v2 payload correctly signed with the known secret.
  const payload = { ...samplePayload(), v: 2 };
  const payloadJson = stableStringify(payload);
  const signature = createHmac("sha256", SECRET_A).update(payloadJson, "utf8").digest("base64url");
  const token = `${Buffer.from(payloadJson, "utf8").toString("base64url")}.${signature}`;
  assertCursorInvalid(() => createCursorCodec({ secret: SECRET_A }).decode(token, sampleBinding()), token);
});

test("malformed tokens are rejected (no dot, extra dots, bad base64url, empty)", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const cases = [
    "",
    "not-a-cursor",
    "onlyonepart",
    "a.b.c",
    "!!!.???",
    ".",
    `${Buffer.from("{}", "utf8").toString("base64url")}.`,
  ];
  for (const token of cases) {
    assertCursorInvalid(() => codec.decode(token, sampleBinding()), token);
  }
});

test("cursor error messages never contain the token or the skiptoken", () => {
  const codec = createCursorCodec({ secret: SECRET_A });
  const token = codec.encode(samplePayload());
  const failures: Array<() => unknown> = [
    () => codec.decode(`${token.slice(0, -2)}xx`, sampleBinding()),
    () => codec.decode(token, { ...sampleBinding(), env: "other" }),
    () => createCursorCodec({ secret: SECRET_B }).decode(token, sampleBinding()),
    () => codec.decode("t".repeat(MAX_CURSOR_TOKEN_LENGTH + 1), sampleBinding()),
  ];
  for (const failure of failures) {
    const { message } = assertCursorInvalid(failure, token);
    assert.ok(message.length > 0);
    assert.ok(!message.includes(SKIPTOKEN));
    assert.ok(!message.includes("tenant-a/User"));
  }
});

test("the module default codec exists and round trips (per-process secret)", () => {
  const token = defaultCursorCodec.encode(samplePayload());
  assert.deepEqual(defaultCursorCodec.decode(token, sampleBinding()), samplePayload());
  // Two codecs with generated secrets never accept each other's tokens.
  const other = createCursorCodec();
  assert.throws(() => other.decode(token, sampleBinding()), (error: unknown) => {
    assert.ok(isSanitizedError(error));
    assert.equal(error.code, "CURSOR_INVALID");
    return true;
  });
});

test("FR-44: cursor token survives CRLF line endings when trimmed from STDIO input", () => {
  const token = defaultCursorCodec.encode(samplePayload());
  // Windows STDIO line endings or JSON input with trailing \r\n:
  const withCrlf = `${token}\r\n`;
  const trimmed = withCrlf.trim();
  assert.deepEqual(defaultCursorCodec.decode(trimmed, sampleBinding()), samplePayload());
});

