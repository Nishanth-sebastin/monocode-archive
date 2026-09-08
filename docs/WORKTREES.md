# Local worktrees

Open the composer **branch picker**, then **Worktrees**. Search existing checkouts
or type a new name and choose **Create worktree**. Arrow keys and Enter select a
result. Creation starts from the current branch; the **From** row changes the base.
The plus action beside a branch opens creation with that base selected. Git supplies the inventory,
including externally created checkouts. Select an explicit local or remote-tracking
ref, review its commit, and enter a new branch name. The suggested folder can be
changed by clicking the folder row. **Create branch and worktree** creates both together and opens a fresh
conversation after Git confirms creation; it does not dispatch an agent. A later
dispatch failure does not recreate or remove the worktree. Remote refs are cached:
fetch with Git and refresh explicitly.

Each conversation keeps its persisted working directory and provider session.
Opening another worktree creates another conversation, including from an empty
conversation. Existing terminals retain their original directory. Recent saved
conversation associations are shown (up to 100 per checkout); explicit reuse warns
about concurrent writers. Unsaved empty conversations and external processes are
not a complete inventory of writers.

Removing a worktree requires an in-app confirmation and fresh Git validation.
The main checkout, detached HEAD, locked/prunable/missing entries, changed HEAD,
symlink aliases, dirty, untracked and ignored files are rejected. Branches and
conversation records are retained. Closing, archiving or deleting a conversation
does not remove its checkout. Pruning metadata, deleting branches and repairing
missing directories remain explicit Git operations, with no automatic retry.

Cleanup conservatively requires all this app's agent processes and terminals to
be closed, even those in another repository. Process startup is serialized against
removal. External editors/agents are outside the app's ownership; stop them before
cleanup. Git still enforces its non-force removal safeguards. Operations have a
30-second Git timeout and retain at most 1 MiB from each pipe. A timeout is an
uncertain result: refresh and inspect the exact path/branch before retrying.

## Runnable acceptance

Use only disposable repositories; do not run cleanup scenarios on real work.

1. Initialize a repository with a commit and two branches at distinct commits.
   Add a remote-tracking ref with `git update-ref refs/remotes/test/topic <commit>`.
   Create worktrees from each selected ref, including a path with spaces/Unicode.
   Confirm `git -C <path> rev-parse HEAD` matches the displayed commit.
2. Add another checkout externally with `git worktree add -b external <path>`.
   Refresh, open it, and switch back to a previous conversation. Read/edit a fixture
   and inspect Changes in each checkout; no other checkout should change.
3. Start a bounded agent read and a terminal. Open another checkout. Confirm their
   directories remain unchanged. Quit/reopen and reopen the saved conversation;
   verify its transcript, directory and provider identity survive.
4. Preview removal with an open terminal: confirm rejection without stopping it.
   Close owned processes, then test tracked edits, untracked files and ignored
   `.env` files. All must remain intact. Test locked and detached checkouts too.
5. Remove a clean unused checkout after reviewing its exact path and HEAD. Verify
   its branch still exists and saved conversations remain. Delete a disposable
   checkout externally and refresh: show missing/prunable state without pruning.
6. Try duplicate branch/path names, a base ref moved after selection, two repositories
   with the same branch names, repeated clicks, cancel before confirmation and a
   failed create. Refresh must reconcile actual Git state without a duplicate.

Run regression checks with `npm run check`. The release measurement is
`cargo test --release inventory_release_measurement -- --ignored --nocapture`.
It measures production inventory logic against 11 disposable worktrees, without
agents or UI rendering. It is not an app responsiveness or WSL benchmark.

Native Windows interaction and Windows-to-WSL acceptance remain unverified on this
Mac. #22 extends this local boundary; ticket kickoff follows #6/#8 and each
connector. Neither live WSL nor the full ticket/provider matrix is claimed here.
