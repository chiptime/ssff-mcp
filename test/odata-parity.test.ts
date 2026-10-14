import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery, type QueryOptions } from "../src/odata.js";

/**
 * Parity oracle: a structural copy of the production reference assembler.
 *
 * Source: operational-centers (recruiting-backend),
 *   srv/shared/infrastructure/OData/ODataQuery.ts, lines 19-31 (`getQuery`).
 *
 * That code is known to work against SuccessFactors. It assembles the query by
 * raw string concatenation: no `URLSearchParams`, no percent-encoding, spaces
 * left literal. Falsy entries are dropped and the rest joined with `&`.
 * The reference file is NOT imported (it lives outside this repo); only its
 * assembly logic is reproduced here. The leading `?`/`/$count?` handling of the
 * original (line 17) is omitted because only the query string is compared.
 */
interface BackendParams {
  _filter?: string;
  _select?: string;
  _expand?: string;
  _top?: number;
  _skiptoken?: string;
  _inlineCount?: boolean;
  _orderby?: string;
  _queryParams?: string;
}

function backendGetQuery({
  _filter,
  _select,
  _expand,
  _top,
  _skiptoken,
  _inlineCount,
  _orderby,
  _queryParams,
}: BackendParams): string {
  return [
    _filter ? `$filter=${_filter}` : undefined,
    _select ? `$select=${_select}` : undefined,
    _expand ? `$expand=${_expand}` : undefined,
    _top ? `$top=${_top}` : undefined,
    _skiptoken ? `$skiptoken=${_skiptoken}` : undefined,
    _inlineCount ? "$inlinecount=allpages" : undefined,
    _orderby ? `$orderby=${_orderby}` : undefined,
    _queryParams,
  ]
    .filter((n) => n)
    .join("&");
}

/**
 * Declared parity condition (FR-84 / S7):
 *
 *   "same option set, same per-option bytes, order-independent".
 *
 * Both query strings are split into ordered `name=value` pairs (name = text up
 * to the first `=`). The single agreed divergence is applied to the REFERENCE
 * side only: every literal space becomes `%20` (the MCP always emits `%20`; the
 * reference emits raw spaces, which SuccessFactors accepts but which are not
 * valid on an HTTP request line). Then:
 *   1. the two pair lists, each sorted by name, must be byte-identical;
 *   2. every individual option value must be byte-identical between the sides;
 *   3. the MCP side must not contain `%24` (option names carry a literal `$`)
 *      and must not introduce any `+` (a `+` only appears when the input value
 *      itself contains one, so its count must equal the count in the input).
 *
 * Parameter ORDER is deliberately out of scope: SuccessFactors does not depend
 * on the order of query options, and the MCP owns its own deterministic order
 * (`$filter`, `$orderby`, `$select`, `$expand`, ..., `$top`, ..., `$inlinecount`,
 * `$skiptoken`) which differs from the reference order. Effective-dating
 * options (`fromDate`/`toDate`/`asOfDate`) diverge from the backend by design
 * and are not part of the parity scope.
 */
function toPairs(query: string): Array<[string, string]> {
  if (query.length === 0) {
    return [];
  }
  return query.split("&").map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index), part.slice(index + 1)] as [string, string];
  });
}

function byName(a: [string, string], b: [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function countOf(text: string, char: string): number {
  return text.split(char).length - 1;
}

interface ParityCase {
  label: string;
  options: QueryOptions;
}

function toBackendParams(options: QueryOptions): BackendParams {
  return {
    _filter: options.filter,
    _select: options.select,
    _expand: options.expand,
    _top: options.top,
    _skiptoken: options.skiptoken,
    _inlineCount: options.inlinecount === "allpages",
    _orderby: options.orderby,
  };
}

function assertParity(options: QueryOptions): void {
  const mcpQuery = buildQuery("User", options).pathAndQuery.split("?")[1] ?? "";
  const backendQuery = backendGetQuery(toBackendParams(options));

  const mcpPairs = toPairs(mcpQuery);
  const backendPairs = toPairs(backendQuery).map(
    ([name, value]) => [name, value.replace(/ /g, "%20")] as [string, string],
  );

  // 1. Same option set, same bytes, order-independent.
  assert.deepEqual([...mcpPairs].sort(byName), [...backendPairs].sort(byName));

  // 2. Per-option value bytes are identical.
  assert.equal(mcpPairs.length, backendPairs.length);
  for (const [name, value] of backendPairs) {
    const mcp = mcpPairs.find(([mcpName]) => mcpName === name);
    assert.ok(mcp, `MCP side is missing option ${name}`);
    assert.equal(mcp[1], value, `value bytes differ for ${name}`);
  }

  // 3. No percent-encoded `$` and no `+` introduced by the MCP assembly.
  assert.equal(mcpQuery.includes("%24"), false, "MCP query contains %24");
  const inputPlusCount = [options.filter, options.orderby, options.select, options.expand]
    .map((value) => countOf(value ?? "", "+"))
    .reduce((sum, n) => sum + n, 0);
  assert.equal(countOf(mcpQuery, "+"), inputPlusCount, "MCP query introduced a `+`");
  if (inputPlusCount === 0) {
    assert.equal(mcpQuery.includes("+"), false);
  }
}

const CASES: ParityCase[] = [
  { label: "User filter from the bug report", options: { filter: "status eq 'f'" } },
  {
    label: "multi-clause filter with reserved characters",
    options: { filter: "(a eq 'x' and b/c eq 1);d eq 'y,z:w'" },
  },
  { label: "literal + inside a quoted value", options: { filter: "name eq 'a+b'" } },
  {
    label: "orderby with select and expand",
    options: { orderby: "startDate desc", select: "userId,firstName", expand: "manager" },
  },
  {
    label: "top and inlinecount present on both sides",
    options: { filter: "status eq 'f'", top: 5, inlinecount: "allpages" },
  },
  {
    label: "every option together",
    options: {
      filter: "status eq 'f'",
      orderby: "startDate desc",
      select: "userId,firstName",
      expand: "manager",
      top: 10,
      inlinecount: "allpages",
    },
  },
];

for (const { label, options } of CASES) {
  test(`parity with ODataQuery.getQuery: ${label}`, () => {
    assertParity(options);
  });
}

test("parity: the MCP keeps its own order, which differs from the reference order", () => {
  // Documents why order is out of the parity claim: the two assemblers
  // legitimately disagree on it while agreeing on the option set and bytes.
  const options: QueryOptions = {
    filter: "status eq 'f'",
    orderby: "startDate desc",
    select: "userId",
    expand: "manager",
    top: 5,
    inlinecount: "allpages",
  };
  const mcpNames = toPairs(buildQuery("User", options).pathAndQuery.split("?")[1] ?? "").map(([n]) => n);
  const backendNames = toPairs(backendGetQuery(toBackendParams(options))).map(([n]) => n);
  assert.notDeepEqual(mcpNames, backendNames);
  assert.deepEqual([...mcpNames].sort(), [...backendNames].sort());
});

test("parity oracle self-check: the reference keeps spaces literal and the MCP never does", () => {
  const options: QueryOptions = { filter: "status eq 'f'" };
  assert.equal(backendGetQuery(toBackendParams(options)), "$filter=status eq 'f'");
  assert.equal(buildQuery("User", options).pathAndQuery, "User?$filter=status%20eq%20'f'");
});

test("parity: a reference mismatch would be detected (guard against a vacuous comparison)", () => {
  // A `+`-encoded space (the pre-fix URLSearchParams shape) must NOT satisfy parity.
  const backendPairs = toPairs(backendGetQuery({ _filter: "status eq 'f'" })).map(
    ([name, value]) => [name, value.replace(/ /g, "%20")] as [string, string],
  );
  const encodedPairs = toPairs("$filter=status+eq+%27f%27");
  assert.notDeepEqual([...encodedPairs].sort(byName), [...backendPairs].sort(byName));
});
