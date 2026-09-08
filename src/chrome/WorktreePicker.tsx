import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { notifyGitChanged } from "../lib/fs";

type Worktree = {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  locked: string | null;
  prunable: string | null;
  missing: boolean;
  users: string[];
};
type Ref = { name: string; commit: string };

export function WorktreePicker({
  cwd,
  onOpen,
}: {
  cwd: string;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="text-[11px] text-content/50 hover:text-content"
        disabled={!cwd || cwd === "~"}
        onClick={() => setOpen(true)}
        title={`Local worktree: ${cwd}`}
      >
        Worktrees
      </button>
      {open && (
        <WorktreeDialog
          cwd={cwd}
          onClose={() => setOpen(false)}
          onOpen={onOpen}
        />
      )}
    </>
  );
}

function WorktreeDialog({
  cwd,
  onClose,
  onOpen,
}: {
  cwd: string;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Worktree[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [base, setBase] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{
    entry: Worktree;
    action: "open" | "remove";
  } | null>(null);
  const pending = useRef(false);
  const selected = refs.find((ref) => ref.name === base);
  const refresh = async () => {
    const [trees, branches] = await Promise.all([
      invoke<Worktree[]>("git_worktrees", { cwd }),
      invoke<Ref[]>("git_worktree_refs", { cwd }),
    ]);
    setEntries(trees);
    setRefs(branches);
  };
  const run = async (work: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(String(err));
    } finally {
      try {
        await refresh();
      } catch (err) {
        setError((previous) => `${previous}\nRefresh failed: ${err}`.trim());
      }
      pending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(async () => {});
  }, []);
  const inputClass =
    "w-full rounded border border-content/15 bg-background-base px-2 py-1.5 text-[12px]";
  return (
    <Modal
      title="Worktrees"
      description={`Local · ${cwd}`}
      size="md"
      onClose={() => {
        if (!pending.current) onClose();
      }}
    >
      <div className="flex flex-col gap-3 p-4 text-[12px]" aria-busy={busy}>
        <p className="text-content/60">
          Open in a fresh conversation. Existing chats and terminals keep their
          checkout. Archiving or deleting a chat leaves Git untouched.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => {})}
          className="self-start underline"
        >
          Refresh local inventory
        </button>
        <div className="max-h-52 overflow-y-auto">
          {entries.map((entry) => (
            <div key={entry.path} className="border-b border-content/10 py-2">
              <div className="font-mono">
                {entry.branch?.replace(/^refs\/heads\//, "") ??
                  `detached ${entry.head.slice(0, 10)}`}{" "}
                {entry.main && "· main checkout"}
              </div>
              <div className="break-all text-content/60">{entry.path}</div>
              {(entry.locked || entry.prunable || entry.missing) && (
                <p>
                  {entry.locked ?? entry.prunable ?? "Missing directory"}.
                  Repair explicitly with Git; no automatic pruning.
                </p>
              )}
              {entry.users.length > 0 && (
                <details>
                  <summary>
                    {entry.users.length} recent associated conversations —
                    shared checkout
                  </summary>
                  {entry.users.map((user) => (
                    <p key={user}>{user}</p>
                  ))}
                </details>
              )}
              <div className="mt-1 flex gap-3">
                <button
                  type="button"
                  disabled={busy || entry.missing || !!entry.prunable}
                  className="underline"
                  onClick={() => {
                    if (entry.users.length) {
                      setConfirmation({ entry, action: "open" });
                      return;
                    }
                    onOpen(entry.path);
                    onClose();
                  }}
                >
                  Open fresh conversation
                </button>
                <button
                  type="button"
                  disabled={
                    busy ||
                    !entry.branch ||
                    entry.main ||
                    entry.missing ||
                    !!entry.locked ||
                    !!entry.prunable ||
                    entry.path === cwd
                  }
                  className="text-red-400 disabled:opacity-40"
                  onClick={() => {
                    setConfirmation({ entry, action: "remove" });
                  }}
                >
                  Remove worktree…
                </button>
              </div>
            </div>
          ))}
        </div>
        {confirmation && (
          <section
            className="rounded border border-content/20 p-3"
            aria-label="Confirm worktree action"
          >
            <p className="break-all">{confirmation.entry.path}</p>
            <p className="font-mono break-all">
              {confirmation.entry.branch} · {confirmation.entry.head}
            </p>
            <p>
              {confirmation.action === "remove"
                ? "Remove only this Git worktree? The branch and saved conversations stay. Dirty, untracked or ignored files and running agents/terminals block removal."
                : "Reuse this checkout in a fresh conversation? Concurrent agents may overwrite each other's edits."}
            </p>
            <div className="mt-2 flex gap-3">
              <button
                type="button"
                disabled={busy}
                className="underline"
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                className="underline"
                onClick={() => {
                  const { entry, action } = confirmation;
                  setConfirmation(null);
                  if (action === "open") {
                    onOpen(entry.path);
                    onClose();
                    return;
                  }
                  void run(async () => {
                    await invoke("git_worktree_remove", {
                      cwd,
                      path: entry.path,
                      head: entry.head,
                    });
                    notifyGitChanged();
                  });
                }}
              >
                {confirmation.action === "remove"
                  ? "Confirm removal"
                  : "Confirm reuse"}
              </button>
            </div>
          </section>
        )}
        <fieldset
          disabled={busy}
          className="flex flex-col gap-2 border-t border-content/10 pt-3"
        >
          <legend>Create isolated worktree</legend>
          <label>
            Base branch
            <select
              className={inputClass}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              <option value="">Choose a local or remote-tracking ref</option>
              {refs.map((ref) => (
                <option key={ref.name} value={ref.name}>
                  {ref.name}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <p className="break-all font-mono text-content/60">
              Commit {selected.commit}
            </p>
          )}
          <p className="text-content/50">
            Remote-tracking refs use the local cache. Fetch explicitly with Git,
            then refresh here.
          </p>
          <label>
            New branch
            <input
              className={inputClass}
              value={branch}
              placeholder="task/my-change"
              onChange={(e) => {
                setBranch(e.target.value);
                if (!path || path === `${cwd}-${branch.replace(/\//g, "-")}`)
                  setPath(`${cwd}-${e.target.value.replace(/\//g, "-")}`);
              }}
            />
          </label>
          <label>
            New absolute path
            <input
              className={inputClass}
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!selected || !branch || !path}
            className="rounded bg-content/10 px-3 py-2 disabled:opacity-40"
            onClick={() =>
              void run(async () => {
                await invoke<string>("git_worktree_create", {
                  cwd,
                  base,
                  commit: selected!.commit,
                  branch,
                  path,
                });
                notifyGitChanged();
                setBranch("");
                setPath("");
              })
            }
          >
            Create worktree
          </button>
        </fieldset>
        <p className="text-content/50">
          Creation and opening a conversation are separate steps. Refresh after
          an error before retrying. Close cancels before creation; once started,
          wait for Git readback.
        </p>
        {error && (
          <p
            role="alert"
            className="max-h-28 overflow-auto whitespace-pre-wrap text-red-400"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
