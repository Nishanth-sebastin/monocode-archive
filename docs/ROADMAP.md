# Product development roadmap

The canonical backlog is [GitHub roadmap #1](https://github.com/kaceper11/monocode/issues/1). Read AGENTS.md and docs/PRODUCT.md for engineering constraints. Issue numbers are stable; title prefixes now order actual product development, not setup or research. Retired order 02 remains an intentional gap so existing issue references do not need a cosmetic renumbering sweep.

Start with **#32 worktree management** and **#22 Windows-to-WSL execution**. With those foundation branches in place, **#7 agent status is the next active product slice**, followed by #8 targeted handoff. Continue Jira/Azure tickets and delivery, then schedules/watchers. The first WSL slice does not wait for a full daemon or terminal redesign.

Each issue delivers working behavior. Research, performance measurement, tests, host-boundary decisions and credential setup are implementation steps inside that feature, not separate prerequisite projects. Preserve the current app identity and upstream history; no additional branding/setup work is planned.

Each real connector owns its smallest usable connection flow; later capabilities for the same service reuse it. Ticket providers (GitHub, Azure Boards, Jira, existing Linear), Git remotes, PR providers (GitHub/Azure Repos), CI providers (Actions/Azure Pipelines) and agent accounts remain independently selectable. Preserve the compact UI and existing provider behavior.

## 01 - Worktrees, WSL and agent handoff

| Order | Development issue | Hard prerequisites |
| --- | --- | --- |
| 01 | [#32: Create, switch and safely remove Git worktrees](https://github.com/kaceper11/monocode/issues/32) | None |
| 03 | [#22: Run repositories, Git and coding agents inside WSL from Windows](https://github.com/kaceper11/monocode/issues/22) | [#32](https://github.com/kaceper11/monocode/issues/32) |
| 04 | [#7: Show accurate agent status and task ownership](https://github.com/kaceper11/monocode/issues/7) | None |
| 05 | [#8: Send selected files, changes, images and tasks to an agent](https://github.com/kaceper11/monocode/issues/8) | [#7](https://github.com/kaceper11/monocode/issues/7) |
| 06 | [#9: Run configurable Implement, Review, Test and custom actions](https://github.com/kaceper11/monocode/issues/9) | [#8](https://github.com/kaceper11/monocode/issues/8) |

## 02 - Jira and Azure DevOps delivery

| Order | Development issue | Hard prerequisites |
| --- | --- | --- |
| 07 | [#11: Browse Jira tickets and start linked coding work](https://github.com/kaceper11/monocode/issues/11) | [#8](https://github.com/kaceper11/monocode/issues/8) |
| 08 | [#12: Browse Azure Boards tickets and start linked coding work](https://github.com/kaceper11/monocode/issues/12) | [#8](https://github.com/kaceper11/monocode/issues/8) |
| 09 | [#13: Show Azure Repos PRs, review threads and branch associations](https://github.com/kaceper11/monocode/issues/13) | [#8](https://github.com/kaceper11/monocode/issues/8) |
| 10 | [#14: Show Azure Pipelines status and failure logs independently of PR hosting](https://github.com/kaceper11/monocode/issues/14) | None |
| 11 | [#15: Use local diffs, staging and review comments with agents](https://github.com/kaceper11/monocode/issues/15) | [#8](https://github.com/kaceper11/monocode/issues/8) |
| 12 | [#16: Ask the owning agent to fix review comments and failing CI](https://github.com/kaceper11/monocode/issues/16) | [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9), [#13](https://github.com/kaceper11/monocode/issues/13), [#14](https://github.com/kaceper11/monocode/issues/14), [#15](https://github.com/kaceper11/monocode/issues/15) |

## 03 - Scheduled automation and durability

| Order | Development issue | Hard prerequisites |
| --- | --- | --- |
| 13 | [#24: Run one-shot and recurring scheduled actions](https://github.com/kaceper11/monocode/issues/24) | [#9](https://github.com/kaceper11/monocode/issues/9) |
| 14 | [#23: Watch assigned tickets, PR feedback and CI changes](https://github.com/kaceper11/monocode/issues/23) | [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9) |
| 15 | [#21: Keep agent execution running across UI exit and reconnect](https://github.com/kaceper11/monocode/issues/21) | [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9), [#22](https://github.com/kaceper11/monocode/issues/22) |

## 04 - Workspace features and low-priority extensions

| Order | Development issue | Hard prerequisites |
| --- | --- | --- |
| 16 | [#5: Organize repositories and tickets into compact groups](https://github.com/kaceper11/monocode/issues/5) | None |
| 17 | [#10: Complete GitHub ticket, PR and checks workflows](https://github.com/kaceper11/monocode/issues/10) | [#5](https://github.com/kaceper11/monocode/issues/5), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 18 | [#17: Search indexed conversation history and reopen sessions](https://github.com/kaceper11/monocode/issues/17) | [#7](https://github.com/kaceper11/monocode/issues/7) |
| 19 | [#18: Use worktree terminals and send selected output to agents](https://github.com/kaceper11/monocode/issues/18) | [#8](https://github.com/kaceper11/monocode/issues/8) |
| 20 | [#19: Capture browser screenshots and send to fresh or existing agents](https://github.com/kaceper11/monocode/issues/19) | [#8](https://github.com/kaceper11/monocode/issues/8) |
| 21 | [#20: Coordinate cross-repository tasks and shared context](https://github.com/kaceper11/monocode/issues/20) | [#5](https://github.com/kaceper11/monocode/issues/5), [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9) |
| 22 | [#25: Control workspace actions through a bounded local CLI/API](https://github.com/kaceper11/monocode/issues/25) | [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9), [#21](https://github.com/kaceper11/monocode/issues/21) |
| 23 · Low priority | [#33: Save agent defaults and select multiple agent accounts](https://github.com/kaceper11/monocode/issues/33) | [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9) |
| 24 · Low priority | [#26: Run a worktree, terminal and agent on an optional SSH host](https://github.com/kaceper11/monocode/issues/26) | [#18](https://github.com/kaceper11/monocode/issues/18), [#21](https://github.com/kaceper11/monocode/issues/21), [#22](https://github.com/kaceper11/monocode/issues/22) |

## Slice and acceptance boundaries

- #32 first delivers local create/list/switch/remove and session associations. Ticket kickoff reuses #8 and the relevant connector as it lands; it does not hold the core worktree slice hostage. Rich bulk cleanup is later, while single-target safety is mandatory immediately.
- #22 implements the actual Windows/WSL boundary; #21 extends execution lifetime later. No standalone architecture spike is required.
- Jira #11 owns the Jira connection it needs. The first implemented Azure issue among #12–#14 establishes one shared Azure DevOps connection reused by Boards, Repos and Pipelines; later connectors extend capabilities without adding another login. GitHub continues to use its existing CLI identity and Linear keeps its existing connection. #9 owns action dispatch/run identity.
- Watchers require their respective connector, not all connectors. Automatic repair additionally requires #16 and explicit authority. Schedules may initially require the app to remain open.
- #19 includes real screenshot image delivery to fresh or existing agents, with capability checks and Windows/WSL attachment handling.
- #33 saved model/plan/reasoning defaults and multiple agent accounts, and #26 SSH, are low priority. Neither blocks core delivery.
- Performance, regression tests, UI checks, recovery and upstream compatibility are per-feature acceptance. Missing Windows/WSL hardware or service accounts must be documented in the affected feature; do not claim live acceptance from fixtures or block unrelated coding.

## Retired administrative tickets

#2 (repository setup), #3 (standalone baseline), #4 (execution spike), #6 (standalone Connections cleanup), #28 (environment inventory), and #27 (final acceptance project) are removed from the delivery queue and dependency graph. Their history remains available; closure means superseded/not planned, not that unverified checks passed. Necessary safeguards and testing remain in AGENTS.md, docs/PRODUCT.md and each feature. No goal is activated by this roadmap update.
