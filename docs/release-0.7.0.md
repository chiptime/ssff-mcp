# Publish the 0.7.0 stable release

`0.7.0` promotes the 0.7 line to npm `latest` (it was `0.6.0`; `next` holds
`0.7.0-rc.1`). It is not a 1.0 compatibility commitment. Publication is
performed by the maintainer with their own npm session and MFA.

## Publish the exact tested artifact

1. Use the tarball path and SHA-512 integrity recorded in the release handoff.
   Keep the artifact outside the checkout; do not rebuild a different package
   between testing and publishing.
2. From a directory you control, using your authorized npm account:

   ```bash
   npm publish /path/to/ssff-mcp-0.7.0.tgz --tag latest --access public
   ```

   Complete npm's MFA flow yourself. Do not send tokens, passwords or one-time
   codes to an assistant. The manifest no longer sets `publishConfig.tag`, so
   `latest` is also npm's default; keep the explicit flag anyway.
3. Verify the published version, its integrity and the channels:

   ```bash
   npm view ssff-mcp@0.7.0 version dist.integrity
   npm view ssff-mcp dist-tags --json
   ```

   Expected: version `0.7.0` with the recorded integrity, `latest` → `0.7.0`.
   `next` still points to `0.7.0-rc.1`; move it with
   `npm dist-tag add ssff-mcp@0.7.0 next` if you want both channels aligned.
   Never overwrite or reuse a published version; prepare a new one instead.

## After publication

- Smoke-test the registry package: `npx -y ssff-mcp@0.7.0 --help` (exit 0,
  usage text) and a client session against a test tenant
  (`list_environments`, `prompts/list`).
- Catalogs re-index on their own schedule: LobeHub (claim the listing through
  the README badge on the default branch, then refresh its metadata) and npm.io
  read the published `latest` version, not the repository.

## Reproduce package checks locally

```bash
pnpm test
pnpm typecheck
npm pack --pack-destination /path/to/existing/artifact-directory --json
```

`npm pack` runs the project's `prepack` build. Inspect the actual archive: it
must contain the manifest, compiled runtime with its `.d.ts` declarations,
assets and public config templates, but no tenant config, environment files,
private keys, caches or test state.
