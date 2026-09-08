import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

export function WorktreePanel({
  cwd,
  onClose,
  onOpen,
  onBusyChange,
  initialBase = "",
}: {
  cwd: string;
  onClose: () => void;
  onOpen: (path: string) => void;
  onBusyChange: (busy: boolean) => void;
  initialBase?: string;
}) {
  const [entries, setEntries] = useState<Worktree[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [base, setBase] = useState(initialBase);
  const [creating, setCreating] = useState(Boolean(initialBase));
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
    onBusyChange(true);
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
      onBusyChange(false);
    }
  };
  useEffect(() => {
    void run(async () => {});
  }, []);
  const selectedName = base.replace(/^refs\/(heads|remotes)\//, "");
  const inputClass =
    "w-full rounded border border-content/15 bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-content/40";
  const openEntry = (entry: Worktree) => {
    if (entry.users.length) {
      setConfirmation({ entry, action: "open" });
      return;
    }
    onOpen(entry.path);
    onClose();
  };
  return (
    <div className="min-h-0 overflow-y-auto p-3 text-[12px]" aria-busy={busy}>
      {confirmation ? (
        <div className="flex flex-col gap-2">
          <p className="font-medium">
            {confirmation.action === "remove"
              ? "Remove worktree?"
              : "Share this worktree?"}
          </p>
          <p>
            {confirmation.entry.branch?.replace("refs/heads/", "")} ·{" "}
            {confirmation.entry.head.slice(0, 10)}
          </p>
          <p className="break-all text-content/50">{confirmation.entry.path}</p>
          <p className="text-content/60">
            {confirmation.action === "remove"
              ? "Its branch and conversations will stay. Unsaved files or running agents and terminals block removal."
              : "Existing conversations use this folder. Concurrent agents can change the same files."}
          </p>
          {confirmation.entry.users.length > 0 && (
            <details className="max-h-24 overflow-auto text-content/50">
              <summary>Existing conversations</summary>
              {confirmation.entry.users.map((user) => (
                <p key={user}>{user}</p>
              ))}
            </details>
          )}
          <div className="mt-1 flex justify-end gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded bg-content/10 px-3 py-1.5"
              onClick={() => {
                const { entry, action } = confirmation;
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
                  setConfirmation(null);
                });
              }}
            >
              {confirmation.action === "remove"
                ? "Remove worktree"
                : "Open new conversation"}
            </button>
          </div>
        </div>
      ) : creating ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-medium">New worktree</span>
            <button
              type="button"
              disabled={busy}
              className="text-content/50"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
          <label className="flex flex-col gap-1 text-content/60">
            From branch
            <select
              className={inputClass}
              value={base}
              disabled={busy}
              onChange={(e) => setBase(e.target.value)}
            >
              <option value="">Choose a branch</option>
              {refs.map((ref) => (
                <option key={ref.name} value={ref.name}>
                  {ref.name.replace(/^refs\/(heads|remotes)\//, "")}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-content/60">
            New branch
            <input
              autoFocus
              disabled={busy}
              className={inputClass}
              value={branch}
              placeholder="my-change"
              onChange={(e) => {
                setBranch(e.target.value);
                if (!path || path === `${cwd}-${branch.replace(/\//g, "-")}`)
                  setPath(`${cwd}-${e.target.value.replace(/\//g, "-")}`);
              }}
            />
          </label>
          <details className="text-content/50">
            <summary className="cursor-pointer">
              Location and base commit
            </summary>
            <label className="mt-2 flex flex-col gap-1">
              Folder
              <input
                disabled={busy}
                className={inputClass}
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
            </label>
            <p className="mt-2 break-all font-mono text-[10px]">
              {selected?.commit}
            </p>
            <p className="mt-1">
              Remote refs use the local cache. Fetch with Git, then refresh.
            </p>
          </details>
          <button
            type="button"
            disabled={busy || !selected || !branch || !path}
            className="rounded bg-content/10 px-3 py-2 disabled:opacity-40"
            onClick={() => {
              let created: string | undefined;
              void run(async () => {
                created = await invoke<string>("git_worktree_create", {
                  cwd,
                  base,
                  commit: selected!.commit,
                  branch,
                  path,
                });
                notifyGitChanged();
              }).then(() => {
                if (created) {
                  onOpen(created);
                  onClose();
                }
              });
            }}
          >
            {busy ? "Creating…" : "Create and open"}
          </button>
          {selected && (
            <p className="text-[11px] text-content/45">
              From {selectedName} · {selected.commit.slice(0, 10)}. Opens a
              fresh conversation.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {entries.map((entry) => (
            <div
              key={entry.path}
              className="flex items-center gap-1 rounded hover:bg-content/5"
            >
              <button
                type="button"
                disabled={busy || entry.missing || !!entry.prunable}
                title={entry.path}
                className="min-w-0 flex-1 px-2 py-2 text-left disabled:opacity-40"
                onClick={() => openEntry(entry)}
              >
                <span className="block truncate">
                  {entry.branch?.replace("refs/heads/", "") ??
                    `Detached ${entry.head.slice(0, 8)}`}
                  {entry.path === cwd
                    ? " · current"
                    : entry.main
                      ? " · main checkout"
                      : ""}
                </span>
                <span className="block truncate text-[10px] text-content/45">
                  {entry.missing
                    ? "Folder missing — repair with Git"
                    : entry.locked
                      ? "Locked"
                      : entry.path.split("/").pop()}
                  {entry.users.length
                    ? ` · ${entry.users.length} conversations`
                    : ""}
                </span>
              </button>
              {!entry.main && entry.branch && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    entry.path === cwd ||
                    entry.missing ||
                    !!entry.locked ||
                    !!entry.prunable
                  }
                  title="Remove worktree"
                  aria-label={`Remove worktree ${entry.branch.replace("refs/heads/", "")}`}
                  className="shrink-0 rounded p-2 text-content/40 hover:text-red-400 disabled:opacity-20"
                  onClick={() => setConfirmation({ entry, action: "remove" })}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <div className="mt-2 flex justify-between border-t border-content/10 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              + New worktree
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-content/50"
              onClick={() => void run(async () => {})}
            >
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}
