import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuery,
  extractSkiptoken,
  extractXmlPaging,
  parseTotalCount,
  sanitizeXmlNextLinks,
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

test("real tenant composite keys with typed literals validate (FR-79)", () => {
  assertValidPath(
    "PaymentInformationDetailV3(PaymentInformationV3_effectiveStartDate=datetime'2013-01-01T00:00:00',PaymentInformationV3_worker='1000001',externalCode=860259L)",
    "PaymentInformationDetailV3",
  );
  assertValidPath("EmpJob(seqNumber=1L,startDate=datetime'2013-01-01T00:00:00',userId='1000001')", "EmpJob");
});

test("typed prefixes validate in lower, upper and mixed case", () => {
  assertValidPath("E(k=datetime'2013-01-01T00:00:00')", "E");
  assertValidPath("E(k=DATETIME'2013-01-01T00:00:00')", "E");
  assertValidPath("E(k=datetimeoffset'2013-01-01T00:00:00Z')", "E");
  assertValidPath("E(k=DateTimeOffset'2013-01-01T00:00:00+01:00')", "E");
  assertValidPath("E(k=time'PT12H30M')", "E");
  assertValidPath("E(k=Time'PT12H30M')", "E");
  assertValidPath("E(k=guid'01234567-89ab-cdef-0123-456789abcdef')", "E");
  assertValidPath("E(k=Guid'01234567-89ab-cdef-0123-456789abcdef')", "E");
  assertValidPath("E(k=binary'0A0B')", "E");
  assertValidPath("E(k=X'0A0B')", "E");
  assertValidPath("E(k=x'0a0b')", "E");
  assertValidPath("E(k=decimal'1.5')", "E");
  assertValidPath("E(k=float'1.5')", "E");
  assertValidPath("E(k=Double'1.5')", "E");
});

test("typed literal bodies keep the doubled-quote rule and allow ':' and '-'", () => {
  assertValidPath("E(k=datetime'it''s:a-b')", "E");
  assertValidPath("E(datetime'2013-01-01T00:00:00')", "E");
  assertValidPath("E(k=datetime'2013-01-01T00:00:00')/nav", "E");
  assertValidPath("E(k=datetime'a/b')/nav", "E");
});

test("boolean and null literals validate in any case", () => {
  assertValidPath("E(k=true)", "E");
  assertValidPath("E(k=false)", "E");
  assertValidPath("E(k=null)", "E");
  assertValidPath("E(k=TRUE,j=False,i=NULL)", "E");
  assertValidPath("E(true)", "E");
});

test("numeric type suffixes validate, including negative and decimal values", () => {
  assertValidPath("E(k=1L)", "E");
  assertValidPath("E(k=-1L)", "E");
  assertValidPath("E(k=860259L)", "E");
  assertValidPath("E(k=1.5f)", "E");
  assertValidPath("E(k=1.5F)", "E");
  assertValidPath("E(k=2d)", "E");
  assertValidPath("E(k=2D)", "E");
  assertValidPath("E(k=3m)", "E");
  assertValidPath("E(k=3M)", "E");
  assertValidPath("E(k=3.25m)", "E");
});

test("malformed typed, boolean, null and numeric literals stay invalid", () => {
  assertInvalidPath("E(k=datetime)");
  assertInvalidPath("E(k=datetime2013)");
  assertInvalidPath("E(k=datetime'2013-01-01T00:00:00)");
  assertInvalidPath("E(k=unknown'x')");
  assertInvalidPath("E(k=truex)");
  assertInvalidPath("E(k=nullable)");
  assertInvalidPath("E(k=1Lx)");
  assertInvalidPath("E(k=1LL)");
  assertInvalidPath("E(k=1.L)");
  assertInvalidPath("E(k=L)");
  assertInvalidPath("E(k=1e5)");
});

test("negatives still reject after the grammar extension (FR-79)", () => {
  assertInvalidPath("$batch");
  assertInvalidPath("%20");
  assertInvalidPath("User('123");
  assertInvalidPath("User".padEnd(513, "a"));
  assertInvalidPath("User(bad=xx)");
  assertInvalidPath("User(abc");
  assertInvalidPath("User()x");
});

test("raw '%' outside a quoted literal stays PATH_INVALID", () => {
  assertInvalidPath("User%20x");
  assertInvalidPath("E(k=1%20)");
  assertInvalidPath("E(k=datetime%27x%27)");
  assertInvalidPath("E(k=true%20)");
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

// --- raw query assembly: %20 spaces, literal reserved chars (FR-77 / FR-78 / FR-80) ---
// These assertions inspect the RAW pathAndQuery string on purpose: going through
// URL.searchParams would decode both `+` and `%20` and hide the encoding bug.

test("spaces in filter/orderby/select/expand are emitted as %20, never as +", () => {
  const built = buildQuery("User", {
    filter: "userId eq 'x'",
    orderby: "userId desc",
    select: "userId, firstName",
    expand: "manager, hr",
  });
  assert.equal(
    built.pathAndQuery,
    "User?$filter=userId%20eq%20'x'&$select=userId,%20firstName&$expand=manager,%20hr&$orderby=userId%20desc",
  );
  assert.ok(!built.pathAndQuery.includes("+"));
});

test("a literal + inside a quoted filter value survives verbatim", () => {
  const built = buildQuery("User", { filter: "name eq 'a+b'" });
  assert.equal(built.pathAndQuery, "User?$filter=name%20eq%20'a+b'");
});

test("reserved characters in option values are preserved literally", () => {
  const filter = "(a eq 'x' and b/c eq 1);d eq 'y,z:w'";
  const built = buildQuery("User", { filter });
  assert.equal(built.pathAndQuery, `User?$filter=${filter.replace(/ /g, "%20")}`);
});

test("a literal $ in an option value is not double-encoded and $ option names are literal", () => {
  const built = buildQuery("User", { filter: "name eq '$x'", top: 5, skip: 3, inlinecount: "allpages" });
  assert.equal(built.pathAndQuery, "User?$filter=name%20eq%20'$x'&$top=5&$skip=3&$inlinecount=allpages");
  assert.ok(!built.pathAndQuery.includes("%24"));
});

test("option order follows the ODataQuery.getQuery reference: filter, select, expand, top, skip, skiptoken, inlinecount, orderby", () => {
  const built = buildQuery("User", {
    skiptoken: "t",
    inlinecount: "allpages",
    skip: 1,
    top: 2,
    expand: "e",
    select: "s",
    orderby: "o",
    filter: "f",
  });
  assert.equal(
    built.pathAndQuery,
    "User?$filter=f&$select=s&$expand=e&$top=2&$skip=1&$skiptoken=t&$inlinecount=allpages&$orderby=o",
  );
});

test("$skiptoken is percent-encoded and round-trips through extractSkiptoken byte-identically", () => {
  const raw = '{"startRow":1000,"endRow":2000}';
  const built = buildQuery("User", { skiptoken: raw });
  assert.equal(built.pathAndQuery, `User?$skiptoken=${encodeURIComponent(raw)}`);
  assert.ok(!/[{}"]/.test(built.pathAndQuery));
  assert.equal(extractSkiptoken(`https://x.example.com/odata/v2/${built.pathAndQuery}`), raw);
});

test("empty skiptoken is not appended", () => {
  assert.equal(buildQuery("User", { skiptoken: "" }).pathAndQuery, "User");
});

// --- effective-dating options: bare fromDate/toDate/asOfDate (FR-81 / S5) ------
// SuccessFactors silently ignores `$fromDate`/`$toDate`/`$asOfDate`; only the
// bare names are honoured, so these assertions inspect the RAW string.

test("fromDate and toDate are emitted bare, never with a $ prefix", () => {
  const built = buildQuery("EmpJob", { fromDate: "1970-01-12", toDate: "9999-12-31" });
  assert.equal(built.pathAndQuery, "EmpJob?fromDate=1970-01-12&toDate=9999-12-31");
  assert.ok(!built.pathAndQuery.includes("$fromDate"));
  assert.ok(!built.pathAndQuery.includes("$toDate"));
});

test("asOfDate is emitted bare, never with a $ prefix", () => {
  const built = buildQuery("EmpJob", { asOfDate: "2024-06-30" });
  assert.equal(built.pathAndQuery, "EmpJob?asOfDate=2024-06-30");
  assert.ok(!built.pathAndQuery.includes("$asOfDate"));
});

test("effective-dating options are valid on a key-predicate path", () => {
  const path = "EmpJob(seqNumber=1L,startDate=datetime'2013-01-01T00:00:00',userId='1000001')";
  const built = buildQuery(path, { fromDate: "1970-01-12", toDate: "9999-12-31" });
  assert.equal(built.pathAndQuery, `${path}?fromDate=1970-01-12&toDate=9999-12-31`);
});

// An explicitly provided effective-dating value is never "absent": silently
// dropping it would change the effective-dating window and therefore the result
// set (verification B1).
for (const option of ["fromDate", "toDate", "asOfDate"] as const) {
  for (const [label, submitted] of [
    ["an empty string", ""],
    ["a whitespace-only value", " "],
    ["a trailing-newline value", "2026-10-14\n"],
  ] as const) {
    test(`${option} as ${label} is rejected with OPTION_INVALID`, () => {
      assert.throws(() => buildQuery("EmpJob", { [option]: submitted }), (error: unknown) => {
        if (!isSanitizedError(error)) {
          return false;
        }
        assert.equal(error.code, "OPTION_INVALID");
        assert.equal(error.message, `${option} must be a date in YYYY-MM-DD format`);
        return true;
      });
    });
  }
}

test("an empty effective-dating value counts as provided in the asOfDate exclusivity check", () => {
  // The format check runs first, so the empty value is reported as malformed.
  assert.throws(
    () => buildQuery("EmpJob", { fromDate: "", asOfDate: "2024-06-30" }),
    (error: unknown) =>
      isSanitizedError(error) &&
      error.code === "OPTION_INVALID" &&
      error.message === "fromDate must be a date in YYYY-MM-DD format",
  );
  assert.throws(
    () => buildQuery("EmpJob", { toDate: "", asOfDate: "2024-06-30" }),
    (error: unknown) =>
      isSanitizedError(error) &&
      error.code === "OPTION_INVALID" &&
      error.message === "toDate must be a date in YYYY-MM-DD format",
  );
});

for (const option of ["fromDate", "toDate", "asOfDate"] as const) {
  for (const submitted of ["1970-1-12", "01-01-1970", "19700112"]) {
    test(`${option} "${submitted}" is rejected with OPTION_INVALID without echoing the value`, () => {
      assert.throws(() => buildQuery("EmpJob", { [option]: submitted }), (error: unknown) => {
        if (!isSanitizedError(error)) {
          return false;
        }
        assert.equal(error.code, "OPTION_INVALID");
        assert.ok(error.message.includes("YYYY-MM-DD"));
        assert.ok(!error.message.includes(submitted));
        return true;
      });
    });
  }
}

test("asOfDate combined with fromDate is rejected with OPTION_INVALID", () => {
  assert.throws(() => buildQuery("EmpJob", { asOfDate: "2024-06-30", fromDate: "1970-01-12" }), optionInvalid());
});

test("asOfDate combined with toDate is rejected with OPTION_INVALID", () => {
  assert.throws(() => buildQuery("EmpJob", { asOfDate: "2024-06-30", toDate: "9999-12-31" }), optionInvalid());
});

test("effective-dating options are validated before assembly even when other options are fine", () => {
  assert.throws(() => buildQuery("User", { filter: "a eq 1", top: 5, fromDate: "bad" }), optionInvalid());
});

test("option order places fromDate, toDate and asOfDate between $expand and $top, and $orderby last", () => {
  const built = buildQuery("User", {
    skiptoken: "t",
    inlinecount: "allpages",
    skip: 1,
    top: 2,
    asOfDate: "2024-06-30",
    expand: "e",
    select: "s",
    orderby: "o",
    filter: "f",
  });
  assert.equal(
    built.pathAndQuery,
    "User?$filter=f&$select=s&$expand=e&asOfDate=2024-06-30&$top=2&$skip=1&$skiptoken=t&$inlinecount=allpages&$orderby=o",
  );
  const both = buildQuery("User", { toDate: "9999-12-31", fromDate: "1970-01-12", expand: "e", top: 2 });
  assert.equal(both.pathAndQuery, "User?$expand=e&fromDate=1970-01-12&toDate=9999-12-31&$top=2");
});

for (const [label, control] of [
  ["CR", "\r"],
  ["LF", "\n"],
  ["NUL", "\0"],
] as const) {
  for (const option of ["filter", "orderby", "select", "expand"] as const) {
    test(`${option} containing ${label} is rejected with OPTION_INVALID without echoing the value`, () => {
      const submitted = `secret-business-key${control}GET /evil`;
      assert.throws(() => buildQuery("User", { [option]: submitted }), (error: unknown) => {
        if (!isSanitizedError(error)) {
          return false;
        }
        assert.equal(error.code, "OPTION_INVALID");
        assert.ok(!error.message.includes("secret-business-key"));
        assert.ok(!error.message.includes("evil"));
        assert.ok(!error.message.includes(control));
        return true;
      });
    });
  }
}

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

// --- sanitizeXmlNextLinks (DS-P2-06) ----------------------------------------------

test("sanitizeXmlNextLinks strips the href of rel=next links regardless of quotes, prefix or order", () => {
  // Double quotes, rel first.
  assert.equal(
    sanitizeXmlNextLinks(`<feed><link rel="next" href="https://t.example.com/User?$skiptoken=tok1"/></feed>`),
    `<feed><link rel="next"/></feed>`,
  );
  // Single quotes.
  assert.equal(
    sanitizeXmlNextLinks(`<feed><link rel='next' href='https://t.example.com/User?$skiptoken=tok2'></feed>`),
    `<feed><link rel='next'></feed>`,
  );
  // Optional element namespace prefix plus reversed attribute order.
  assert.equal(
    sanitizeXmlNextLinks(`<feed><atom:link href="https://t.example.com/User?$skiptoken=tok3" rel="next"/></feed>`),
    `<feed><atom:link rel="next"/></feed>`,
  );
  // Neighbouring attributes and spacing survive untouched.
  assert.equal(
    sanitizeXmlNextLinks(
      `<feed><link title="Page 2" href="https://t.example.com/User?$skiptoken=tok4" rel="next" type="application/atom+xml"/></feed>`,
    ),
    `<feed><link title="Page 2" rel="next" type="application/atom+xml"/></feed>`,
  );
});

test("sanitizeXmlNextLinks leaves non-next link hrefs intact", () => {
  const xml =
    `<feed><link rel="self" href="https://t.example.com/User"/>` +
    `<link rel="edit" href="https://t.example.com/User('1')"/>` +
    `<link rel="next" href="https://t.example.com/User?$skiptoken=tok"/>` +
    `<link href="https://t.example.com/User?$skiptoken=tok2" rel="NEXT"/></feed>`;
  // self/edit keep their href; rel="NEXT" (case-sensitive) is not a next link.
  assert.equal(
    sanitizeXmlNextLinks(xml),
    `<feed><link rel="self" href="https://t.example.com/User"/>` +
      `<link rel="edit" href="https://t.example.com/User('1')"/>` +
      `<link rel="next"/>` +
      `<link href="https://t.example.com/User?$skiptoken=tok2" rel="NEXT"/></feed>`,
  );
});

test("sanitizeXmlNextLinks returns XML with no next link byte-identical", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>\r\n<feed xmlns="http://www.w3.org/2005/Atom">\r\n` +
    `<link rel="self" href="https://t.example.com/User"/>\r\n` +
    `<entry><id>https://t.example.com/User('u1')</id></entry>\r\n</feed>\r\n`;
  assert.equal(sanitizeXmlNextLinks(xml), xml);
});

test("sanitizeXmlNextLinks composes with extractXmlPaging: cursor facts come from the original body", () => {
  const raw = `<feed><entry><id>e1</id></entry><link rel="next" href="https://t.example.com/User?$skiptoken=orig"/></feed>`;
  const paging = extractXmlPaging(raw);
  assert.equal(paging.nextUrl, "https://t.example.com/User?$skiptoken=orig");
  const sanitized = sanitizeXmlNextLinks(raw);
  assert.ok(!sanitized.includes("$skiptoken"));
  assert.ok(sanitized.includes("<entry><id>e1</id></entry>"));
});
