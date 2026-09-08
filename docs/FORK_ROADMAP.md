# Ordered fork roadmap

The canonical backlog is [roadmap issue #1](https://github.com/kaceper11/monocode/issues/1). Read [the fork contract](FORK.md) and [agent instructions](../AGENTS.md) before implementation. Issues define outcomes, dependencies and acceptance; implementing agents choose the smallest maintainable design after checking current source.

## How to work through it

Start with #2. Performance baselines and the host/runtime spike come early because they inform later work. The sequence is the default order; the hard dependencies below allow independent work once its prerequisites are met. Links in each issue include detailed acceptance and source starting points. Optional SSH is outside the required daily-driver gate.

A useful slice can ship before the entire roadmap is complete. The final acceptance issue is a rolling record as well as a full-roadmap gate. Do not let a partially configured later integration block local agents or Git.

## 01 - Foundations and core workflow

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 01 | [#2: Isolate fork app identity, local data, and release/update configuration](https://github.com/kaceper11/monocode/issues/2) | None |
| 02 | [#3: Establish reproducible performance and compatibility baselines](https://github.com/kaceper11/monocode/issues/3) | [#2](https://github.com/kaceper11/monocode/issues/2) |
| 03 | [#4: Verify execution boundaries for WSL and durable background work](https://github.com/kaceper11/monocode/issues/4) | [#2](https://github.com/kaceper11/monocode/issues/2) |
| 04 | [#5: Create a compact work hub with repository and issue groups](https://github.com/kaceper11/monocode/issues/5) | [#2](https://github.com/kaceper11/monocode/issues/2), [#3](https://github.com/kaceper11/monocode/issues/3) |
| 05 | [#6: Make issue, Git, PR and CI bindings independent per project](https://github.com/kaceper11/monocode/issues/6) | [#2](https://github.com/kaceper11/monocode/issues/2), [#4](https://github.com/kaceper11/monocode/issues/4) |
| 06 | [#7: Make agent state and task ownership accurate and actionable](https://github.com/kaceper11/monocode/issues/7) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4) |
| 07 | [#8: Send selected context to an explicit agent without losing provenance](https://github.com/kaceper11/monocode/issues/8) | [#7](https://github.com/kaceper11/monocode/issues/7) |
| 08 | [#9: Add configurable Implement, Review, Test and custom actions](https://github.com/kaceper11/monocode/issues/9) | [#8](https://github.com/kaceper11/monocode/issues/8) |

## 02 - Mixed-provider delivery

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 09 | [#10: Complete the GitHub issue-to-PR/checks workflow in the work hub](https://github.com/kaceper11/monocode/issues/10) | [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 10 | [#11: Add Jira issue sourcing independently of Git hosting and CI](https://github.com/kaceper11/monocode/issues/11) | [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 11 | [#12: Add Azure Boards work items as an independent issue source](https://github.com/kaceper11/monocode/issues/12) | [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 12 | [#13: Add Azure Repos pull requests, review threads and branch associations](https://github.com/kaceper11/monocode/issues/13) | [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8), [#10](https://github.com/kaceper11/monocode/issues/10) |
| 13 | [#14: Add Azure Pipelines CI independently of the PR provider](https://github.com/kaceper11/monocode/issues/14) | [#6](https://github.com/kaceper11/monocode/issues/6), [#10](https://github.com/kaceper11/monocode/issues/10) |
| 14 | [#15: Unify local changes, staging and basic review feedback](https://github.com/kaceper11/monocode/issues/15) | [#8](https://github.com/kaceper11/monocode/issues/8), [#10](https://github.com/kaceper11/monocode/issues/10) |
| 15 | [#16: Route review comments and failing CI to the owning agent](https://github.com/kaceper11/monocode/issues/16) | [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9), [#10](https://github.com/kaceper11/monocode/issues/10), [#15](https://github.com/kaceper11/monocode/issues/15) |

## 03 - Workspace depth

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 16 | [#17: Add indexed conversation history search with reliable resume links](https://github.com/kaceper11/monocode/issues/17) | [#3](https://github.com/kaceper11/monocode/issues/3), [#7](https://github.com/kaceper11/monocode/issues/7) |
| 17 | [#18: Strengthen worktree terminals and explicit terminal-to-agent context](https://github.com/kaceper11/monocode/issues/18) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 18 | [#19: Add contextual browser/preview support and send-to-agent capture](https://github.com/kaceper11/monocode/issues/19) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4), [#8](https://github.com/kaceper11/monocode/issues/8) |
| 19 | [#20: Coordinate cross-repository tasks and shared context](https://github.com/kaceper11/monocode/issues/20) | [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9) |

## 04 - Durable execution and automation

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 20 | [#21: Make agent execution durable across UI exit and reconnection](https://github.com/kaceper11/monocode/issues/21) | [#3](https://github.com/kaceper11/monocode/issues/3), [#4](https://github.com/kaceper11/monocode/issues/4), [#7](https://github.com/kaceper11/monocode/issues/7), [#18](https://github.com/kaceper11/monocode/issues/18) |
| 21 | [#22: Support Windows desktop with repositories, Git and agents inside WSL](https://github.com/kaceper11/monocode/issues/22) | [#4](https://github.com/kaceper11/monocode/issues/4), [#6](https://github.com/kaceper11/monocode/issues/6), [#18](https://github.com/kaceper11/monocode/issues/18), [#21](https://github.com/kaceper11/monocode/issues/21) |
| 22 | [#23: Add PR, assigned-story and CI watchers with bounded actions](https://github.com/kaceper11/monocode/issues/23) | [#6](https://github.com/kaceper11/monocode/issues/6), [#7](https://github.com/kaceper11/monocode/issues/7), [#9](https://github.com/kaceper11/monocode/issues/9), [#10](https://github.com/kaceper11/monocode/issues/10), [#16](https://github.com/kaceper11/monocode/issues/16) |
| 23 | [#24: Add one-shot and recurring scheduled actions](https://github.com/kaceper11/monocode/issues/24) | [#9](https://github.com/kaceper11/monocode/issues/9), [#23](https://github.com/kaceper11/monocode/issues/23) |
| 24 | [#25: Expose a bounded local CLI/API for the same workspace actions](https://github.com/kaceper11/monocode/issues/25) | [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9), [#21](https://github.com/kaceper11/monocode/issues/21) |
| 25 | [#26: Evaluate optional SSH execution using the established host boundary](https://github.com/kaceper11/monocode/issues/26) (optional) | [#4](https://github.com/kaceper11/monocode/issues/4), [#18](https://github.com/kaceper11/monocode/issues/18), [#21](https://github.com/kaceper11/monocode/issues/21), [#22](https://github.com/kaceper11/monocode/issues/22) |

## 05 - Integrated acceptance and upstream maintenance

| Order | Work item | Hard prerequisites |
| --- | --- | --- |
| 26 | [#27: Validate the integrated daily driver and rehearse upstream updates](https://github.com/kaceper11/monocode/issues/27) | [#2](https://github.com/kaceper11/monocode/issues/2), [#3](https://github.com/kaceper11/monocode/issues/3), [#5](https://github.com/kaceper11/monocode/issues/5), [#6](https://github.com/kaceper11/monocode/issues/6), [#7](https://github.com/kaceper11/monocode/issues/7), [#8](https://github.com/kaceper11/monocode/issues/8), [#9](https://github.com/kaceper11/monocode/issues/9), [#10](https://github.com/kaceper11/monocode/issues/10), [#11](https://github.com/kaceper11/monocode/issues/11), [#12](https://github.com/kaceper11/monocode/issues/12), [#13](https://github.com/kaceper11/monocode/issues/13), [#14](https://github.com/kaceper11/monocode/issues/14), [#15](https://github.com/kaceper11/monocode/issues/15), [#16](https://github.com/kaceper11/monocode/issues/16), [#17](https://github.com/kaceper11/monocode/issues/17), [#18](https://github.com/kaceper11/monocode/issues/18), [#19](https://github.com/kaceper11/monocode/issues/19), [#20](https://github.com/kaceper11/monocode/issues/20), [#21](https://github.com/kaceper11/monocode/issues/21), [#22](https://github.com/kaceper11/monocode/issues/22), [#23](https://github.com/kaceper11/monocode/issues/23), [#24](https://github.com/kaceper11/monocode/issues/24), [#25](https://github.com/kaceper11/monocode/issues/25) |

## Delivery notes

- The mixed-provider contract and acceptance matrix are in [FORK.md](FORK.md#independent-service-bindings). Provider settings must remain independent, including GitHub issues with Azure Repos/Pipelines and Jira with GitHub PRs plus Azure Pipelines.
- Existing upstream features must be reused or verified before adding duplicates. The bootstrap baseline is upstream 0.1.38 at `537ca054a215a18ece577827090e1a330fd45bad`. Source anchors in issues are discovery aids, not an exhaustive current audit.
- Runtime/WSL feasibility occurs early; broad runtime extraction happens only when its implementation issue is selected. Simple actions and groups do not require a daemon rewrite.
- Browser preview/capture and browser automation are different capabilities; preserve platform-specific fallback and security boundaries. Terminal work extends MonoCode's existing terminal.
- Scheduled/watcher automatic actions are opt-in and bounded. UI-exit persistence must be tested before claiming background execution.
- Measure performance on representative release builds and label provider/hardware gaps honestly. Tests on mocks or a hosted build alone do not prove live integration.
- Preserve full upstream history. [The maintenance flow](FORK.md#upstream-compatible-development) uses an integration branch and a reviewed merge, never a forced sync that drops fork changes.
- Diri, Waku and TUICommander references are for selective learning; the fork contract records exact licence caveats.

This index is the bootstrap ordering. If an implementing agent splits or resequences work, update the linked dependencies and this index together. Avoid maintaining duplicate detailed specifications here; the issue bodies are the source for each work item's acceptance.
