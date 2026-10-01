import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuery,
  extractSkiptoken,
  extractXmlPaging,
  parseTotalCount,
  unwrapODataV2,
  validateEntityPath,
} from "../src/odata.js";
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

// --- inlinecount / skiptoken query assembly (FR-25 / FR-26) --------------------

test("buildQuery maps inlinecount and skiptoken to their OData options", () => {
  const built = buildQuery("User", { inlinecount: "allpages", skiptoken: "tok-1000-2000" });
  const query = new URL(built.pathAndQuery, "https://x.example.com/odata/v2/").searchParams;
  assert.equal(query.get("$inlinecount"), "allpages");
  assert.equal(query.get("$skiptoken"), "tok-1000-2000");
});

test("buildQuery omits inlinecount and skiptoken when absent", () => {
  const built = buildQuery("User", {});
  assert.equal(built.pathAndQuery, "User");
});

test("skiptoken values with reserved characters are URL-encoded, not interpreted", () => {
  const raw = '{"startRow":1000,"endRow":2000}';
  const built = buildQuery("User", { skiptoken: raw });
  const query = new URL(built.pathAndQuery, "https://x.example.com/odata/v2/").searchParams;
  assert.equal(query.get("$skiptoken"), raw);
});

// --- __count / totalCount (FR-26) ----------------------------------------------

test("unwrapODataV2 returns totalCount from d.__count as string or number", () => {
  assert.equal(unwrapODataV2({ d: { results: [], __count: "96577" } }).totalCount, 96577);
  assert.equal(unwrapODataV2({ d: { results: [], __count: 42 } }).totalCount, 42);
});

test("unusable __count values yield a null totalCount (omitted by callers)", () => {
  assert.equal(unwrapODataV2({ d: { results: [], __count: "abc" } }).totalCount, null);
  assert.equal(unwrapODataV2({ d: { results: [], __count: -1 } }).totalCount, null);
  assert.equal(unwrapODataV2({ d: { results: [], __count: 1.5 } }).totalCount, null);
  assert.equal(unwrapODataV2({ d: { results: [] } }).totalCount, null);
});

test("parseTotalCount accepts only finite integers >= 0", () => {
  assert.equal(parseTotalCount("0"), 0);
  assert.equal(parseTotalCount(0), 0);
  assert.equal(parseTotalCount(null), null);
  assert.equal(parseTotalCount(undefined), null);
  assert.equal(parseTotalCount(" 12 "), 12);
  assert.equal(parseTotalCount("1e3"), null);
});

// --- __next / nextUrl (FR-25) ---------------------------------------------------

test("unwrapODataV2 exposes the raw __next internally as nextUrl", () => {
  const next = "https://tenant.example.com/odata/v2/User?$skiptoken=tok-1";
  const unwrapped = unwrapODataV2({ d: { results: [], __next: next } });
  assert.equal(unwrapped.hasMore, true);
  assert.equal(unwrapped.nextUrl, next);
});

test("feed without __next has nextUrl null", () => {
  const unwrapped = unwrapODataV2({ d: { results: [] } });
  assert.equal(unwrapped.nextUrl, null);
  assert.equal(unwrapped.hasMore, false);
});

// --- extractSkiptoken ------------------------------------------------------------

test("extractSkiptoken reads $skiptoken from an absolute next URL", () => {
  assert.equal(
    extractSkiptoken("https://tenant.example.com/odata/v2/User?$skiptoken=tok-1000-2000"),
    "tok-1000-2000",
  );
});

test("extractSkiptoken decodes URL-encoded tokens", () => {
  const encoded = encodeURIComponent('{"startRow":1000,"endRow":2000}');
  assert.equal(
    extractSkiptoken(`https://tenant.example.com/odata/v2/User?$skiptoken=${encoded}`),
    '{"startRow":1000,"endRow":2000}',
  );
});

test("extractSkiptoken supports root-relative next URLs", () => {
  assert.equal(extractSkiptoken("/odata/v2/User?$skiptoken=rel-tok"), "rel-tok");
});

test("extractSkiptoken returns null when no $skiptoken is present", () => {
  assert.equal(extractSkiptoken("https://tenant.example.com/odata/v2/User?$skip=1000"), null);
  assert.equal(extractSkiptoken("https://tenant.example.com/odata/v2/User"), null);
});

test("extractSkiptoken returns null for malformed URLs", () => {
  assert.equal(extractSkiptoken(":::: not a url"), null);
  assert.equal(extractSkiptoken(""), null);
  assert.equal(extractSkiptoken("https://tenant.example.com/odata/v2/User?$skiptoken="), null);
});

// --- extractXmlPaging (FR-27) ------------------------------------------------------

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
  <title type="text">User</title>
  <m:count>96577</m:count>
  <entry><id>https://tenant.example.com/odata/v2/User('u1')</id></entry>
  <entry><id>https://tenant.example.com/odata/v2/User('u2')</id></entry>
  <link rel="next" href="https://tenant.example.com/odata/v2/User?$skiptoken=xml-tok-1"/>
</feed>
`;

test("extractXmlPaging reads next link, m:count and entry count", () => {
  const paging = extractXmlPaging(ATOM_FEED);
  assert.equal(paging.hasMore, true);
  assert.equal(paging.nextUrl, "https://tenant.example.com/odata/v2/User?$skiptoken=xml-tok-1");
  assert.equal(paging.totalCount, 96577);
  assert.equal(paging.entryCount, 2);
});

test("extractXmlPaging without next link or count reports no continuation", () => {
  const paging = extractXmlPaging(`<feed><entry><id>x</id></entry></feed>`);
  assert.equal(paging.hasMore, false);
  assert.equal(paging.nextUrl, null);
  assert.equal(paging.totalCount, null);
  assert.equal(paging.entryCount, 1);
});

test("extractXmlPaging decodes XML entities in the href", () => {
  const xml = `<feed><link rel="next" href="https://t.example.com/User?$skiptoken=a&amp;$top=1000"/></feed>`;
  const paging = extractXmlPaging(xml);
  assert.equal(paging.nextUrl, "https://t.example.com/User?$skiptoken=a&$top=1000");
  assert.equal(extractSkiptoken(paging.nextUrl!), "a");
});

test("extractXmlPaging ignores link elements whose rel is not next", () => {
  const xml = `<feed><link rel="self" href="https://t.example.com/User"/><link rel="edit" href="https://t.example.com/User('1')"/></feed>`;
  assert.equal(extractXmlPaging(xml).hasMore, false);
});

test("extractXmlPaging entry counting uses the <entry element boundary", () => {
  // <entryish> must not count; <entry> and <entry attr> must.
  const xml = `<feed><entry></entry><entry xml:base="x"></entry><entryish/></feed>`;
  assert.equal(extractXmlPaging(xml).entryCount, 2);
});

test("extractXmlPaging rejects unusable m:count values as null totalCount", () => {
  assert.equal(extractXmlPaging(`<feed><m:count>abc</m:count></feed>`).totalCount, null);
});
