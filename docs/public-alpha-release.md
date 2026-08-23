# Capybara Code Public Alpha release runbook

This runbook publishes the first usable-but-not-dependable public build of Capybara Code. Do not publish a package from an unreviewed or dirty checkout.

## Release contract

- Published versions: `v0.1.0-alpha.3` and `v0.1.0-alpha.5`. The `v0.1.0-alpha.4` workflow failed before publishing any package; no release tag may be moved. The next release is `v0.1.0-alpha.6`.
- npm dist-tag: `alpha`.
- npm packages: `capybara-code`, `@ilbie/capybara-code-win32-x64`, `@ilbie/capybara-code-darwin-x64`, `@ilbie/capybara-code-darwin-arm64`, and `@ilbie/capybara-code-linux-x64`.
- Public command: `capy`.
- Checkout-only command: `capy-dev`.
- Supported targets: Windows x64, macOS x64, macOS ARM64, and glibc Ubuntu/WSL Linux x64. Linux ARM64 and musl are deliberately out of scope for this alpha.

The root package contains only the CommonJS launcher. It chooses an OS/CPU-constrained optional platform package; it has no download hook or installer. Each platform package contains only `bin/`, `libexec/`, `share/`, `manifest.json`, and `LICENSE`.

Users install only the unscoped launcher. npm resolves the matching public `@ilbie` optional dependency automatically:

```bash
npm install --global capybara-code@alpha
```

## Preflight

1. Review and commit the intended changes. The release tag must be made from a clean checkout; npm versions cannot be reused after a partial publish.
2. Make the GitHub repository public before a trusted-publisher release. Verify that the `npm-publish` GitHub Environment exists and requires approval.
3. Verify the package names immediately before publishing:

   ```bash
   npm view capybara-code version
   npm view @ilbie/capybara-code-win32-x64 version
   npm view @ilbie/capybara-code-darwin-x64 version
   npm view @ilbie/capybara-code-darwin-arm64 version
   npm view @ilbie/capybara-code-linux-x64 version
   ```

   A registry `E404` is expected for an unclaimed name. Stop if any name belongs to another publisher.
4. Verify every version source agrees with the planned tag:

   ```bash
   bun run release:check -- --version v0.1.0-alpha.6
   bun install --frozen-lockfile
   bun run typecheck
   bun run test:release
   ```

5. Confirm that all five existing packages have the exact Trusted Publisher configuration documented below. The release workflow deliberately has no npm token fallback.

## Build and tag

The release workflow starts only for an alpha tag. After the reviewed release commit is pushed:

```bash
git tag -a v0.1.0-alpha.6 -m "Capybara Code v0.1.0-alpha.6"
git push origin v0.1.0-alpha.6
```

`.github/workflows/release.yml` validates version alignment, then builds and smoke-tests all four native targets on their corresponding GitHub-hosted runners. It rejects source maps, local checkout paths, and duplicate `share/share` directories while constructing package payloads.

For macOS and Linux, `bin/capy` and `libexec/cbc-runtime` must both have mode `0755`. Each native runner creates the final npm `.tgz` before `actions/upload-artifact` runs, because artifact transport normalizes ordinary uploaded files to non-executable modes. The publish job transfers only those immutable tarballs, extracts the three POSIX packages, and fails unless both entry points are still executable.

Once the native matrix passes, approval of the `npm-publish` Environment allows the workflow to:

1. Publish the four platform tarballs with the `alpha` tag.
2. Publish the `capybara-code` launcher tarball with the `alpha` tag.
3. Generate `SHA256SUMS.txt` from the native archives.
4. Create a GitHub prerelease containing the archives and checksums.

The alpha manifest must describe the artifacts as unsigned. SHA-256 is an integrity check, not a signature scheme.

## npm Trusted Publishing

The `alpha.3` bootstrap created all five packages. Before any later release, use an npm owner account to connect every package to this repository, workflow, and Environment:

`npm trust` requires npm 11.15.0 or newer, package write access, and account-level two-factor authentication. Each package must already exist on the public npm registry.


```bash
for package in \
  capybara-code \
  @ilbie/capybara-code-win32-x64 \
  @ilbie/capybara-code-darwin-x64 \
  @ilbie/capybara-code-darwin-arm64 \
  @ilbie/capybara-code-linux-x64
do
  npm trust github "$package" \
    --repository nevrixo/Capybara-Code \
    --file release.yml \
    --environment npm-publish \
    --allow-publish \
    --yes
  sleep 2
done
```

Verify each package in npm's access settings and remove any obsolete `NPM_BOOTSTRAP_TOKEN` from the Environment. Every later alpha tag uses the workflow's `id-token: write` permission with `npm publish --provenance`; a long-lived npm token must not be reintroduced.

If the `@nevrixo` scope becomes available later, publish the native packages under that scope in a new version and update the launcher dependencies. Deprecate the old `@ilbie` packages only after the new release is live; do not unpublish them, because older launcher versions still depend on them.

If one of the five publishes partially fails, diagnose it without retrying the same version. Bump every version source to a new `alpha.N`, rerun the gates, and publish a new tag.

## Isolated installer validation

Run this only after the packages are available under the `alpha` dist-tag. It exercises registry installation without changing the user's real global `capy` command.

On Windows PowerShell:

```powershell
$npmPrefix = Join-Path ([System.IO.Path]::GetTempPath()) "capy-npm-alpha"
npm install --prefix $npmPrefix --global capybara-code@alpha
& (Join-Path $npmPrefix "capy.cmd") version

# Use a dedicated Bun configuration for a separate check.
$bunGlobal = Join-Path ([System.IO.Path]::GetTempPath()) "capy-bun-alpha"
$bunBin = Join-Path ([System.IO.Path]::GetTempPath()) "capy-bun-alpha-bin"
$bunfig = Join-Path ([System.IO.Path]::GetTempPath()) "capy-bun-alpha-bunfig.toml"
@"
[install]
globalDir = "$($bunGlobal.Replace([char]92, '/'))"
globalBinDir = "$($bunBin.Replace([char]92, '/'))"
"@ | Set-Content -LiteralPath $bunfig -Encoding utf8
bun install "--config=$bunfig" --global capybara-code@alpha
& (Join-Path $bunBin "capy.exe") version
Remove-Item -LiteralPath $bunfig
```

On WSL, first make sure the package managers are native Linux executables rather than inherited Windows shims:

```bash
command -v node npm bun
readlink -f "$(command -v node)"
readlink -f "$(command -v npm)"
readlink -f "$(command -v bun)"
```

None of those resolved paths may start with `/mnt/c/`. Then use isolated prefixes:

```bash
npm_prefix="$(mktemp -d)"
npm install --prefix "$npm_prefix" --global capybara-code@alpha
"$npm_prefix/bin/capy" version

bun_global="$(mktemp -d)"
bun_bin="$(mktemp -d)"
bunfig="$(mktemp)"
printf '[install]\nglobalDir = "%s"\nglobalBinDir = "%s"\n' "$bun_global" "$bun_bin" > "$bunfig"
bun install "--config=$bunfig" --global capybara-code@alpha
"$bun_bin/capy" version
rm -f "$bunfig"
```

Use one package manager for the final global install, never both:

```bash
npm install --global capybara-code@alpha
# or
bun install --global capybara-code@alpha
```

Confirm `capy version` and `capy help`. Upgrade later with the same package manager used for installation.

## Remove legacy local wiring

Before the final global install, preview and then apply the conservative Windows cleanup script:

```powershell
bun run legacy:cleanup
bun run legacy:cleanup -- -Apply
Get-Command capy -All
```

It removes only verified old `capy` source shims under `%USERPROFILE%\.bun\bin`, the verified manual install at `%LOCALAPPDATA%\Programs\capybara-code`, and the matching `capybara-code\bin` User PATH segment. It preserves Bun's own `%USERPROFILE%\.bun\bin` PATH entry.

WSL can also have an old manual Capybara installation and source aliases. From a native WSL shell, preview and then apply the verified cleanup:

```bash
bun run legacy:cleanup:wsl
bun run legacy:cleanup:wsl -- --apply
type -a capy
type -a cbc
```

The script removes only the exact legacy install at `~/.local/lib/capybara-code` and its matching `capy` PATH/alias lines in `~/.bashrc`. `/usr/bin/cbc` is the unrelated Coin-OR program and must remain untouched.

## Register the checkout as capy-dev

The checkout never owns the public `capy` command. In each development environment that needs the source CLI:

```bash
bun run dev:link
capy-dev version
# later, when no longer needed
bun run dev:unlink
```

The registration is native to the current operating system: run it once from Windows Bun and, separately, from native WSL Bun. The wrapper validates any existing shim before replacing or removing it, so it never overwrites an unrelated global command.

After the cleanup and development registration:

```powershell
Get-Command capy -All
Get-Command capy-dev -All
```

```bash
type -a capy
type -a capy-dev
```

`capy` must resolve only to the published install (or be absent before it is installed); `capy-dev` must resolve to the development shim that launches this checkout.
