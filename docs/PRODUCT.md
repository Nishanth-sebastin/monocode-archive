# MonoCode product direction

This repository is [kaceper11/monocode](https://github.com/kaceper11/monocode), based on [upstream MonoCode](https://github.com/hardbeat920/monocode). Preserve its MIT licence, attribution and Git history while developing the product described below.

## What we are building

A clean, fast workspace for supervising coding work from task to review and delivery. Preserve MonoCode's visual character and structured conversation flow. Make the next action and the agent that owns the work obvious. Add capabilities gradually inside that workflow: repository and issue groups, Git/worktrees/review, targeted context, configurable actions, independent ticket and delivery integrations, searchable conversations, terminal/browser tools, shared context, watchers, and schedules.

Do not turn this into a plugin collection or rebuild a general-purpose IDE. Use the existing implementation where it is adequate. Optional integrations and automation should incur no recurring work until configured/enabled. Codex is the primary pilot provider; preserve other existing agent integrations and validate at least one other provider for shared lifecycle changes. Product decisions and implementation choices remain with the agent handling each bounded issue, subject to the outcomes below.

Browser capture (#19) must support an explicit screenshot of the chosen page/viewport, preview and optional instructions, then attach the image through #8 to either an existing session or a fresh session with a chosen project/worktree and agent provider. Preserve URL/origin and capture-time context without automatically exposing sensitive URL parameters. Do not substitute a link for an image or silently drop it for an unsupported agent. Native capture differences need a tested explicit fallback; no silent whole-desktop capture, extra browser daemon or Electron requirement.

Architecture follows DRY, KISS and YAGNI as detailed in [AGENTS.md](../AGENTS.md): clear ownership and testable boundaries, reuse of genuinely shared behavior, simple cohesive implementations, and no speculative layers. These principles must preserve the concrete mixed-provider/WSL requirements, safety and measured responsiveness. Agents choose the implementation and briefly explain consequential tradeoffs.

## Independent service bindings

Delivery priority (2026-09-08): establish the first usable Windows-to-WSL workflow early, then prioritize Jira/Azure Boards tickets and Azure Repos PRs/Azure Pipelines CI. Preserve existing GitHub support, but do not require additional GitHub features or grouping/browser polish before these integrations. Implement only the runtime boundary needed by the first WSL slice; full UI-exit persistence is a later extension.

One-shot and recurring scheduled tasks are first-class scope alongside provider watchers, ahead of secondary workspace expansion. The first scheduler may require the app to be open and must state that clearly. Include explicit targets/instructions, timezone and next run, pause/resume, run history, busy-target policy, missed-run handling and bounded execution. Example tasks: nightly repository tests, weekday review of assigned Jira/Azure Boards stories, and scheduled Azure PR/CI checks. Reuse configurable actions; time-based scheduling must not require provider-event watchers. Durable app-closed automation is accepted separately.

Each project can select its issue source(s), Git remote, PR source, CI source(s), accounts, and execution host separately. Explicit links associate a task with one or more repositories/worktrees and delivery artifacts. Issue groups may span providers and repositories; grouping must not redefine repository identity or execution ownership.

Required acceptance combinations as the relevant connectors land:

| Issues | Code / PRs | CI |
| --- | --- | --- |
| GitHub Issues | GitHub | GitHub Actions |
| GitHub Issues | Azure Repos | Azure Pipelines |
| Jira | Azure Repos | Azure Pipelines |
| Jira | GitHub | Azure Pipelines |
| Azure Boards | Azure Repos | Azure Pipelines |

Also exercise two projects using different accounts on the same provider and colliding short names/issue numbers. Preserve existing Linear integration; extending Linear beyond upstream is not required by this first backlog.

A Git remote cannot tell us the issue tracker. A PR provider cannot tell us the CI system. Bind runs/checks to the correct provider, repository, branch and commit; expose ambiguity or stale evidence rather than guessing. Credentials are account-scoped, stored through an appropriate local credential mechanism, and excluded from tracked configuration, logs, prompts, and URLs. A missing connector disables only its own capability. A configured issue provider must not be required to use local Git or agents.

Shared connection onboarding, read-only capability checks, reauthentication and disconnect behavior belong to #6; connectors add their own scopes and limitations. Credential ownership must identify the host: Windows-side service access and Linux Git/agent credentials may differ. Never silently copy secrets across hosts or substitute another account. Local disconnect is not necessarily provider-side revocation.

Azure PR inspection and repair handoff do not imply branch push or draft-PR creation. The first slice may use manual publication; adding in-app publication requires explicitly scoped actions and authority.

## Upstream-compatible development

- Keep full upstream history; `main` is the integration branch. No history replacement, permanent rebasing of shared main, or forced sync that discards our changes.
- `origin` means kaceper11/monocode; `upstream` means hardbeat920/monocode. The initial local checkout sets `remote.pushDefault=origin`, `push.default=simple`, and a disabled upstream push URL. These settings are local and must be repeated in fresh clones when desired.
- Work on focused feature branches from this repository's main and target PRs at kaceper11/monocode. Add project-specific documentation/configuration in clearly named locations and keep existing runtime changes small. Do not create an all-encompassing compatibility layer or duplicate every upstream module.
- Upstream already has web/Rust checks and macOS/Windows/Linux CI. Reuse them. Revalidate tests, migrations, lifecycle, and the mixed-provider smoke matrix after merges.
- Review upstream periodically and before a major feature; use an integration branch and merge the chosen upstream commit. Do not auto-resolve conflicts in favor of either side. Preserve both sets of behavior. If upstream adds our feature, converge and retire duplicate code after validation.
- Check relevant upstream overlap as part of each feature and normal maintenance; record selected SHAs, conflicts and compatibility evidence when syncing. This is not a separate prerequisite project or reason to delay product work.
- Preserve the app identity, data and disabled-release safeguards already introduced by PR #30. No further branding/setup project is on the delivery roadmap; concrete regressions should be fixed as bounded bugs. Publication remains separately authorized.
- Upstream contribution policy currently pauses new coding-agent adapters. Respect that for upstream submissions. Our ticket/PR/CI connectors are a different concern. Submit upstream fixes only when the user asks; a PR to this repository is not an upstream submission.

Example maintenance flow (run from this repository; choose a fresh branch name and review the fetched target):

```sh
git fetch upstream main
git switch main
git pull --ff-only origin main
git switch -c maintenance/upstream-YYYY-MM-DD
git merge --no-ff upstream/main
# Resolve conflicts, inspect the diff, run relevant checks and smoke tests.
git push -u origin maintenance/upstream-YYYY-MM-DD
gh pr create -R kaceper11/monocode --base main
```

No claim of conflict-free future merging is possible. The goal is to bound conflicts, preserve history, and make compatibility review routine. Keep merge evidence (upstream SHA, overlap, validations, unresolved limitations) in each sync PR.

## Performance is an acceptance condition

Establish a reproducible release-build baseline before optimizing. Suggested pilot: 3 repositories, 10 active agent sessions, 20 terminals with bounded noisy output, a large transcript history, a large diff, and enabled/disabled watcher comparisons. Include idle, minimized, foreground interaction, resize, session switching, and long-running memory growth. Synthetic workloads should not consume model tokens; a small live smoke complements them.

Measure startup, input/session-switch latency, scroll behavior, aggregate app-process memory, CPU, event rates and subprocess count. Separate agent/build resource use and state which memory metric is recorded. Choose numeric regression budgets after baseline measurement, record them, and avoid flaky timing assertions on arbitrary hosted runners. A visible performance regression blocks acceptance until fixed or an explicit measured tradeoff is agreed. Data must remain bounded over time, not merely fast on an empty workspace.

Features must not create one recursive watcher/poller per view, repeatedly scan every repo, mount all historical transcripts, or send raw high-volume logs through React on every chunk. Diagnose first; prefer batching, existing caches, incremental work and appropriate indexes over stack rewrites.

## Reference patterns, not a second codebase

These are research leads inspected on 2026-09-08, not assertions that this application implements them. Recheck current source and exact licences when implementing.

| Reference | Useful behavior to evaluate | Apply selectively |
| --- | --- | --- |
| [Diri](https://github.com/cristicretu/diri), [remote architecture](https://github.com/cristicretu/diri/blob/main/diri/REMOTE_PORT.md) | Persistent session ownership, reconnect, execution-host paths, in-context Git review | Learn lifecycle and capability boundaries; do not port GPUI or assume macOS mechanisms work on Windows |
| [Diri performance record](https://github.com/cristicretu/diri/blob/main/diri/PERF.md) | Deterministic terminal fleets, retained-memory checks, packaged-build evidence | Borrow measurement discipline, not its workload-specific performance numbers |
| [Waku](https://github.com/egoist/waku), [product](https://waku.sh) | Structured provider events, queue versus steer, conversation-aware checkpoints, daemon/client boundary, contextual browser | GPL-3.0-only: independently implement behavior; browser/platform claims require explicit verification |
| [TUICommander feature inventory](https://github.com/sstraus/tuicommander/blob/main/docs/FEATURES.md) | Repository groups, smart prompts, PR/CI feedback, watchers, schedules, shared Git watching, terminal observability | Inspect current implementation and feature maturity; do not replicate its whole settings/plugin system |

Diri and TUICommander use Apache-2.0 at the project level. Any source reuse requires exact-file/dependency licence checks and notices; MIT on this project is not permission to remove third-party obligations. Waku source is not a default copy source.

## Delivery standard

Use [local development instructions and isolation audit](LOCAL_DEVELOPMENT.md) for setup, build commands and the current platform verification limits.

Start actual development with #32 worktree management, #6 independent provider settings, then #22 Windows-to-WSL execution once its core prerequisites land. Agent status #7 is independent ready product work. Setup, source investigation, relevant before/after performance measurement and integration checks are steps within each feature, not standalone issues or reports to complete first. Administrative issues #2/#3/#4/#28/#27 are retired from the delivery queue, without certifying their outstanding checks.

Identify required test resources and missing access in the affected feature. Missing Windows/WSL hardware or provider credentials blocks only the relevant live acceptance, not unrelated coding. A hosted build or ready environment does not prove a feature works; do not publish secrets or private test payloads as evidence.

Accept the initial WSL slice against existing capabilities, then extend live coverage in each new connector/feature issue. Similarly, accept local app-open scheduling before service-specific schedules or durable execution. Track still-required platform/provider checks explicitly in the owning issue/PR rather than creating hidden dependencies on later features.

#9 owns the minimal action invocation lifecycle and bounded evidence reused by manual actions, #24 schedules, #23 watchers and #21 durability. Preserve run identity, target/host/account, authority, cancellation and uncertain dispatch across those paths; reuse existing dispatch/persistence rather than introducing separate job engines. Each watcher adapter needs its own connector; notification-only work does not wait for every connector or automatic repair.

Each issue should leave a usable slice with a short explanation, appropriate tests, UI evidence where relevant, performance observations, and concrete remaining limitations. No optimistic time promises or comprehensive framework designs are required. A later agent should first inspect current upstream and local state, decide the smallest implementation, and document only decisions that matter.

Roadmap order is a default sequence, not an instruction to build every feature immediately. Hard dependencies are stated per issue; independent later work can proceed when its prerequisites are met. Publication, live service writes, scheduled autonomous repairs, and remote access are separate capabilities with visible user intent and bounded execution.
