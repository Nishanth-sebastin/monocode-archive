# Address comments and Fix CI — focused implementation

Refs #16. Stacked on #14 at `59b99a0008703fe127b9faefccf680fc47c3b16e`, with user approval. No merges.

From Changes → Azure PR review → loaded unresolved threads, **Address comments · this page** opens the existing #8 destination picker with at most 20 selected threads. From Azure Pipelines → a current failed run → a failed job's bounded log, **Fix CI** opens the same review sheet. The sheet shows evidence, account/repository/revision, exact worktree/host and agent. Users can deselect evidence and edit the instruction. A source agent is preselected only when still eligible for that checkout; otherwise selection is required. New sessions use the existing agent/project controls.

**Send to owner**, **Queue for owner**, or **Start repair session** uses App's existing session-ID-targeted submit path. Busy owners queue a separate turn while the app remains open. Repair steering is disabled because the existing mid-turn transport cannot independently correlate repair completion. Generic messages retain their existing behavior. Queue evidence is sealed; cancel it and reopen the review sheet to change it.

Checkout commit/branch/remote, service account/PR or run revision, selected comments or log/attempt and agent identity are checked before accepting and immediately before the existing provider dispatch. Queued repairs repeat these checks when their turn starts. Changed evidence pauses the queue and requires refresh. Existing destination drafts and agent switches prevent repair delivery.

One bounded local recovery record per artifact/checkout prevents concurrent overlapping repairs and survives reload without storing logs or credentials. The record is linked from the evidence and conversation. Interrupted active records become uncertain after restart, never automatically retried. Users open the recorded conversation and explicitly acknowledge reconciliation before allowing another repair. Completion means the agent turn ended, not CI passing, comments resolved, push or merge. There is no automatic repair loop or provider write action.

## Scope and compatibility

This is the user-requested focused #16 slice using #8 and existing lifecycle/queue dispatch. It adds only the recipient/evidence safety needed here; broader #7 ownership reporting, #9 configurable actions and #15 review workflows remain separate open issues. No new provider adapters, dashboard, service, dependency or database migration. The local repair journal is limited to 100 metadata records; unreconciled requests are retained and a full journal blocks new delivery. Queue execution is app-open only, consistent with the existing queue.

A failed run's selected failing job/log is the initial CI repair unit. Review selection is bounded to the currently loaded page. Open additional pages/jobs explicitly; no bulk hidden downloads. The shared Azure read boundary performs account/repository/run revision checks; PR repairs additionally require a matching local source branch/head and remote. GitHub PR inspection and ordinary Git/agent paths are preserved.

## Validation

- 1,601 web tests and TypeScript pass after review fixes. Targeted tests cover changed commit/log/comment state, source ownership/provider changes, duplicate/uncertain records, explicit reconciliation, exact destination while another session is present, selection and rapid clicks.
- Native formatting, Clippy and 269 Rust tests (1 ignored) pass. Production web build passes. Fresh independent review and follow-up verification have no remaining findings. Parent follow-up found and fixed the asynchronous queue scheduling race; regression tests gate queue scheduling/timer dispatch and reject reservation during another check. Stale drafts disable send and retain refresh recovery.
- Browser interactions at 1100×760 use actual Changes/Azure views and AgentContextPicker. Other-checkout selection is rejected; deselection, editable instructions, keyboard submit and stale-evidence recovery were exercised in light/dark themes.
- A separate isolated full-App fixture registers disposable Codex/Claude adapters and native IO. With another session focused, two rapid clicks produce one Codex transport to `fixture-session` in `/fixture/repository`. A second pipeline repair remains queued while the first runs. Holding `azure_ci_context` through tab rerenders creates one pending check; releasing it produces exactly one additional transport. Stop changes the record to uncertain; retry does not add a third transport. A selected unresolved Azure thread also reaches the exact Codex owner through the real App submit path. Final fixture has no browser errors. These are manual checks with mocked IO, not authenticated provider/platform acceptance.

| View | Evidence |
| --- | --- |
| Before: CI log, same 1100×760 dark fixture | [Before](../images/azure-ci-log-dark.png) |
| Localized Fix CI entry | [After](../images/repair-ci-entry-dark.png) |
| Repair sheet, dark and light | [Dark](../images/repair-sheet-dark.png) · [Light](../images/repair-sheet-light.png) |
| Selected review comment | [Comments](../images/repair-comments-dark.png) |
| Uncertain dispatch prevents retry in the actual App | [Recovery](../images/repair-uncertain-app-dark.png) |


## Remaining acceptance

Live Azure Repos/Pipelines, native authenticated agent delivery (Codex plus another provider), native Windows/Windows→WSL and response under actual streaming require unavailable accounts/platforms. The user has no Azure DevOps account and is not expected to supply a credit card. Browser fixtures/local tests do not certify those boundaries. Representative native release CPU/memory/latency remains unmeasured; reads and retained data are bounded, but that is not performance acceptance. Hosted CI is subject to the repository's billing restriction.
