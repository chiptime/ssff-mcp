import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery, unwrapODataV2, validateEntityPath } from "../src/odata.js";
import { isSanitizedError } from "../src/errors.js";

function assertValidPath(path: string, expectedFirstSegment: string): void {
  const validated = validateEntityPath(path);
  assert.equal(validated.firstSegmentName, expectedFirstSegment);
}

function assertInvalidPath(path: string): void {
  assert.throws(() => validateEntityPath(path), (error: unknown) => {
    if (!isSanitizedError(error)) {
      return false;
    }
    assert.equal(error.code, "PATH_INVALID");
    return true;
  });
}

test("grammar errors never echo the submitted path (may contain business keys)", () => {
  const sensitive = "User('ceo@company-salary')";
  assert.throws(() => validateEntityPath(`${sensitive};drop`), (error: unknown) => {
    if (!isSanitizedError(error)) {
      return false;
    }
    assert.equal(error.code, "PATH_INVALID");
    assert.ok(!error.message.includes(sensitive));
    return true;
  });
});

test("valid entity paths", () => {
  assertValidPath("User", "User");
  assertValidPath("User('123')", "User");
  assertValidPath("User('It''s')", "User");
  assertValidPath("User(123)", "User");
  assertValidPath("User(-1.5)", "User");
  assertValidPath("Comp(key1='a',key2=1)/nav", "Comp");
  assertValidPath("Comp( key1 = 'a' , key2 = 1 )/nav", "Comp");
  assertValidPath("A/B('x')/C/D", "A");
  assertValidPath("User('a/b')/nav", "User");
  assertValidPath("foo_bar_1", "foo_bar_1");
  assertValidPath("_leading", "_leading");
});

test("invalid entity paths are rejected before dispatch", () => {
  assertInvalidPath("");
  assertInvalidPath("$batch");
  assertInvalidPath("$metadata");
  assertInvalidPath("$count");
  assertInvalidPath("$value");
  assertInvalidPath("$links");
  assertInvalidPath("User/$count");
  assertInvalidPath("User;drop");
  assertInvalidPath("User()x");
  assertInvalidPath("%20");
  assertInvalidPath("User\nx");
  assertInvalidPath("A/B/C/D/E");
  assertInvalidPath("User('123");
  assertInvalidPath("User(abc");
  assertInvalidPath("User)");
  assertInvalidPath("/User");
  assertInvalidPath("User/");
  assertInvalidPath("User x");
  assertInvalidPath("9User");
  assertInvalidPath("User(bad=xx)");
  assertInvalidPath(".".repeat(600));
});

test("path longer than 512 characters is rejected", () => {
  assertInvalidPath("User".padEnd(513, "a"));
});

test("buildQuery maps options to OData system query options", () => {
  const built = buildQuery("User", {
    filter: "userId eq 'x'",
    orderby: "userId desc",
    select: "userId,firstName",
    expand: "foo",
    top: 10,
    skip: 20,
  });
  const query = new URL(built.pathAndQuery, "https://x.example.com/odata/v2/").searchParams;
  assert.equal(query.get("$filter"), "userId eq 'x'");
  assert.equal(query.get("$orderby"), "userId desc");
  assert.equal(query.get("$select"), "userId,firstName");
  assert.equal(query.get("$expand"), "foo");
  assert.equal(query.get("$top"), "10");
  assert.equal(query.get("$skip"), "20");
  assert.equal(built.topClamped, false);
});

test("buildQuery omits absent options and skip=0", () => {
  const built = buildQuery("User", { skip: 0 });
  assert.equal(built.pathAndQuery, "User");
});

test("buildQuery omits empty-string option values", () => {
  const built = buildQuery("User", { filter: "" });
  assert.equal(built.pathAndQuery, "User");
});

test("top above the ceiling is clamped to 1000 and flagged", () => {
  const built = buildQuery("User", { top: 5000 });
  assert.equal(built.topClamped, true);
  const query = new URL(built.pathAndQuery, "https://x.example.com/odata/v2/").searchParams;
  assert.equal(query.get("$top"), "1000");
});

test("top of exactly 1000 is not flagged", () => {
  const built = buildQuery("User", { top: 1000 });
  assert.equal(built.topClamped, false);
});

test("top must be an integer >= 1", () => {
  assert.throws(() => buildQuery("User", { top: 0 }), optionInvalid());
  assert.throws(() => buildQuery("User", { top: -5 }), optionInvalid());
});

test("skip must be between 0 and 1000000 inclusive", () => {
  assert.throws(() => buildQuery("User", { skip: -1 }), optionInvalid());
  assert.throws(() => buildQuery("User", { skip: 1_000_001 }), optionInvalid());
  buildQuery("User", { skip: 1_000_000 });
});

function optionInvalid(): (error: unknown) => boolean {
  return (error: unknown) => {
    if (!isSanitizedError(error)) {
      return false;
    }
    assert.equal(error.code, "OPTION_INVALID");
    return true;
  };
}

test("feed responses unwrap d.results and report __next as hasMore only", () => {
  const record = { userId: "u1", __metadata: { uri: "https://tenant/odata/v2/User('u1')", type: "SFOData.User" } };
  const unwrapped = unwrapODataV2({ d: { results: [record], __next: "https://tenant/odata/v2/User?$skip=1" } });
  assert.equal(unwrapped.records.length, 1);
  assert.equal(unwrapped.hasMore, true);
  assert.equal(unwrapped.truncatedToCeiling, false);
  // Records are verbatim: __metadata preserved, no normalization.
  assert.deepEqual(unwrapped.records[0], record);
});

test("feed without __next has hasMore false", () => {
  const unwrapped = unwrapODataV2({ d: { results: [] } });
  assert.equal(unwrapped.hasMore, false);
  assert.equal(unwrapped.records.length, 0);
});

test("single entity responses unwrap d as a one-element records array", () => {
  const unwrapped = unwrapODataV2({ d: { userId: "u1", firstName: "Ada" } });
  assert.equal(unwrapped.records.length, 1);
  assert.deepEqual(unwrapped.records[0], { userId: "u1", firstName: "Ada" });
  assert.equal(unwrapped.hasMore, false);
});

test("a page larger than 1000 records is truncated to the ceiling", () => {
  const records = Array.from({ length: 1500 }, (_, i) => ({ userId: String(i) }));
  const unwrapped = unwrapODataV2({ d: { results: records } });
  assert.equal(unwrapped.records.length, 1000);
  assert.equal(unwrapped.truncatedToCeiling, true);
});

test("non-OData-v2 bodies are rejected as RESPONSE_INVALID", () => {
  assert.throws(() => unwrapODataV2({ foo: 1 }), responseInvalid());
  assert.throws(() => unwrapODataV2("string"), responseInvalid());
  assert.throws(() => unwrapODataV2(null), responseInvalid());
});

function responseInvalid(): (error: unknown) => boolean {
  return (error: unknown) => {
    if (!isSanitizedError(error)) {
      return false;
    }
    assert.equal(error.code, "RESPONSE_INVALID");
    return true;
  };
}
