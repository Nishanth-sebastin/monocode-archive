# Azure Pipelines inspection — implementation and acceptance evidence

Refs #14. Source/fixture implementation; live Azure and Windows/WSL acceptance remains unverified.

## User journey

In the existing Changes area, **Azure Pipelines** sits beside the branch/PR row. **Add pipeline** accepts the definition URL and a checkout remote; a sole known remote is prefilled. The shared Azure connection owns credentials, and Build (Read) is checked independently of Boards/Repos capabilities. The service definition must identify the selected repository before the mapping is saved. Neither issue nor PR provider is changed.

Each configured source has its own run list, errors and external link. The view compares repository, branch and commit with the local checkout; an old success is labelled **Old commit**, not current success. A PR merge build is matched only when service metadata explicitly supplies the current source SHA and branch; otherwise it remains unverified. This does not assert that a local checkout equals the latest remote PR head. Multiple runs/sources never collapse into an overall green check.

Selecting a run loads no logs. **Load jobs** shows timeline records, states and attempt identities. **Load log** retrieves a bounded tail for the selected record/log/attempt; earlier/later pages are explicit. **Send log to agent** rereads the selected log/run/checkout evidence, then uses #8's existing destination picker. It prepares context, not a submitted repair or pipeline rerun. #16 will add the focused repair action.

Saved configurations and selected run summaries are bounded to 100 entries overall and 20 sources per work scope. They retain exact account, definition, repository, checkout, branch and session identity, but no logs. Saved status is labelled stale until refreshed. No CI polling or hidden log downloads occur while closed. Reads use the existing Rust blocking pool and Azure transport with a 20-second timeout, no redirects and bounded responses. Run/job pages contain at most 50 records; log reads contain at most 500 lines / 200 KB before sanitation and 32,000 characters afterwards. Common secret patterns, private-key blocks and terminal control sequences are removed; this is not a guarantee against every possible secret, and the user reviews the excerpt before handoff.

## Validation

- Base: `feat/13-azure-repos` at `a5582409d922f704fbcd2eb04d14e4f822888776`, explicitly approved for stacked work without merging. #13 received a fresh independent review with no actionable findings.
- Upstream main remains `2d0a4bd693dbf03dd4508b463ed47fe3bec8d664`, already included in the base.
- Local web tests: 1,593 passing; TypeScript passes. Native formatting, Clippy and tests are checked with the existing commands; final results are recorded in the PR.
- Fresh independent review identified a sensitive-header spelling gap. The shared sanitizer now normalizes separators before matching; regression assertions cover `X-Api-Key`, `API_KEY`, `private_key` and `Connection-String`. The reviewer verified the fix with no remaining findings. All three focused native CI tests pass after the fix.
- Regression coverage includes old successes versus current commits, PR merge refs without proof, cancellation/unknown states, independent denied sources, exact log/attempt handoff, repeated clicks, stale-run rejection, multiple account/worktree/session mappings, and native Git head/remote changes in an isolated test repository. The new CI sibling key and unchanged-revision selection preservation have regression checks.
- Browser fixture at 1100×760 uses the actual Changes, CI and Modal components with disposable mocked native IO. Mouse and keyboard exercised run selection, job/log loading and #8 context request; readback contains the exact account, GitHub repository, checkout, session, run revision, task/attempt/log and line range. A denied second source remains independent. No dialog horizontal overflow was observed.

| View | Evidence |
| --- | --- |
| New entry point, dark | [Screenshot](../images/azure-ci-summary-dark.png) |
| Current failure, old success and independent denied source, dark | [Screenshot](../images/azure-ci-runs-dark.png) |
| Selected job/log/attempt, dark | [Screenshot](../images/azure-ci-log-dark.png) |
| Same selected log, light | [Screenshot](../images/azure-ci-log-light.png) |

The shared Modal now supports opt-in keyboard containment; Azure PR review and CI use it. Existing dialogs keep their previous default. Existing PR rendering, local Git actions and provider lifecycles are otherwise preserved. No new dependencies or schema migration were added; prior shared Azure configuration remains readable.

## Remaining acceptance

- Live Azure Repos + Pipelines and GitHub PR + Pipelines, including genuine merge-ref metadata, new PR heads, reruns/parallel jobs, cancelled runs, pagination and restricted log access, require an authorized existing Azure organization. The user has no Azure account and is not expected to supply a credit card for development testing.
- Ordinary native-app/provider preparation, real Windows UI → WSL operation and responsiveness during real agent streaming remain unverified. Native local Git tests and browser fixtures do not prove those boundaries.
- Representative native release CPU/memory/latency has not been measured. Bounded/on-demand design and a successful web build are not performance acceptance.
- Hosted CI is subject to the repository's GitHub billing/spending restriction; inspect the actual PR run state.
- Historical timeline-attempt logs, unsupported repository types and oversized content use Open in Azure. No automatic writes, reruns, pipeline edits, pushes or merges are exposed.

API references: [Build list](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1), [definition metadata](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/definitions/get?view=azure-devops-rest-7.1), [timeline records and attempts](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/timeline/get?view=azure-devops-rest-7.1), [bounded log ranges](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/get-build-log?view=azure-devops-rest-7.1).
