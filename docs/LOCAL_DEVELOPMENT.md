# Local development

Read AGENTS.md and the assigned issue first. The default Tauri configuration builds **MonoCode**, identifier `com.kaceper11.monocode`; no special override is required. Keep that identifier so this distribution retains its own local data and update identity.

## Setup and checks

Install Node.js 20+ (use a version supported by the locked Vite release), stable Rust with rustfmt/clippy, and the platform's Tauri prerequisites. On macOS desktop, Xcode Command Line Tools suffice. On Windows, use MSVC C++ Build Tools and WebView2; verify these on Windows rather than inferring support from a Mac build. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run check
npm run build
npm run tauri dev
```

If Rust was just installed, start a new login shell or source its `env` file before running Cargo. At least one provider CLI must be installed and authenticated for a real agent smoke; checks use fixtures and do not establish that authentication works in the app.

For a compiled development binary without launching or publishing:

```sh
npm run tauri build -- --debug --no-bundle
```

For an unsigned/ad-hoc local macOS app bundle, use `npm run tauri build -- --bundles app`. It is written beneath `target/release/bundle/macos/MonoCode.app`; open it there or copy that exact app into Applications. Windows testers can use `npm run build:windows` for the local NSIS installer, then verify its displayed application name, install path and app-data ownership. Neither path publishes a release. A fresh build's first compile can be slow; performance measurements must use release builds, not this debug path.

Record `git rev-parse HEAD`, tool versions, machine/OS, build command and any uncommitted changes with test evidence. Do not package secrets or a user profile in an artifact. Retain application data by default when uninstalling. Delete this application's data only after explicit backup/deletion approval, never another installation's profile.

## Isolation audit for issue #2

- Tauri's identifier owns app data/config/cache and WebView storage. The existing database, Linear token, checkpoints, notes and image storage use `app_data_dir()` and remain beneath the application's own namespace without schema migration. On macOS the app data root is `~/Library/Application Support/com.kaceper11.monocode`; on Windows it is `%APPDATA%\com.kaceper11.monocode`. Verify actual runtime paths on each platform.
- The custom macOS debug wrapper has a separate bundle name, plist identity and ad-hoc signing identity. Rust crate/binary and internal event names remain unchanged to minimize upstream conflicts; they are not separate installation namespaces.
- No single-instance/deep-link plugin or URI scheme registration was found in the audited Tauri configuration/backend. Re-audit when upstream introduces these. Secondary windows reuse configured window identity.
- Application orphan cleanup uses its own process marker and does not reap unmarked legacy Cursor agents. Stock MonoCode's own legacy cleanup is outside this application's control; do not claim this patch changes stock process-management behavior.
- Provider CLIs retain their own existing home/config/authentication mechanisms; this is not a credential sandbox for third-party CLIs. No stock app profile or credentials are copied/imported. In particular, quota refresh can use the provider's own credential store; live coexistence needs verification before claiming complete credential isolation.
- Updater endpoints and keys remain empty in the default development configuration, and updater artifact generation is off. The release workflow injects this repository's public GitHub Releases endpoint and public updater key without putting the private signing key in Git. Manual checks from development builds explain that published builds are required for updates.
- Reviewed upstream through `d4cd7df` (five commits after the bootstrap); changes include Windows updater/release workflow work. They were subsequently merged via upstream sync PR #31 and integrated into this branch.

## Publishing a release

Releases are built only for `kaceper11/monocode` tags. Keep the Tauri updater private key backed up outside Git and set it as the `TAURI_SIGNING_PRIVATE_KEY` Actions secret; set its public half as `TAURI_UPDATER_PUBKEY`. Apple signing and notarization use the existing optional `APPLE_*` secrets. Without them, the workflow deliberately publishes an ad-hoc-signed macOS build and the release notes disclose that limitation.

1. Run `npm run set-version -- <version>` and add the same version to `CHANGELOG.md`.
2. Merge the tested release change to `main`, then create and push `v<version>` from that exact commit.
3. Verify every platform job and the eight release assets, including `latest.json` and both updater signatures.
4. Before claiming automatic updates work, install release N and verify check, download, install and relaunch against a newer release on real macOS and Windows machines.

## Readiness evidence (2026-09-08)

Local host: Apple Silicon macOS, Node 22.23.2, npm 10.9.8, Rust/Cargo 1.98.1, rustfmt and clippy installed. `npm ci` installed the locked dependencies and reported no known vulnerabilities. The untouched baseline at `70a7280` passed `npm run check` (including 214 Rust tests) and `npm run build`; Vite reported existing chunk-size and mixed static/dynamic import warnings. These are not a measured responsiveness baseline.

Actual Windows/WSL hardware or authorized remote access and service test resources are still required for live platform/provider acceptance. No real Windows/WSL, Jira/Azure or authenticated in-app agent acceptance is implied by local checks. Historical setup issue #2 is retired; current limitations remain documented in their owning feature and release issues.

After the initial isolation changes, on macOS 26.6.2 arm64: `npm run check` passed (135 web test files / 1,396 tests, TypeScript, rustfmt, clippy and 215 Rust tests). `npm run tauri build -- --debug --no-bundle` built `target/debug/monocode` successfully without launching or installing it. UI launch/quit, notification identity, actual profile/coexistence and manual updater interaction remain unverified; no production app profile was deliberately opened or migrated. The default debug build is not a release performance benchmark.
