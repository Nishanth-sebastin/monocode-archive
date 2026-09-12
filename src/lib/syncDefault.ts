import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  gitDiffIndex,
  gitMergeAbort,
  gitMergeContext,
  gitSyncBranch,
  notifyGitChanged,
  type GitDiffIndex,
  type GitSyncResult,
} from "./fs";
import { boundAgentContext, requestAgentContext } from "./agentContext";
import { wslLocation } from "./paths";
import { IS_MAC, IS_WIN } from "./platform";

/** A working copy to sync, optionally owned by a conversation. */
export type SyncTarget = {
  /** Exact working copy — resolved by the caller (sessionWorkCwd, panel cwd). */
  cwd: string;
  /** Owning conversation — conflicts route straight to it; otherwise the picker. */
  sessionId?: string;
  /** Dialog title context, e.g. the session title. */
  title?: string;
};

/** Execution host for confirmations and agent context — never guessed. */
export function syncHostLabel(cwd: string): string {
  const wsl = wslLocation(cwd);
  if (wsl) return `WSL · ${wsl.distribution}`;
  return IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";
}

/** The exact operation the confirmation must state before anything runs. */
export function syncConfirmText(cwd: string, index: GitDiffIndex): string {
  const remote = index.remote ?? "origin";
  const incoming = index.defaultBranch
    ? `${remote}/${index.defaultBranch}`
    : `the ${remote} default branch`;
  const branch = index.branch ?? "the current branch";
  return [
    `Fetch ${remote}, then merge ${incoming} into ${branch} in this exact working copy and host.`,
    "",
    `Working copy: ${cwd}`,
    `Host: ${syncHostLabel(cwd)}`,
    "",
    "Nothing is pushed. A dirty tree or an operation already in progress is refused — nothing is stashed or aborted automatically.",
  ].join("\n");
}

/**
 * Confirm → fetch → merge `remote/<default>` → report. Returns the raw
 * result (undefined when the user cancels or the pre-read fails). Conflicts
 * stay in the tree and route to `offerMergeResolution`; abort is offered
 * again there. Callers own busy state — a second run is refused by the
 * backend, never queued.
 */
export async function syncWithDefaultBranch(
  target: SyncTarget,
): Promise<GitSyncResult | undefined> {
  const index = await gitDiffIndex(target.cwd);
  if (
    !(await ask(syncConfirmText(target.cwd, index), {
      title: "Sync with remote default",
      kind: "info",
      okLabel: "Sync",
      cancelLabel: "Cancel",
    }))
  )
    return undefined;
  const result = await gitSyncBranch(target.cwd);
  notifyGitChanged(target.cwd);
  const title = target.title || "Sync with remote default";
  switch (result.outcome) {
    case "merged": {
      const list = result.commits.slice(0, 10).join("\n");
      await message(
        `Merged ${result.syncedWith} into ${result.branch} — ${result.commits.length} incoming commit${result.commits.length === 1 ? "" : "s"}${list ? `:\n${list}` : "."}\n\nNothing was pushed.`,
        { title },
      );
      break;
    }
    case "up-to-date":
      await message(
        `${result.branch} is already up to date with ${result.syncedWith}.`,
        { title },
      );
      break;
    case "conflicted":
      await offerMergeResolution(target, result.syncedWith, result.conflicts);
      break;
    default:
      await message(result.reason || "The sync was refused.", {
        title,
        kind: "warning",
      });
  }
  return result;
}

/**
 * Conflict resolution choice after a sync (or later, from the merge
 * banner): send the merge context to an agent, or leave the real state in
 * the tree — with one more explicit chance to abort instead.
 */
async function offerMergeResolution(
  target: SyncTarget,
  syncedWith: string,
  conflicts: string[],
): Promise<void> {
  const title = target.title || "Merge conflicts";
  const list = conflicts.slice(0, 10).join("\n");
  const send = await ask(
    `Merging ${syncedWith} left ${conflicts.length} conflicted file${conflicts.length === 1 ? "" : "s"}${list ? `:\n${list}` : ""}\n\nThe conflicted state is preserved in the working copy. Send the merge context to ${target.sessionId ? "the owning conversation" : "an agent"}?`,
    {
      title,
      kind: "warning",
      okLabel: target.sessionId ? "Send to owning agent" : "Send to agent",
      cancelLabel: "Resolve manually",
    },
  );
  if (send) {
    const sent = await sendMergeConflictsToAgent(target);
    if (!sent)
      await message(
        "The merge is no longer in progress — nothing was sent.",
        { title, kind: "info" },
      );
    return;
  }
  if (
    await ask(
      "Keep the conflicts in the tree, or abort the merge and restore the pre-merge state?",
      {
        title,
        kind: "warning",
        okLabel: "Abort merge",
        cancelLabel: "Keep conflicts",
      },
    )
  ) {
    await gitMergeAbort(target.cwd);
    notifyGitChanged(target.cwd);
  }
}

/**
 * Dispatch the live merge state to the owning conversation (or the
 * destination picker when the working copy has none). Reads fresh state so
 * a merge already resolved or aborted sends nothing; the conflict stays in
 * the tree either way. Returns false when there is nothing left to send.
 */
export async function sendMergeConflictsToAgent(
  target: SyncTarget,
): Promise<boolean> {
  const merge = await gitMergeContext(target.cwd);
  if (!merge.merging) return false;
  const index = await gitDiffIndex(target.cwd).catch(() => null);
  const remote = index?.remote ?? "origin";
  const incoming = index?.defaultBranch
    ? `${remote}/${index.defaultBranch}`
    : `the ${remote} default branch`;
  const branch = index?.branch ?? "the current branch";
  const host = syncHostLabel(target.cwd);
  const paths = merge.conflicts.length
    ? merge.conflicts.join("\n")
    : "(no unmerged paths — the operation is still in progress)";
  const text = [
    `Merging ${incoming} into ${branch} stopped with conflicts in this working copy. Resolve the merge in place — preserve both sides' intent, then run the checks this repository offers.`,
    "",
    `Host: ${host}`,
    `Working copy: ${target.cwd}`,
    `Branch: ${branch}`,
    `Incoming ref: ${incoming}${merge.mergeHead ? ` (${merge.mergeHead})` : ""}`,
    `Conflicted paths (${merge.conflicts.length}):`,
    paths,
    "",
    "Work only in this working copy and host. Do not abort the merge, do not commit until every conflict is resolved, and do not push. Leave the tree ready for review in the diff view.",
  ].join("\n");
  requestAgentContext({
    context: boundAgentContext({
      id: crypto.randomUUID(),
      attachments: [],
      entries: [
        {
          id: crypto.randomUUID(),
          title: `Merge conflicts in ${branch}`,
          origin: `${target.cwd} · ${host} · merge in progress`,
          text,
        },
        ...(merge.diff
          ? [
              {
                id: crypto.randomUUID(),
                title: "Conflicted diff (bounded)",
                origin: `${target.cwd} · git diff of unmerged paths`,
                text: merge.diff,
                language: "diff",
              },
            ]
          : []),
      ],
    }),
    cwd: target.cwd,
    sourceSessionId: target.sessionId,
    requireDestinationSelection: !target.sessionId,
  });
  return true;
}

/** Explicit `merge --abort` — available at every state, always confirmed. */
export async function abortMerge(target: SyncTarget): Promise<boolean> {
  if (
    !(await ask(
      `Abort the merge in ${target.cwd} and restore the pre-merge state?`,
      {
        title: "Abort merge",
        kind: "warning",
        okLabel: "Abort merge",
        cancelLabel: "Cancel",
      },
    ))
  )
    return false;
  await gitMergeAbort(target.cwd);
  notifyGitChanged(target.cwd);
  return true;
}
