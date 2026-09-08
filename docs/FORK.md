# MonoCode fork: product and maintenance contract

This is [kaceper11/monocode](https://github.com/kaceper11/monocode), a normal GitHub fork of [hardbeat920/monocode](https://github.com/hardbeat920/monocode). Initial baseline: `537ca054a215a18ece577827090e1a330fd45bad` (upstream 0.1.38), inspected 2026-09-08. Bootstrap adds guidance and a backlog only; it does not implement the planned capabilities or certify upstream performance.

## What we are building

A clean, fast workspace for supervising coding work from task to review and delivery. Preserve MonoCode's visual character and structured conversation flow. Make the next action and the agent that owns the work obvious. Add capabilities gradually inside that workflow: repository and issue groups, Git/worktrees/review, targeted context, configurable actions, independent ticket and delivery integrations, searchable conversations, terminal/browser tools, shared context, watchers, and schedules.

Do not turn this into a plugin collection or rebuild a general-purpose IDE. Use the existing implementation where it is adequate. Optional integrations and automation should incur no recurring work until configured/enabled. Codex is the primary pilot provider; preserve other existing agent integrations and validate at least one other provider for shared lifecycle changes. Product decisions and implementation choices remain with the agent handling each bounded issue, subject to the outcomes below.

## Independent service bindings

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

## Upstream-compatible development

- Keep full upstream history; `main` is the fork's integration branch. No history replacement, permanent rebasing of shared main, or forced sync that discards fork changes.
- `origin` means this fork; `upstream` means hardbeat920/monocode. The initial local checkout sets `remote.pushDefault=origin`, `push.default=simple`, and a disabled upstream push URL. These settings are local and must be repeated in fresh clones when desired.
- Work on focused feature branches from fork main and target PRs at this fork. Add fork-owned documentation/configuration in clearly named locations and keep existing runtime changes small. Do not create an all-encompassing fork abstraction or duplicate every upstream module.
- Upstream already has web/Rust checks and macOS/Windows/Linux CI. Reuse them. Revalidate tests, migrations, lifecycle, and the mixed-provider smoke matrix after merges.
- Review upstream periodically and before a major feature; use an integration branch and merge the chosen upstream commit. Do not auto-resolve conflicts in favor of either side. Preserve both sets of behavior. If upstream adds our feature, converge and retire duplicate code after validation.
- Keep app identity, local data, credentials, update endpoints, signing, and release authority distinct before installing a fork build alongside stock MonoCode. The first implementation issue owns this. This bootstrap publishes no tags or binaries and configures no signing or update secrets.
- Upstream contribution policy currently pauses new coding-agent adapters. Respect that for upstream submissions. Fork ticket/PR/CI connectors are a different concern. Submit upstream fixes only when the user asks; a fork PR is not an upstream PR.

Example maintenance flow (run from the fork; choose a fresh branch name and review the fetched target):

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

These are research leads inspected on 2026-09-08, not assertions that the fork implements them. Recheck current source and exact licences when implementing.

| Reference | Useful behavior to evaluate | Apply selectively |
| --- | --- | --- |
| [Diri](https://github.com/cristicretu/diri), [remote architecture](https://github.com/cristicretu/diri/blob/main/diri/REMOTE_PORT.md) | Persistent session ownership, reconnect, execution-host paths, in-context Git review | Learn lifecycle and capability boundaries; do not port GPUI or assume macOS mechanisms work on Windows |
| [Diri performance record](https://github.com/cristicretu/diri/blob/main/diri/PERF.md) | Deterministic terminal fleets, retained-memory checks, packaged-build evidence | Borrow measurement discipline, not its workload-specific performance numbers |
| [Waku](https://github.com/egoist/waku), [product](https://waku.sh) | Structured provider events, queue versus steer, conversation-aware checkpoints, daemon/client boundary, contextual browser | GPL-3.0-only: independently implement behavior; browser/platform claims require explicit verification |
| [TUICommander feature inventory](https://github.com/sstraus/tuicommander/blob/main/docs/FEATURES.md) | Repository groups, smart prompts, PR/CI feedback, watchers, schedules, shared Git watching, terminal observability | Inspect current implementation and feature maturity; do not replicate its whole settings/plugin system |

Diri and TUICommander use Apache-2.0 at the project level. Any source reuse requires exact-file/dependency licence checks and notices; MIT on this fork is not permission to remove third-party obligations. Waku source is not a default copy source.

## Delivery standard

Each issue should leave a usable slice with a short explanation, appropriate tests, UI evidence where relevant, performance observations, and concrete remaining limitations. No optimistic time promises or comprehensive framework designs are required. A later agent should first inspect current upstream/fork state, decide the smallest implementation, and document only decisions that matter.

Roadmap order is a default sequence, not an instruction to build every feature immediately. Hard dependencies are stated per issue; independent later work can proceed when its prerequisites are met. Publication, live service writes, scheduled autonomous repairs, and remote access are separate capabilities with visible user intent and bounded execution.
