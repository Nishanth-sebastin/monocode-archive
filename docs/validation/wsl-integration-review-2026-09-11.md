# WSL integration review — 2026-09-11

Original review (before implementation): reviewed `main` at `41acd7be44f4b24ebc8a6500e225974c24b55ae4` on macOS. This is a source review with local regression checks, not Windows/WSL acceptance. No product code was changed. The pre-existing `docs/IMPLEMENTATION_GOAL.md` was left untouched.

The most important defects are missing execution-context support in model discovery and a different environment for agent discovery versus terminals. The duplicate project badge is directly confirmed. Worktree placement has a concrete anchoring problem, but its Windows-specific manifestation remains unverified.

## Implementation and fresh review

Implemented on `fix/wsl-discovery-ui`, based on `41acd7be44f4b24ebc8a6500e225974c24b55ae4`.

- Findings 1–4: provider discovery and model lookup now carry the effective Linux checkout through catalogs, settings, history, defaults, and dispatch. Catalog requests have unique child identities, coalesced refresh, bounded retention, visible fallback/errors, and reconnect invalidation. Native preferences remain compatible; WSL defaults are distribution-specific. OpenCode remains explicitly unsupported on WSL.
- Finding 2: the bridge captures the Linux user's interactive login-shell environment once, filters Windows-mounted executable paths, and delivers that environment privately over the supervisor stdin handshake. Shell-managed scripts and their interpreters use the same environment. Explicit reconnect refreshes it.
- Findings 5–8: one compact WSL badge per project, distribution available in its accessible label/tooltip/details, worktree popup anchored to the invoking button, themed execution selector with keyboard/focus coverage, and display-only Linux path formatting.
- Finding 9: Git mutations identify the affected checkout; mounted Git consumers filter unrelated events. Repository-family refresh follows the affected family and drains distinct pending refreshes. Unknown/global events still refresh all families. Summary cache entries are released after unmount.
- Performance follow-up: warm connection reuse retains canonical-directory validation but avoids distribution enumeration and repeated Git-version probes. Resolver environment preparation is cached. All-provider discovery still shares the bridge command lane; no latency, CPU, or memory improvement is claimed without release measurements.

The requested fresh independent agent review found missed worktree-context consumers, malformed accessibility labels, incomplete Git-event consumers, and a dropped live-history worktree path. These were fixed and reviewed again. The reviewer reported no remaining actionable findings in the follow-up diff; this is not Windows acceptance.

Validation after implementation:

- `npm run check:web`: TypeScript and **1,746 tests in 185 files passed**.
- `npm run check:rust`: rustfmt, Clippy with warnings denied, and **272 tests passed, 1 ignored** (opt-in release measurement).
- Added coverage for concurrent native/Ubuntu/Debian and worktree catalogs, reconnect/error recovery, shell-managed executable/interpreter environment, scoped/global Git refresh including queued repository-family events, live/persisted worktree history, covering-index query, and themed selector keyboard focus.
- Chromium on macOS using real React components and fixture-only Tauri responses: inspected the 200px project rail, one badge, last-child worktree menu at the viewport edge, and opened themed execution-location listbox. This validates the local browser fixture, not Windows WebView or live WSL.
- Fetched current upstream main (`ef690a27a330994847deb08ae8f85366fa63a781`); inspected relevant changed seams for overlap. No upstream merge, commit, push, or PR was made. Pre-existing `docs/IMPLEMENTATION_GOAL.md` remains untouched.

Compatibility: session history exposes an already-persisted optional `worktree_cwd` field. Migration 13 rebuilds only the summary covering index, preserving session data and avoiding transcript table reads. No credentials or sessions are moved between installations.

Still unverified: real Windows/WSL launch and authenticated providers, multiple live distributions, Windows scaling/WebView behavior, shutdown/reconnect during approvals, and representative release performance. The separate capability gaps listed below (OpenCode transport, Linux folder browsing, Azure automatic checkout, connection release, browser/editor extensions) are not implemented by this repair.

## Original ranked findings


### 1. P1 — WSL never refreshes live provider model catalogs

**Confirmed in source.** `ModelPicker.tsx:148` and `SecondOpinionButton.tsx:182` return before catalog refresh for any WSL cwd. `models.ts:283` always returns bundled models for WSL. `preferredModelId` at line 583 returns the built-in default before consulting saved preferences. Consequently installed/authenticated Linux providers can offer models that never appear, while obsolete or unavailable bundled choices remain visible.

This cannot safely be fixed just by deleting the guards. `registry.ts:55,252` exposes a context-free `refreshCatalog()` API, and the Codex, Claude, Cursor, Grok, Pi/omp and fx catalog implementations resolve the native binary and native home directory. Catalog overlays and in-flight discovery are also global per provider. Settings uses the same native-only lookup path.

There is an additional leak in Favorites: `ModelPicker.tsx:223` obtains the object through global `findModel(id)` and only checks whether that ID exists in the WSL list. A native overlay sharing an ID can therefore supply native metadata; an overlay omitting a bundled ID can hide that WSL favorite. `resolveModel`, model settings and native-ID lookups need the same context audit.

**Smallest repair:** carry cwd through the existing adapter refresh interface, binary resolution, probe launch, catalog storage and model lookup consumers. Scope in-flight IDs and results by provider and execution context, including project where configuration is project-dependent. Keep native defaults compatible; do not reuse Windows catalog results as Linux results. Mark fallback data and refresh failures visibly. Invalidate relevant discoveries after reconnect or an explicit refresh.

**Regression:** native Windows, Ubuntu and Debian return different model sets, including identical model IDs with different settings. Verify tabs, Favorites, default selection, second opinion and dispatch all use the selected context. Include project-specific configuration, failed discovery, cancellation, and concurrent probes without cross-cancellation.

### 2. P1 — Shell-managed CLI installations can be missed

**Locally reproduced; actual Windows environment unverified.** `wsl.rs:634` launches `/usr/bin/python3` directly through `wsl.exe --exec`. `wsl_bridge.py:185` searches a fixed list of home directories plus the bridge's PATH. It does not obtain shell-initialized nvm/fnm paths. In contrast, `wsl.rs:119` starts terminals with a login shell. The agent supervisor at `wsl_process.py:97` also inherits its direct-launch environment: finding a script does not ensure its `#!/usr/bin/env node` interpreter is available.

A temporary fixture placed an executable at `.nvm/versions/node/v22.0.0/bin/codex`. With PATH `/usr/bin:/bin`, the production resolver reported it uninstalled. With that directory added to PATH, the same resolver found it. The fixture did not invoke an authenticated agent or alter the user's installation.

**Smallest repair:** resolve the intended Linux user's tool environment once through a bounded, explicit shell-environment discovery path and reuse it for resolution, probes and agent launches. Preserve absolute argument passing, selected distribution identity and exclusion of Windows executables. Do not scan all installed Node versions and arbitrarily select the newest. Report environment discovery failures distinctly.

**Regression:** standard Linux binary, user-local install, nvm and fnm setup, executable script with missing interpreter, spaces/Unicode, and Windows-only CLI. Verify discovery and actual launch agree. Shell output must not corrupt the bridge protocol; environment values must not be logged or sent to the frontend.

### 3. P2 — Reconnect leaves stale provider availability and misleading errors

**Confirmed in source.** `availability.ts:145` converts every resolver failure into `false`, including disconnection and queue failures. It caches the result for 30 seconds. `harnessUnavailableHint` then tells the user to install the Linux CLI. `connectWslProject` does not invalidate availability, and its callers in `App.tsx:3481` and `WslBadge.tsx:99` do not force a reprobe. Successful reconnect can leave installed providers disabled until another picker open after the TTL. An already-open picker has no TTL timer to refresh itself.

**Smallest repair:** preserve discovery failure categories at the existing availability boundary; invalidate only the affected distribution on disconnect/reconnect and refresh when the picker needs it. Retain request coalescing and native-host isolation. Provide Retry for transient failures instead of an installation instruction.

**Regression:** fail a probe because the bridge is disconnected, reconnect within 30 seconds, and verify the installed provider becomes usable immediately. Test queue failure separately from missing executable and unsupported transport.

### 4. P2 — Provider settings silently describe Windows while working in WSL

**Confirmed in source.** `SettingsView.tsx:1698,1757` calls availability and model helpers without cwd. Its copy says the chosen model is what new conversations use, but WSL's `preferredModelId` ignores that saved default. This is an internally inconsistent settings workflow even when native settings are intentional.

**Smallest repair:** extend the existing provider settings with explicit execution-location context and pass that context through discovery/default operations. Keep global visibility preferences clearly separate from host-specific installation/model state. Reuse the catalog repair above; do not introduce a second provider registry.

**Regression:** with Codex installed only in Ubuntu, settings and the Ubuntu picker agree. Switching to Windows changes the displayed installation state and never silently installs, logs in or changes an unrelated host's defaults.

### 5. P2 — Project rows render two WSL badges

**Confirmed in source.** `ProjectRail.tsx:1190,1242` renders `WslBadge` twice inside the same fixed-height project row. Both badges are non-shrinking, taking width from the project name and competing with worktree and hover actions. The same issue is dormant for native projects because the badge returns null.

**Smallest repair:** keep a single compact badge after the project label, reserve action space, and allow the label to truncate. Preserve the badge's environment popover and accessible name.

**Regression:** one environment button per WSL project; none for native projects. Long distribution/project names at the narrow rail width must leave worktree and menu actions reachable by pointer and keyboard.

### 6. P2 — Worktree details anchor to the project family, not the invoking row

**Confirmed anchoring behavior; Windows-specific visual cause still provisional.** `ProjectRail.tsx:925,978,1064` uses one ref around the parent and all expanded children. Child details/cleanup opens the same right-side popover anchored at the family's top. The generic `Popover` already uses a body portal and viewport placement; adding a Windows-only coordinate offset is not justified.

**Smallest repair:** remember the actual invoking element for New worktree, child details and Manage worktrees; pass it to the existing Popover. Restore focus there on dismissal. Change shared placement math only if a focused reproduction demonstrates a separate defect.

**Regression:** open details from the first and last child of a large expanded family; verify anchoring while scrolling, resizing and near viewport edges. Also check parent creation, hidden-worktree management, asynchronous content growth, and 100/125/150/200% Windows scaling. macOS remains a regression target.

### 7. P2 — Execution-location menu does not use the app's themed menu surface

**Confirmed implementation difference; native menu appearance not reproduced here.** `WslProjectDialog.tsx:136` uses a native select. Styling the closed control does not provide the app's existing popover presentation for the opened platform menu, matching the reported inconsistency.

**Smallest repair:** reuse the existing themed picker/Popover interaction and tokens, preserving a labelled selection control, keyboard navigation, focus management and disabled/loading/error states. Integrate it with the modal focus trap rather than adding a UI dependency.

**Regression:** local PC, multiple distributions, unavailable saved distribution, discovery failure/retry, Escape, arrow keys, Enter, Tab and focus restoration, in both themes. Switching locations must preserve appropriate entered values and never open the wrong host.

### 8. P2 — WSL path presentation is inconsistent and sometimes duplicates the host

**Confirmed in source.** `paths.ts:70` already supplies `prettyCwd`, but several surfaces display raw identities:

| Surface | Current source | Problem |
| --- | --- | --- |
| Sidebar project picker | `Sidebar.tsx:1676,1731,1824` | Raw UNC paths in titles |
| Working-copy row | `ProjectRail.tsx:1016` | Raw UNC path plus a separate host line |
| Removal confirmation | `WorktreePicker.tsx:286` | Raw repository cwd alongside formatted destination |
| Worktree list | `WorktreePicker.tsx:756` | `prettyCwd` already includes WSL host, then host is appended again |
| File tree | `FileTree.tsx:673,959` | Raw UNC titles |

**Smallest repair:** reuse `prettyCwd` for complete display strings; where a host badge already exists, display the Linux path separately. Show full paths in details/tooltips and keep destructive destinations readable. Do not alter canonical identities, Linux case sensitivity, stored cwd or executable arguments. Distinguish copying a Linux path from copying a Windows-accessible path where both actions are offered.

**Regression:** Ubuntu and Debian with identical Linux paths, WSL UNC aliases, mixed native/WSL sessions, long paths and Unicode. Assert no duplicated host string and unchanged dispatch identities.

### 9. P2 — One Git change refreshes unrelated mounted projects

**Confirmed work amplification; latency impact unmeasured.** `fs.ts:305` emits an unscoped global event. Every mounted `useProjectDiffStats` entry subscribes at line 84 and refreshes its own checkout on that event. `git_diff_stats_for` at `fs.rs:828` performs multiple Git queries and untracked-file accounting. WSL Git operations share the serialized command lane (`wsl.rs:414`), so unrelated summary work competes with foreground Git and CLI probes in the same distribution. It also happens on focus/visibility resumption.

**Smallest repair:** add optional affected-checkout identity to the existing Git-change event, update known mutation callers, and filter project-summary listeners. Retain an explicit global refresh for unknown/external changes. Reuse existing in-flight/pending coalescing; do not add another polling service.

**Regression:** with three mounted projects, mutating one refreshes that project's summary only; a deliberate global refresh reaches all. Handle aliases and same-repository worktree relationships deliberately. Count requests before/after under repeated mutations; measure Windows latency separately.

### 10. Performance follow-up — repeated project opens and all-provider probes

**Source-backed costs, not measured regressions.** Each WSL project selection calls `wsl_connect`, including already connected distributions. It enumerates distributions and validates both bridge lanes; each validation runs `git --version`. Availability refresh asks all live providers, and Pi/omp/fx resolution can run `--help` with a two-second timeout per candidate. These requests use the command lane. Frontend Promise.all does not make that lane parallel.

**Next step:** measure warm project switching and picker opening with installed/missing/slow CLIs. If material, reuse connected-host validation and batch discovery in the existing bridge; do not remove checkout existence validation or weaken executable checks. Bound any cache and invalidate it on reconnect/explicit refresh. Also profile per-request watchdog thread creation before considering a scheduler replacement.

## Explicit missing capabilities and preserved behavior

| Area | Current evidence and disposition |
| --- | --- |
| OpenCode | `wsl_bridge.py:179` explicitly rejects its HTTP transport. Treat this as unsupported, not a missing installation. A new WSL transport is a separate feature slice. |
| Linux folder browsing | Open-project dialog accepts a typed Linux path; Browse is for native Windows. An in-distribution folder picker would improve first use but is not needed to fix model discovery. |
| Azure PR automatic checkout | `azure_repos.rs:205` explicitly refuses automatic cloning in WSL and asks for a matching existing checkout. This is an intentional, visible feature gap. |
| Browser/editor integration | WSL badge says links open on Windows, no port forwarding is provided, and Linux editors should be opened from the terminal. Preserve that disclosure until a real integration exists. |
| Connection lifecycle | Four distributions maximum; no user-facing per-distribution disconnect/release path in the examined connection flow. Current recovery advises closing the app. Do not add a durable daemon for this. |
| Files/Git/worktrees | Linux-qualified Git routing, batched metadata, separate read lane, canonical worktree paths, atomic text replacement and guarded removal exist. Local tests exercise these paths; they do not certify every Windows boundary. |
| Attachments | Same-distribution Linux paths are preserved for the agent; cross-distribution paths are rejected; supported local files transfer through the bridge. Existing attachment checks passed. |
| Sessions/cancellation | Restore preserves exact checkout identity; the process supervisor binds cancellation to process start identity and boot identity. Bridge failures report uncertain completion instead of replaying writes. macOS tests substitute Linux-specific identity primitives. |

## Checks performed

- Focused path/model/popover/WSL/attachment/availability/repository-family tests: **51 passed in 7 files**.
- Additional provider protocol/lifecycle and repository-family hook tests: **116 passed in 9 files**. Despite filenames containing “Live”, these are local harness tests, not authenticated provider or Windows tests. The requested `useProjectDiffStats.test.ts` path did not exist; it contributed no tests.
- `cargo test wsl --lib`: **11 passed**. Unix bridge fixtures execute local processes; macOS substitutes `/proc`/pidfd behavior in supervisor checks.
- `cargo test worktree --lib`: **11 passed, 1 ignored**. The ignored test is the opt-in release inventory measurement.
- Production Python resolver fixture: missed nvm executable with minimal PATH; found the same executable with its directory on PATH.

No full web/Rust quality suite, release benchmark, Windows build, WebView interaction, live WSL, authenticated provider, remote Git write or deployment was performed. Those claims would exceed this source-only review. The focused checks pass because several missing behaviors are deliberately encoded today, including WSL fallback catalogs.

Structural discovery used the current indexed project and direct source verification. Relied-on production paths had matching coverage metadata and no recorded parse gaps; that is not proof of an exhaustive audit. This report covers the selected workflow seams and concrete findings, not a repository-wide security certification. No remote/upstream sync was performed.

## Ordered repair slices

1. **Discovery correctness:** execution-aware catalogs and lookups, consistent Linux environment, accurate probe errors/reconnect invalidation, and provider settings context. Preserve current adapters and add tests at their existing ownership boundaries.
2. **UI consistency:** duplicate badge removal, trigger-based worktree anchoring, themed execution picker and display-only path cleanup. Exercise narrow layouts and keyboard behavior before handoff.
3. **Targeted performance:** scope Git refresh first; establish warm-switch and discovery baselines before further caching/batching changes. Report app/backend/WebView costs separately from agent/build processes.
4. **Separate feature follow-ups:** OpenCode transport, Linux folder browsing, Azure automatic checkout, connection release and browser/editor extensions. Do not hide these gaps behind the repair's completion claim.

For any implemented slice run `npm run check:web` and/or `npm run check:rust` as appropriate. On real Windows, validate Ubuntu plus a second distribution, simultaneous native projects, spaces/Unicode, shell-managed CLIs, pending approval during shutdown, reconnect, session restore, file/diff/stage/test and worktree removal. Record Windows/WebView/WSL/distribution versions, scaling and release-build measurements before claiming acceptance.
