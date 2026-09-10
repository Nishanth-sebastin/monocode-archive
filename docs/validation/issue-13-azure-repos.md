# Azure Repos PR inspection — implementation and acceptance evidence

Refs #13. This is a draft implementation, not live provider/platform acceptance.

## User journey

Start in the selected session/worktree's existing Changes area. **Review Azure PRs** discovers actual Azure Boards artifact/hyperlinks and Jira remote issue links from the session's linked stories, then captured PR references and exact working-branch matches from configured Azure Git remotes. Story-linked PRs appear first with their provenance, repository, source/target branch and commit evidence. Several PRs may belong to the same story; a single complete, unambiguous result opens automatically, otherwise the user chooses. **Link another PR manually** is the fallback for a PR URL or HTTPS/SSH remote. No global provider selector or remote mutation is involved.

Discovery runs only when the review opens or the user refreshes it, in batches of two reads, with at most 20 stories/remote sources and 50 links per story. Limits and individual source failures are reported; denied story access does not hide branch matches. Git remote reads use the existing local/WSL dispatcher and strip credentials before returning URLs. GitHub/other-provider stories currently supply captured explicit Azure references, not a live provider development-panel query. Jira remote links do not imply access to app-specific development panels. PR and ticket providers remain independent.

**Choose another PR** switches the selected review without discarding other saved associations. Removing one saved link preserves the others for the same checkout/branch/session.

The saved row shows title/number, state, review attention and the saved revision. Open it, **Refresh PR**, and load threads, iterations, changed files, policies or PR statuses independently. Only an expanded thread mounts its markdown. Selected iteration files use the existing `UnifiedDiffView`. **Send thread to agent** and **Send file diff to agent** verify the PR revision and invoke #8's existing `AgentContextPicker`; preparation does not submit a prompt. Without a known source session the user must explicitly choose a destination. Returning to Changes retains the PR association; thread/page selection and entered link values survive closing the dialog within the app process.

Connection settings reuse General → Azure DevOps. Reconnect replaces the saved connection only after authentication and at least one requested read capability succeeds. A Code-only connection can inspect PRs without Boards access. Existing Boards configuration deserializes without migration and keeps its previous capability. Settings list verified capabilities; resource-specific permissions can still deny individual reads.

## Local verification (2026-09-10)

- Base: `origin/main` at `e27b4fa737c1fd351e14fc880ffc06a4aadfc578`, after #8 merged in PR #53. Worktree: `monocode-worktrees/issue-13-azure-repos`, branch `feat/13-azure-repos`.
- Upstream `main` was checked at `2d0a4bd693dbf03dd4508b463ed47fe3bec8d664`; that revision is already an ancestor of the feature base. Existing GitHub PR actions, shared review components and #8 are reused rather than replaced.
- Baseline `npm run check`: 1,577 web tests; 262 Rust tests passed, one existing ignored test.
- Final checks: 1,588 web tests across 167 files; 266 Rust tests passed, one existing ignored test; TypeScript, Rust formatting and Clippy passed. Discovery was followed by the complete `npm run check`, then `npm run check:web` after the final UI regression and draft-preservation guard.
- `npm run build`: passed. Vite still reports large chunks; a successful production web build is not a native release performance measurement.
- `git diff --check`: passed.

Focused tests cover HTTPS/SSH and legacy HTTPS identities, organization/project collisions, credential-bearing URL rejection, explicit account/repository/revision/page command arguments, bounded persistent summaries, exact WSL/local path and session separation, selected thread origins, page bounds, malformed summary/file responses, oversized/binary previews, legacy connection data, policy-error isolation, duplicate preparation, stale revision rejection, account changes, explicit destination selection, late lookup cancellation and entered-link recovery. Discovery tests cover multiple PRs per story, story-before-branch ordering, duplicate provenance, denied Jira reads, organization separation, credential redaction, multiple saved links, and automatic versus explicit selection.

## Interaction evidence

An isolated Chromium fixture rendered the actual Changes, Azure review, unified diff and #8 picker components at **1100 × 760**, with a 380 px Changes column, in existing light and dark themes. Native/provider IO and final preparation were mocked; no provider credentials, remote writes or agent prompts were used. This is browser/component interaction evidence, not ordinary native-app, Azure or WSL acceptance.

Exercised by mouse and keyboard: open Link PR, type the URL and submit with Enter, choose a candidate, reopen the saved association, refresh, expand a thread, load an iteration/change/file diff, load a denied policy independently, open #8's picker and prepare the selected diff in the chosen fixture conversation. The resulting context contained account, repository URL, exact checkout, source session, PR revision, iteration and base/source commits. A simulated revision change prevented handoff and retained the linked PR with a Refresh recovery message. The dialog had no horizontal overflow at the tested size. Mouse scrolling exposed the full diff and lower controls.

| Existing view / localized addition | Evidence |
| --- | --- |
| Before, dark Changes | [Screenshot](../images/azure-pr-before-dark.png) |
| After, dark Changes summary at the same size | [Screenshot](../images/azure-pr-summary-dark.png) |
| Thread context, dark | [Screenshot](../images/azure-pr-review-dark.png) |
| Multiple PRs for one story, dark | [Screenshot](../images/azure-pr-discovery-dark.png) |
| Multiple PRs for one story, light | [Screenshot](../images/azure-pr-discovery-light.png) |
| Same thread context, light | [Screenshot](../images/azure-pr-review-light.png) |
| Selected iteration diff using the existing renderer, light | [Screenshot](../images/azure-pr-diff-light.png) |

The updated fixture also exercised automatic story/branch discovery, keyboard selection of the second story PR, mouse switching to the first, and readback proving both PR associations remained scoped to the same checkout/session. Screenshots show two PRs for Story 7 and a separate branch-only match.

## Identity, bounded work and recovery

Associations are scoped to the exact checkout, branch and source session and contain the Azure organization, account ID, resolved project/repository IDs, PR number and source/target revision. Selection changes do not change tickets, Git remotes, checkout or CI settings. Raw provider URLs are never used as authenticated request targets. The shared app-host connection remains the credential owner, including when a checkout points at WSL.

Every detail read checks the account and exact PR identity; non-summary reads check the revision before and after loading. Each section has its own failure state and bounded page, so a denied policy does not suppress threads or Git work. PR status/policy evidence is explicitly separate from independently sourced CI.

There is no Azure polling while the review is closed and no eager detail loading. Reads run on the Rust blocking pool, with the shared 20-second timeout, redirects disabled and a 2 MiB response cap. Each detail/repository page contains at most 50 rows; discovery inspects at most 20 sources. Non-paged Azure thread/iteration/status endpoints are bounded by the transport and paged locally. File previews are capped at 100 KB / 5,000 lines per side and fetched by immutable iteration commits. Oversize or unsupported content offers the external Azure fallback. Saved summaries and transient draft/selection caches each retain at most 100 entries; persisted associations omit descriptions and thread bodies.

Remote diff snapshots disable the existing unscoped hunk/comment shortcuts; their explicit file handoff carries the owning PR identity and checks the revision first. Existing local/GitHub diff behavior keeps its previous default. Inspection does not publish branches, create PRs, write comments, resolve threads, start CI or merge. Push/create remains a manual delivery step.

## Acceptance still required

| Required evidence | Current status / missing input |
| --- | --- |
| Authorized Azure PR linked to a GitHub/Jira task, actual review thread and subsequent PR iteration | Not run. Need an authorized organization/project/repository/PR and the shared app connection. |
| Live repository collisions, force push/revision change, deleted branch, partial permissions and pagination | Only source/fixture coverage. Need controlled Azure test resources and authority for any test mutations. Story-link discovery also needs real Azure Boards/Jira link verification. |
| Real Windows UI → WSL checkout read/context flow | Not run. Need the authorized Windows/WSL host and test checkout; credentials remain on their explicit host. |
| Ordinary native-app journey, real agent preparation and interaction while another agent streams | Browser fixture and existing #8 tests only. Not accepted as a live native/provider boundary. |
| Representative native release CPU/memory/responsiveness versus baseline | Not measured. No speed, memory or no-regression claim is made. |
| Hosted CI | Inspect the draft PR's current checks; local checks do not substitute for hosted or live acceptance. |

Azure DevOps Services is supported; Azure DevOps Server and fork file previews use an explicit external fallback. Binary/oversize files and details beyond the bounded inspection limit also remain available in Azure. These limitations must remain visible when assessing readiness.

Keep the PR draft until applicable live acceptance and performance evidence are supplied. #14 must start in a fresh worktree after #13 merges; merging and issue closure remain the user's decisions.

API contracts checked against Microsoft documentation: [PR lookup](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests?view=azure-devops-rest-7.1), [iteration changes](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1), [file content](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1), [policy evaluations](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1), [PR statuses](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-statuses/list?view=azure-devops-rest-7.1), [clone URL forms](https://learn.microsoft.com/en-us/azure/devops/repos/git/clone?view=azure-devops-2022).

Story-link contracts: [Azure work-item PR artifact links](https://learn.microsoft.com/en-us/previous-versions/azure/devops/integrate/previous-apis/git/pull-requests/work-items?view=tfs-2017), [Jira remote issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/).
