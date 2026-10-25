# Publish and test the 0.7.0-rc.1 candidate

This candidate is prepared for opt-in `next`-channel testing, not promotion to
`latest`. Publication is performed by the maintainer with their own npm session
and MFA. Preparing a tarball does not publish it or deploy a VPS.

## Publish the exact tested artifact

1. Use the tarball path and SHA-512 integrity recorded in the release handoff.
   Keep the artifact outside the checkout; do not rebuild a different package
   between testing and publishing.
2. From a directory you control, using your authorized npm account, publish:

   ```bash
   npm publish /path/to/ssff-mcp-0.7.0-rc.1.tgz --tag next --access public
   ```

   Complete npm's MFA flow yourself. Do not send tokens, passwords or one-time
   codes to an assistant. The manifest also sets `publishConfig.tag` to `next`
   as a prerelease default; keep the explicit flag in the publish command.
3. Verify the published version and its integrity against the tested tarball:

   ```bash
   npm view ssff-mcp@0.7.0-rc.1 version dist.integrity
   npm view ssff-mcp dist-tags --json
   ```

   Expected: version `0.7.0-rc.1`, matching integrity, `next` pointing to this
   candidate, and `latest` unchanged from its pre-publication value. Never
   overwrite or reuse a published version if it differs from the expected
   artifact; investigate and prepare a new version instead.

Git push, tagging and GitHub releases are separate maintainer actions. This
workflow does not claim that local commits or documentation are already on the
remote. Publish source commits separately so repository documentation matches
the candidate before sharing it more widely.

## Pin the version for the VPS test

Only after publication has been verified:

```bash
npm install -g ssff-mcp@0.7.0-rc.1
npm list -g ssff-mcp --depth=0
ssff-mcp key generate
```

Expected installed package: `ssff-mcp@0.7.0-rc.1`. A running backend also reports
its runtime version at `/healthz`; there is no CLI `--version` flag.
The token-generation command prints a real
credential: protect it and put only its hash in server config. No production
credentials belong in shell history, build contexts or Git.

Follow [local-user configuration](local-auth-config.md),
[token operations](token-operations.md) and
[personal-token HTTPS hosting](local-users-hosting.md). Bind the backend to
loopback behind an HTTPS proxy in the same host/network namespace; a separate
container proxy with a non-loopback peer is rejected. Do not expose plaintext
HTTP or relax the socket-peer check to make a deployment work.

Before remote operations, explicitly authorize the VPS destination, allowed
operations and account/session. Real TLS, proxy streaming, client login and
SSFF acceptance remain separate checks; local tarball smoke tests cannot
prove them. IAS is out of scope for this candidate.

## Reproduce package checks locally

```bash
pnpm test
pnpm typecheck
npm pack --pack-destination /path/to/existing/artifact-directory --json
```

`npm pack` runs the project's `prepack` build. Inspect the actual archive, not
only `--dry-run` output: it must contain the manifest, compiled runtime, assets
and public config templates, but no tenant config, environment files, private
keys, caches or test state. Test its version, token generation/hash and local
HTTP authentication from an extraction with an empty temporary HOME/config.
Dependency reuse or offline installation is not proof of fresh registry
resolution; record the method and limits in the handoff.
