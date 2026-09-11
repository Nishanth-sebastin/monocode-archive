import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader } from "../chrome/icons";
import {
  gitDiffFiles,
  gitDiscardFile,
  gitFileDiff,
  gitStageContents,
  gitStageFile,
  notifyGitChanged,
  subscribeGitChanged,
  type GitChangedFile,
  type GitDiffGuard,
  type GitFileDiffKind,
} from "../lib/fs";
import { forEachConcurrent } from "../lib/concurrent";
import { buildUnifiedFile, type UnifiedFileDiff } from "../lib/unifiedDiff";
import {
  prioritizeWorkingTreeDiffEntries,
  workingTreeDiffEntries,
  workingTreeDiffEntryLabel,
  workingTreeDiffFocusId,
} from "../lib/workingTreeDiff";
import { revertChunkText, stageChunkText } from "./editorGit";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "./UnifiedDiffView";

type Props = {
  cwd: string;
  focusPath?: string;
  focusKind?: GitFileDiffKind;
};

type LoadedDiff = {
  status: string;
  binary: boolean;
  tooLarge: boolean;
  original: string;
  current: string;
  unified: UnifiedFileDiff | null;
  error?: string;
};

const DIFF_LOAD_CONCURRENCY = 4;

export function WorkingTreeDiff({ cwd, focusPath, focusKind }: Props) {
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [diffs, setDiffs] = useState<Map<string, LoadedDiff>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const diffsRef = useRef(diffs);
  diffsRef.current = diffs;

  useEffect(() => {
    if (!cwd || cwd === "~") {
      setFiles([]);
      setDiffs(new Map());
      return;
    }

    let disposed = false;
    let generation = 0;
    setFiles(null);
    setDiffs(new Map());

    const run = () => {
      const current = ++generation;
      void gitDiffFiles(cwd)
        .then(async (index) => {
          if (disposed || current !== generation) return;
          setFiles(index.files);
          setDiffs(new Map());
          setError(null);
          const entries = workingTreeDiffEntries(index.files);
          const loadOrder = prioritizeWorkingTreeDiffEntries(
            entries,
            focusPath,
            focusKind,
          );
          await forEachConcurrent(
            loadOrder,
            DIFF_LOAD_CONCURRENCY,
            async (entry) => {
              let loaded: LoadedDiff;
              try {
                const diff = await gitFileDiff(
                  cwd,
                  entry.file.relative,
                  entry.kind,
                );
                const unified =
                  !diff.binary && !diff.tooLarge
                    ? buildUnifiedFile(diff.original, diff.current)
                    : null;
                loaded = {
                  status: diff.status,
                  binary: diff.binary,
                  tooLarge: diff.tooLarge,
                  original: diff.original,
                  current: diff.current,
                  unified,
                };
              } catch (caught: unknown) {
                loaded = {
                  status: "modified",
                  binary: false,
                  tooLarge: false,
                  original: "",
                  current: "",
                  unified: null,
                  error:
                    caught instanceof Error ? caught.message : String(caught),
                };
              }
              if (disposed || current !== generation) return;
              setDiffs((existing) => {
                const next = new Map(existing);
                next.set(entry.id, loaded);
                return next;
              });
            },
            () => !disposed && current === generation,
          );
        })
        .catch((caught: unknown) => {
          if (disposed || current !== generation) return;
          setError(caught instanceof Error ? caught.message : String(caught));
          setFiles([]);
        });
    };

    run();
    let refreshFrame = 0;
    const scheduleRun = () => {
      if (refreshFrame) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = 0;
        run();
      });
    };
    const unsub = subscribeGitChanged(scheduleRun, cwd);
    const onFocus = () => {
      if (!document.hidden) scheduleRun();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      if (refreshFrame) window.cancelAnimationFrame(refreshFrame);
      unsub();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [cwd]);

  const entries = useMemo(() => workingTreeDiffEntries(files ?? []), [files]);

  const models = useMemo<UnifiedDiffFileModel[]>(() => {
    if (!files) return [];
    return entries.map((entry) => {
      const { file, kind } = entry;
      const loaded = diffs.get(entry.id);
      const unified = loaded?.unified ?? null;
      const unchanged =
        unified != null &&
        unified.additions === 0 &&
        unified.deletions === 0 &&
        !loaded?.binary;
      const canUseIndexCounts =
        loaded != null && !loaded.error && !(file.staged && file.unstaged);
      return {
        id: entry.id,
        path: file.path,
        label: workingTreeDiffEntryLabel(entry),
        binary: loaded?.binary,
        tooLarge: loaded?.tooLarge,
        emptyMessage:
          loaded == null
            ? "Loading…"
            : loaded.error
              ? `Couldn’t load diff: ${loaded.error}`
              : unchanged
                ? kind === "staged"
                  ? "No staged changes"
                  : "No unstaged changes"
                : undefined,
        additions:
          unified?.additions ?? (canUseIndexCounts ? file.additions : 0),
        deletions:
          unified?.deletions ?? (canUseIndexCounts ? file.deletions : 0),
        blocks: unchanged ? [] : (unified?.blocks ?? []),
        canStage: kind === "unstaged",
        canDiscard: kind === "unstaged",
        hunkAction:
          loaded && !loaded.binary && !loaded.tooLarge
            ? kind === "staged"
              ? "unstage"
              : "stage"
            : undefined,
        contextRevision: loaded,
      };
    });
  }, [diffs, entries, files]);

  const totals = useMemo(
    () =>
      models.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [models],
  );

  const focusId = useMemo(
    () => workingTreeDiffFocusId(entries, focusPath, focusKind),
    [entries, focusKind, focusPath],
  );

  const onStageFile = useCallback(
    async (id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.kind !== "unstaged") return;
      setBusyId(id);
      try {
        await gitStageFile(cwd, entry.file.relative);
        notifyGitChanged(cwd);
      } finally {
        setBusyId(null);
      }
    },
    [cwd, entries],
  );

  const onDiscardFile = useCallback(
    async (id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.kind !== "unstaged") return;
      setBusyId(id);
      try {
        await gitDiscardFile(cwd, entry.file.relative);
        notifyGitChanged(cwd);
      } finally {
        setBusyId(null);
      }
    },
    [cwd, entries],
  );

  const onHunkAction = useCallback(
    async (id: string, pos: number) => {
      if (busyRef.current) return;
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return;
      const loaded = diffsRef.current.get(id);
      if (!loaded) return;
      const next =
        entry.kind === "staged"
          ? revertChunkText(loaded.original, loaded.current, pos)
          : stageChunkText(loaded.original, loaded.current, pos);
      if (next == null) return;
      const guard: GitDiffGuard = {
        kind: entry.kind,
        status: loaded.status,
        original: loaded.original,
        current: loaded.current,
      };
      busyRef.current = id;
      setBusyId(id);
      setActionError(null);
      try {
        await gitStageContents(cwd, entry.file.relative, next, guard);
        notifyGitChanged(cwd);
      } catch (caught: unknown) {
        setActionError(
          caught instanceof Error ? caught.message : String(caught),
        );
        notifyGitChanged(cwd);
      } finally {
        busyRef.current = null;
        setBusyId(null);
      }
    },
    [cwd, entries],
  );

  const validateContext = useCallback(
    async (id: string, revision: object | undefined) => {
      const entry = entries.find((candidate) => candidate.id === id);
      const loaded = diffsRef.current.get(id);
      if (!entry || !loaded || loaded !== revision) {
        throw new Error(
          "This diff changed. Review the refreshed hunk and try again.",
        );
      }
      const current = await gitFileDiff(
        cwd,
        entry.file.relative,
        entry.kind,
      ).catch(() => {
        notifyGitChanged(cwd);
        throw new Error(
          "This diff changed. Review the refreshed hunk and try again.",
        );
      });
      if (
        current.status !== loaded.status ||
        current.original !== loaded.original ||
        current.current !== loaded.current
      ) {
        notifyGitChanged(cwd);
        throw new Error(
          "This diff changed. Review the refreshed hunk and try again.",
        );
      }
    },
    [cwd, entries],
  );

  if (!cwd || cwd === "~") {
    return (
      <p className="grid h-full place-items-center text-[13px] text-content/45">
        No project folder
      </p>
    );
  }
  if (error) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <AlertCircle className="mx-auto mb-3 size-5 text-red-400" />
        <p className="text-[13px] text-content">Couldn’t load changes</p>
        <p className="mt-1 text-[12px] text-content/50">{error}</p>
      </div>
    );
  }
  if (files == null) {
    return (
      <div className="grid h-full place-items-center text-content/40">
        <Loader className="size-4 animate-spin" strokeWidth={1.75} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {actionError ? (
        <p
          role="alert"
          className="shrink-0 border-b border-content/10 px-3 py-1 text-[11px] text-red-400"
        >
          {actionError}
        </p>
      ) : null}
      <UnifiedDiffView
        files={models}
        fileCount={files.length}
        focusId={focusId}
        busyId={busyId}
        totals={totals}
        onStageFile={onStageFile}
        onDiscardFile={onDiscardFile}
        onHunkAction={onHunkAction}
        onValidateContext={validateContext}
      />
    </div>
  );
}
