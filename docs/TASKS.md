# Task domain model

How work is organized above repositories. The store is
`src/lib/taskWorkspaces.ts` (localStorage `monocode.taskWorkspaces.v1`);
sessions live in the Rust `session_store` and are referenced by id, never
embedded.

## Entities

- **Project** (`ProjectRecord`, `src/lib/projects.ts`) — grouping boundary.
  Owns `repositories`, saved sets, saved commands. A repository belongs to at
  most one project.
- **Repository** (`ProjectRepository`) — identity is the verified Git common
  dir, host-qualified (`//wsl.localhost/<distro>/…` never collapses with a
  native clone). `anchor` is only a re-probe path; `id` survives a Locate.
- **Task** (`TaskWorkspace`) — the user-facing unit of work: name, brief,
  linked tickets, `attempts`, `children`. Belongs to exactly one project.
- **Attempt** (`TaskAttempt`) — one candidate solution set. Every task has at
  least the primary attempt (`PRIMARY_ATTEMPT_ID`); `attempts[0]` is always
  primary. `status` records a `chosen`/`discarded` verdict; absent means
  still in play.
- **Checkout** (`TaskChild`) — "repository R's share of attempt A lives at
  path P on branch B." Carries `repositoryId` + `attemptId`, the working-copy
  binding (`workingCopy`), creation inputs (`baseRef`/`baseCommit`/`branch`),
  `mergeTarget`, `responsibility`, per-repo `sessionIds` and a `launch`
  lifecycle (`pending`/`working`/`ready`/`failed`).
- **Git worktree** — never a stored entity. It is filesystem state discovered
  through `git_repository_family` inventory and reconciled on refresh; a
  child's `workingCopy` is just a path binding that can go missing, move or
  become prunable.
- **Session** — first-class, referenced not owned. `session.cwd` equals one
  checkout's path; which list holds the id encodes scope — `task.sessionIds`
  for a conversation working across the whole task, `child.sessionIds` for a
  repo-scoped worker.

There is deliberately no **Workspace** entity: a task's workspace is derived
(the set of children's working copies), and `Workspace*` already names the
tab/pane layout (`WorkspaceTab`, `workspaceSnapshot`, `sessionWorkspaceLifecycle`).

## Invariants

- A repository appears at most once per attempt — uniqueness is keyed on
  `(attemptId, repositoryId)`, so the same repo can repeat across attempts
  but never inside one.
- Git forces each attempt to its own branch per repository; branch
  suggestions dedupe against existing refs (`suggestTaskBranch`).
- All children of one task share one execution host — `taskHostConflict`
  rejects mixed native/WSL working copies.
- `taskOwnsCheckout(child)` (`branch`+`baseRef` recorded) marks checkouts the
  task created versus borrowed existing/main copies. Removal and cleanup
  offers must use it, never path heuristics.
- The primary attempt cannot be removed; it can be marked `discarded`.
  `removeTaskAttempt` drops the record and its children while sessions,
  working copies and branches stay — the same policy as `removeTaskChild`.

## Lookups under multiple attempts

When a lookup must pick one child, prefer the primary attempt:

- `childForRepository(task, repositoryId, attemptId?)` — repo → child,
  primary attempt by default. Used by repository-bound project commands.
- `preferredTaskChild(task, match)` — representative picks (session host,
  open target) prefer a primary-attempt match, then any match. Explicit user
  state (`lastActiveChildId`, an exact `cwd` match) still wins.
- `attemptForChild` / `taskAttemptLabel` resolve a child's attempt and its
  display label (`label` or "Attempt N").

`taskChildRepoLabel` and `composeTaskSessionPrompt` append the attempt label
only when a task actually has more than one attempt, so single-attempt tasks
keep today's output.

## Extension points and non-goals

- Delivery attribution (Azure PR associations, CI sources, PR drafts keyed
  `taskId:childId`) keys on the checkout's `cwd`+`branch`+session — attempts
  need no schema change there because their checkouts have distinct paths
  and branches by construction.
- "Add a repo mid-task" (`addTaskChildren`, `reviseTask`) targets a chosen
  attempt via the draft's `attemptId` (default primary); whether a new repo
  should materialize into every attempt is a product decision, not a model
  constraint.
- Task records are frontend-localStorage today. Durable execution (#21) and
  schedules (#24) will need the backend to resolve task → checkout bindings;
  keep new fields flat and id-keyed so that move stays a row mapping.
- Which attempt a task-level session works on is intentionally unsettled —
  the session is rooted at a host checkout and the prompt lists every child;
  per-attempt session UX is a later slice, not hidden in this model.

## Verification

`npx vitest run src/lib/taskWorkspaces.test.ts` covers attempt
creation/removal, primary-attempt protection, per-attempt repository
uniqueness, legacy-record backfill, dangling attempt ids, label
disambiguation and checkout ownership. Cross-attempt worktree creation on
real repositories reuses the existing worktree launch path; no separate
acceptance is claimed here.
