# Package ecosystem and registry operations

Capybara packages are declarative, integrity-covered bundles. A package can
contain plugins, Skills, prompts, themes, custom agents, hooks, schemas, and
assets. Plugins are the executable subset; the package is the user-facing unit
that is requested, locked, restored, updated, and removed.

## State and precedence

Project state is committed:

- <code>.capybara/packages.json</code> records source, scope, and requested grants.
- <code>.capybara/packages.lock.json</code> records the exact version, source,
  package and manifest SHA-256 digests, verified signing key, contents, and
  effective grants.

User-scoped declarations and locks live below the Capybara data directory.
Immutable package bytes and operation receipts live below the Capybara cache
and data directories. Plugin enable/disable state is host-local and keyed by a
stable workspace SHA-256 identity.

Effective precedence is user package state followed by trusted project package
state. A project package never participates before workspace trust succeeds.
Changes to the request file, lockfile, executable declarations, or requested
capabilities change the Project Trust v2 digest and require review.

## Installation pipeline

Every install and update follows one transaction:

1. Resolve a <code>registry:</code> or <code>path:</code> source.
2. Verify source identity, manifest schema, compatibility metadata, and bounds.
3. Verify the signed registry index and package manifest when applicable.
4. Verify the exact file set, per-file SHA-256 values, package digest, paths,
   and expanded byte limit.
5. Reject symlinks, special files, traversal, unknown manifest fields, and
   postinstall scripts.
6. Run contained plugin admission; project plugins must be WASI.
7. Compare requested and explicitly granted authority. Grants may only narrow.
8. Stage into a host-owned directory and re-read every staged digest.
9. Atomically replace the lockfile, activate the supervisor, and health-check.
10. Persist an idempotent operation receipt.

If any step fails, Capybara restores the prior lock, prior plugin activation,
and prior package request file, removes newly staged bytes, and records a
failed or rolled-back receipt. Scope-level queues and live-PID operation locks
prevent concurrent clients from losing lockfile updates.

No plugin receives ambient credentials or inherited secret environment
variables. A plugin sees only the authority represented by its effective
operation and grant.

## CLI and TUI

~~~text
capy trust [--show-diff]
capy bootstrap [--frozen] [--offline] [--project|--user]

capy package search <query>
capy package info <id>
capy package add <source> [--project|--user]
  [--allow-unsigned-local] [--grant-requested] [--offline]
capy package remove <id> [--project|--user]
capy package update [id] [--project|--user] [--offline]
capy package verify <source> [--allow-unsigned-local] [--offline]
capy package list [--project|--user|--effective]
capy package doctor [id] [--project|--user|--effective]
capy package publish [path] --dry-run
capy package init [path]

capy plugin list
capy plugin inspect <id>
capy plugin enable|disable <id>
capy plugin grants <id>
~~~

<code>package add</code> prints requested-versus-granted authority before
changing state. The default grant is empty. <code>--grant-requested</code> is
explicit consent to the complete request. <code>path:</code> sources are
unsigned development inputs and also require
<code>--allow-unsigned-local</code>; the warning and trust check cannot be
suppressed.

The <code>/plugins</code> overlay reads the same runtime state and accepts
search, install, update, remove, inspect, enable, disable, grants, and list. It
deliberately refuses unsigned local installation; use the CLI so the dedicated
warning and opt-in are visible.

## Frozen and offline bootstrap

<code>capy bootstrap --frozen</code> requires a one-to-one match between
package requests and lock entries. Resolution must reproduce the locked source,
version, manifest digest, package digest, signature state, contents, and grants.

<code>--offline</code> disables registry transport. A frozen package succeeds
only when its exact bytes are already in the immutable cache or its
<code>path:</code> source is present. A cache miss, changed byte, missing lock,
changed signing key, or new authority request fails deterministically.

In a non-interactive environment, missing workspace trust exits with code 4;
malformed or frozen package state exits with code 9. CI must provision the
workspace trust decision outside the repository or run the trust-diff step for
review. Repository-controlled files cannot self-approve trust.

Recommended CI sequence:

~~~bash
capy trust --show-diff
capy bootstrap --frozen --offline
capy package doctor
~~~

The trust store and immutable cache may be restored from a protected CI cache,
but credentials and personal approval rules must never be committed.

## Signed static registry

Configure the registry through user-owned process settings:

- <code>CAPYBARA_PACKAGE_REGISTRY</code>: HTTPS base URL at the registry root.
- <code>CAPYBARA_PACKAGE_ROOT_KEYS_FILE</code>: path to a version 1.0
  public-key document.
- <code>CAPYBARA_PACKAGE_ROOT_KEYS_JSON</code>: inline equivalent, mutually
  exclusive with the file setting.

~~~bash
export CAPYBARA_PACKAGE_REGISTRY=https://registry.example/v1/
export CAPYBARA_PACKAGE_ROOT_KEYS_FILE=$HOME/.config/capybara/registry-keys.json
capy package search typescript
capy package add registry:publisher/package --project
~~~

The transport fetches <code>index.json</code> without redirects. Artifact URLs
must remain under the configured HTTPS origin and path. The index has this
shape:

~~~json
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-08-30T00:00:00Z",
  "expiresAt": "2026-09-30T00:00:00Z",
  "packages": [{
    "id": "publisher/package",
    "description": "Package description",
    "keywords": ["typescript"],
    "latest": "1.2.0",
    "versions": [{
      "version": "1.2.0",
      "artifact": "packages/publisher/package/1.2.0.json",
      "manifestDigest": "sha256:...",
      "packageDigest": "sha256:...",
      "keyId": "registry-root-2026",
      "withdrawn": false
    }]
  }],
  "revokedKeyIds": [],
  "signature": {
    "keyId": "registry-root-2026",
    "algorithm": "ed25519",
    "value": "base64..."
  }
}
~~~

The signature covers canonical JSON of every field except
<code>signature</code>. Artifacts contain a base64 package manifest and a
bounded list of base64 files. The package manifest carries a separate Ed25519
signature over its canonical body without the signature field. Presence of
signature metadata is never treated as proof; both signatures must verify
against an active pinned key.

The checked schemas are:

- <code>schemas/package/registry-index.schema.json</code>
- <code>schemas/package/registry-artifact.schema.json</code>
- <code>schemas/package/registry-root-keys.schema.json</code>

## Key rotation, revocation, and withdrawal

Rotation uses overlap:

1. Generate the new Ed25519 key offline and protect the private half.
2. Distribute the new public key in the user or admin root-key document.
3. Publish an index signed by the old active key that references packages
   signed by either old or new keys.
4. Move new releases to the new key.
5. After the overlap window, sign the index with the new key.
6. Remove the old public key only after every supported client has the new pin.

For compromise:

1. Add the affected key ID to <code>revokedKeyIds</code> in an index signed by a
   different active pinned key.
2. Mark affected versions <code>withdrawn: true</code>.
3. Publish replacement packages with new versions and a new key.
4. Rotate the user or admin root-key document.
5. Preserve the incident index, receipts, checksums, SBOM, and provenance.

A revoked index-signing key cannot revoke itself; emergency recovery requires a
separately stored active root. A withdrawn version remains visible for audit
but cannot resolve or install.

## App Protocol

Read methods use the observer role:

- <code>plugin.list</code>, <code>plugin.inspect</code>,
  <code>plugin.grants</code>
- <code>package.search</code>, <code>package.inspect</code>

Changes require <code>administrator-local</code>, a client-bound command
envelope, and an idempotency key:

- <code>plugin.install</code>, <code>plugin.update</code>,
  <code>plugin.enable</code>, <code>plugin.disable</code>,
  <code>plugin.resolveGrant</code>
- <code>package.install</code>, <code>package.remove</code>,
  <code>package.update</code>, <code>package.verify</code>,
  <code>package.bootstrap</code>

Both embedded sessions and daemon-owned session workers use the same
PackageRuntime. Retries return the original operation receipt. A host without a
configured signed registry reports <code>package.search</code> as unsupported
instead of claiming availability.
