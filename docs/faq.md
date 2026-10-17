# FAQ & comparison

> Part of [ssff-mcp](../README.md). Common questions, and how this compares to
> the alternatives.

## Frequently asked questions

**Is it really read-only? Can it change anything in SuccessFactors?**
No. There is no write path: no tool can issue POST/PUT/PATCH/DELETE/MERGE, and
there is no input surface for HTTP methods or headers. The only `POST` is the
fixed, GET-only `$batch` envelope used by `batch_get` (plus the two fixed OAuth
token endpoints). See [Security](security.md).

**Where does my data go?**
Nowhere but your machine and your tenant. The server runs locally over STDIO and
talks directly to your SuccessFactors host over HTTPS. Nothing is proxied through
a third party.

**Which entities can it read?**
Any entity set your SuccessFactors API account can read, optionally narrowed **per
environment** by
[`entityAllowlist`](configuration.md#entity-allowlist-and-denylist) and subtracted
by `entityDenylist`. What the account can read, the server can read — nothing more.

**Do I need a special SuccessFactors account or admin work?**
You need an API user (Basic or OAuth 2.0). For OAuth, the client machine's IP must
be whitelisted in SF Admin Center, and the client application must be registered
there. See [Authentication](configuration.md#authentication).

**How do I keep it safe?**
Use a read-only, least-privileged account, restrict the config file to owner-only
(`chmod 600`), prefer OAuth secret providers (`fromEnv`/`fromCommand`) so no
secret sits on disk, and optionally pin an entity allowlist. Details in
[Security](security.md).

**The docs mention `inspect_entity`, but npm says 0.3.0 — why?**
The **published** npm version is 0.3.0. `inspect_entity`, the `cache invalidate`
command, the configurable size cap and the Custom MDF improvements are on `main`
and land in the **next** release; until then, [build from source](development.md#build-and-test)
if you need them.

**Does it support OData v4?**
No — OData v2 only. v4 is deferred until a tenant with a verified v4 endpoint
exists.

**Can it resolve picklists / show labels instead of IDs?**
Not yet. Values come back as SuccessFactors returns them (native fields, no
normalization). See the picklist PRD in the repository for the planned work.

**The tenant schema changed — how do I force a reload?**
Run `ssff-mcp cache invalidate <alias>` (or `--all`). The metadata cache has a
24h TTL otherwise. See [CLI](configuration.md#cli).

**Can I get more than one page?**
Yes: when `hasMore` is true the response carries an opaque `cursor`; re-issue the
same call with it. Cursors are process-scoped (invalid after a server restart).
See [Pagination and continuation](tools.md#pagination-and-continuation).

## How it compares

| | **ssff-mcp** | SF UI / reports | Raw OData (`curl`/script) | Ad-hoc integrations |
|---|---|---|---|---|
| **Read-only by construction** | Yes (enforced in code) | Yes | Depends on your script | Depends |
| **Credential handling** | Basic/OAuth, secret providers, HTTPS-only, no logs | Session | You store/send secrets yourself | Varies |
| **Schema discovery** | Yes (`inspect_entity`, MCP resources) | Manual | Read `$metadata` yourself | Usually none |
| **Pagination / cursors** | Built in (1 page/call, signed cursor) | UI paging | You implement it | Rarely |
| **Usable from an AI assistant** | Yes (any MCP client) | No | Only with extra glue | Varies |
| **Setup** | `npx ssff-mcp init` + one client block | Browser | Write and maintain a client | High |
| **Can it write?** | No, by design | Yes | Yes | Often yes |

**Against the SuccessFactors UI:** the UI is made for humans and cannot be driven
by an AI assistant; `ssff-mcp` gives the assistant structured, paginated reads
with the same read-only guarantee.

**Against calling OData directly:** writing your own client means handling auth,
token refresh, effective dating, `$batch`, cursor pagination, error sanitization
and the read-only boundary yourself. `ssff-mcp` is exactly that layer, packaged
for an MCP client.

**Against ad-hoc scripts/integrations:** scripts tend to grow write paths and to
leak credentials. This server refuses to write and keeps secrets out of logs.
