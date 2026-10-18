# Host one MCP service for multiple tenants

The local STDIO server and the hosted service use the same read-only tools.
Hosted clients connect to **`https://<your-domain>/mcp`** with an API key; SAP
credentials stay on the server. Users, roles and IAS/OIDC are **not implemented**
in this phase: an API key authorizes a tenant plus an environment scope.

## Quick path: pilot on Dokploy

1. Build this branch with the root `Dockerfile`. The runtime uses Node 22 and
   runs as `node` (UID 1000). No SAP credential and no tenant config enters the
   image.
2. Copy `config.hosted.template.json` to a private file on the VPS and fill in
   the tenant's **dev, test and prod** origins, read-only SAP accounts and key
   hashes. The placeholders fail validation until replaced, on purpose.
3. Mount the **parent config directory** read-only at
   `/home/node/.config/ssff-mcp`, and a writable persistent cache directory at
   `/home/node/.cache/ssff-mcp` owned by UID 1000. Mount the directory (not a
   single file) so updating the config can use an atomic rename.
4. Set the SAP password/private-key environment variables named by `fromEnv` in
   Dokploy. A change in those process variables needs a container restart; a JSON
   policy change is reread without restart. No secret goes in Git.
5. Configure the domain and **TLS in Dokploy**, targeting container port 8080,
   and set `SSFF_ALLOWED_HOSTS` to the exact public hostname (no scheme, no port),
   for example `mcp.example.com`. Keep the container port private: only the HTTPS
   route is published through Traefik. Proxy-to-container traffic is HTTP on the
   private network, **not end-to-end TLS**.
6. Use `/healthz` for the probe and make sure the `/mcp` route streams without a
   buffering middleware; check the proxy's idle timeouts too.
7. If the SF tenant enforces IP restrictions, register the service's **actual
   outbound address** in that tenant's API login exceptions. Verify the VPS egress
   policy: a fixed address is an operational requirement only when SAP requires
   it, not an unconditional OData requirement.
8. Pilot with separate dev/test/prod keys. Never give a production key to someone
   who should only read development data.

Nothing here is automated on the VPS: deploying, exposing a domain and moving
secrets require the operator's explicit authorization.

## API keys

Generate a high-entropy random key with your secret manager and store only its
SHA-256 hex digest in `apiKeyHash`. The helper reads **one line from stdin** and
prints only the digest:

```bash
ssff-mcp key hash < /private/path/to/key.txt
```

Never put the plaintext key in arguments, URLs, shell history or logs. Distribute
it through the secret manager.

- `tenants.<id>.apiKeyHash` grants every environment of that tenant.
- `tenants.<id>.environments.<alias>.apiKeyHash` grants only that environment.
- Keys must be unique across tenants/environments; an ambiguous match is denied.
- A session is bound to its opening key, tenant and environment scope; another key
  cannot reuse it, even inside the same tenant. Removing a key or changing a scope
  rejects later requests: reconnect with a valid key.
- Every `/mcp` request needs `Authorization: Bearer <key>` or `X-API-Key`.
  `/healthz` is public and never contacts SAP.

## Server settings

```bash
ssff-mcp serve --port 8080 --host 0.0.0.0 --config /private/config.json
```

| Setting | Default | Purpose |
|---|---|---|
| `--port`, `-p` / `PORT` | `8080` | Internal HTTP port. A non-empty `PORT` with no command selects HTTP; unset or empty keeps STDIO. |
| `--host` | `0.0.0.0` | Bind address; use `127.0.0.1` outside a private container network. |
| `--config` | `~/.config/ssff-mcp/config.json` | Mounted tenants file. |
| `SSFF_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Accepted Host hostnames. **Set your public domain behind Dokploy.** Forwarded headers never grant trust. |
| `SSFF_MAX_SESSIONS` | `50` | Process-wide concurrent session ceiling; extra initialization gets 503. There is no per-key rate limiter yet. |
| `SSFF_SESSION_IDLE_MS` | `300000` | Closes idle sessions whose clients vanish without DELETE. |

Invalid ports or options fail instead of silently choosing defaults. The endpoint
is the standard Streamable HTTP **`/mcp`** (POST/GET/DELETE), never the legacy
`/sse` + `/message`. Clients may terminate a session with DELETE; closing only the
local transport can leave it alive until the idle sweep. SIGTERM/SIGINT drains
active work for up to ten seconds.

## Client connection examples

Protocol interoperability is verified with the official MCP SDK. **The desktop/CLI
products below have not been run end-to-end against the pilot**: their MCP
integrations and supported authentication vary by installed version, so treat these
as configuration guidance, not certification.

### OpenCode

```json
{
  "mcp": {
    "ssff": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <environment-key>" },
      "oauth": false
    }
  }
}
```

### Codex

```toml
[mcp_servers.ssff]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "SSFF_MCP_API_KEY"
```

Inject `SSFF_MCP_API_KEY` with the client's secret mechanism, not a committed file.

### VS Code / GitHub Copilot

```json
{
  "servers": {
    "ssff": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${input:ssff-key}" }
    }
  },
  "inputs": [
    { "id": "ssff-key", "type": "promptString", "description": "SF MCP environment key", "password": true }
  ]
}
```

Corporate policy may also require an approved MCP registration.

### Claude Desktop, Pi and agy

| Client | Needed | Unverified limitation |
|---|---|---|
| Claude Desktop | A native remote connector to the `/mcp` URL with an environment-specific Authorization header. | The installed version must allow static headers; an OAuth-only connector cannot use this API-key phase. IAS/OAuth is phase 3. |
| Pi | Its MCP integration must support Streamable HTTP plus a Bearer/custom header. | Integration-specific; no universal Pi JSON schema is assumed here. |
| agy | Its MCP integration must support the `/mcp` URL and a secure Authorization header. | Confirm your deployed client's remote transport/auth settings; no config block is invented. |

If a required client lacks the capability, treat compatibility as **pending**. Do
not work around corporate installation restrictions by silently adding a local
`npx` proxy.

## Isolation and operations

- Policies resolve **per field**: an environment value wins if present, otherwise
  the tenant value is inherited, including an explicit empty list. Inside the
  resolved environment, the denylist beats the allowlist. This is not an
  intersection/union across levels; roles come later.
- Metadata filenames escape both the tenant and alias components. OAuth token
  caches include tenant, environment and credential identity; tokens stay
  **memory-only**, so only metadata needs the persistent cache volume.
- Continuation cursors bind tenant, alias, path and options; cross-tenant reuse is
  rejected before dispatch, and restarting the service invalidates old cursors.
- Listings and resources expose only the key's permitted environments. HTTP logs
  carry operation metadata, never key headers, query-string content or SAP bodies.
  Restrict log access anyway.
- One shared process is one availability boundary. Several replicas need a
  deliberate session-routing/state design; do not enable horizontal scaling by
  accident. The pilot is **one replica**.
- A later BTP Cloud Foundry move must verify outbound IP policy, streaming
  timeouts, secret bindings, storage and session routing. No CF deployment is
  claimed or automated here.

## Verification boundaries

Automated local tests cover authentication, revoked and scoped keys, denied data
dispatch, tenant-specific credentials/caches/cursors, HTTP sessions, the idle
sweep, concurrency limits and graceful shutdown. A Docker build/runtime and real
Dokploy/TLS operation need a Docker-capable operator environment. IAS groups,
claims and client-registration compatibility are deferred to phase 3.
