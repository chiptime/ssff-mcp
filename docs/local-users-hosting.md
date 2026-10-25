# Host fixed MCP users behind HTTPS

Use individual personal tokens to authenticate MCP clients while SSFF keeps its
existing shared technical account. This interim phase does not provide password
login, MFA, IAS, an administration UI or automatic deployment.

## Quick path

1. Generate a personal token with `ssff-mcp key generate`. Put only its hash in
   the intended tenant's user record, with an explicit role and expiry. Follow
   [Local user configuration](local-auth-config.md) and [Token operations](token-operations.md).
2. Start the backend on the VPS loopback interface, using the mounted config:

   ```bash
   ssff-mcp serve --host 127.0.0.1 --port 8080 --config /etc/ssff-mcp/config.json
   ```

3. Configure an HTTPS-terminating reverse proxy **on the same host/network
   namespace** to forward `/mcp` to `http://127.0.0.1:8080/mcp`. Give it a valid
   certificate and configure `SSFF_ALLOWED_HOSTS` for the exact Host value it
   forwards (hostname only, no scheme/port). Preserve `Authorization`,
   `Mcp-Session-Id`, and the MCP protocol headers. Support streaming responses,
   disable response buffering, and exclude Authorization and response bodies
   from proxy logs.
4. Allow public inbound HTTPS only; do not publish port 8080. Check both IPv4
   and IPv6 firewall rules. Never send a token to an HTTP URL and rely on a
   redirect to protect it: the initial request would already expose it.
5. Configure the MCP client to use `https://<your-host>/mcp` and an
   `Authorization: Bearer <personal-token>` header through its private secret
   store. No SSFF credential belongs on the client.

The backend accepts personal-token requests only from a loopback peer; it does
not trust `X-Forwarded-Proto`, `X-Forwarded-For`, or a caller's claimed HTTPS
scheme. Loopback HTTP is allowed for local testing. The operator must enforce
TLS at the actual ingress: this code does not install or validate a proxy or
certificate. A remote/container proxy with a non-loopback backend peer will be
rejected; do not relax the check or expose the backend to work around it.

## Example security model

```text
User A token -> local MCP user A -> one tenant-local role ---+
User B token -> local MCP user B -> one tenant-local role ---+-> shared SSFF account
                         environment policy AND role policy
```

Roles declare explicit environment aliases. Each permitted environment applies
its existing tenant/environment overrides, then intersects that policy with the
role. An empty/absent list or `fields` narrows nothing in that layer; it never
removes the other layer's restrictions. An empty effective field intersection
stays keys-only, with XML output downgraded to JSON for safe redaction.

Old `apiKeyHash` entries retain their previous broad/scoped access without a
user role. Remove unused legacy keys when preparing a personal-token-only
deployment, and never distribute a broad legacy key as a substitute for an
individual user's token. STDIO remains a trusted local mode and does not apply
HTTP user roles.

## Freshness and isolation

- Every incoming HTTP request validates the current token, expiry, revocation,
  enabled flag, tenant and role against one config snapshot. Write config
  updates atomically, with owner-only permissions. An invalid security config
  fails closed; repair it rather than bypassing authentication.
- Disabling/revoking/expiring affects the next request, including established
  sessions. A request already admitted finishes under its own snapshot; this
  does not promise cancellation of in-flight queries or an open SSE connection.
- Sessions belong to authentication method, tenant and user. Another user or a
  legacy key cannot reuse them. A valid replacement token for the same user can
  continue the session. Role changes apply without reopening it.
- Send one credential. If both `Authorization: Bearer` and `X-Api-Key` contain
  different values and either identifies a personal token, the request is
  rejected rather than choosing an identity. Duplicate identical values are
  accepted; old-key-only requests keep their historical Bearer precedence.
- Personal cursors bind to user and role policy. Another user, legacy access,
  or a changed role cannot replay them. Every continuation still checks current
  environment/entity/field authorization.
- Metadata caches hold tenant-scoped schemas, not user-authorized responses;
  catalog/schema visibility and response redaction are evaluated per request.
- The derived picklist resolver mixes legacy and MDF sources/cache contents.
  For personal users it requires full entity and field access to all its
  potential sources: `PicklistOption`, `Picklist`, `PicklistLabel`, and
  `PickListValueV2`. Otherwise it fails with `ENTITY_NOT_ALLOWED`, including on
  cache hits. Regular entity queries and expanded-label reads retain their own
  path/field policy checks.

## Audit and credential handling

Use opaque technical user IDs, not names or email addresses. Personal-user tool
audit records include tenant, user ID, effective role, operation, outcome and
duration. Attributable rejected expired/revoked/disabled credentials have no
invented effective role. Invalid/unrecognized credentials cannot reliably be
attributed. Logs exclude personal tokens, SSFF payloads and query arguments;
protect and rotate both application and proxy logs.

The generator provides 256 random bits. SHA-256 is used to compare these random
tokens, **not** to store user-chosen passwords. Possession of an unexpired token
is sufficient for access: protect client storage, rotate lost tokens, keep
expiry periods short for your operational needs, and restrict VPS/config/cache
filesystem access. A compromised backend or SSFF account is outside the
protection offered by per-user MCP roles.

## Local acceptance and production checks

From this checkout:

```bash
pnpm build
node --test dist/test/local-users-http.test.js
```

The versioned local smoke test invokes the token-generation CLI under a clean
temporary HOME, creates a hash-only config outside the checkout, authenticates
over loopback HTTP and checks both an allowed and denied operation against
simulated SSFF. The same suite exercises role changes, revocation, expiry,
rotation, schemas, navigation, batch rejection, XML downgrade, cursors,
concurrent requests and audit exclusions. It does not access real SAP or IAS.

Before operating a VPS, separately verify the certificate, public HTTP/backend
inaccessibility, forwarded Host, streaming/session behavior through the proxy,
owner-only config/secret mounts and token revocation from a real client. Local
tests are not proof that an external deployment is secure or completed. IAS
integration remains a later, separately validated phase.
