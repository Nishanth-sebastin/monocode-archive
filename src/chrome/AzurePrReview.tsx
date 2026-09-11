import { commentsRepair, unresolvedThread } from "../lib/repair";
import { RepairStatus } from "./RepairStatus";
import type { LinkedWorkItem } from "../lib/session";
import { useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AZURE_CHANGE_EVENT,
  azureConnected,
  type AzureStatus,
} from "../lib/azure";
import { contextFromText, requestAgentContext } from "../lib/agentContext";
import { buildUnifiedFile, formatUnifiedHunk } from "../lib/unifiedDiff";
import { UnifiedDiffView } from "../surfaces/UnifiedDiffView";
import {
  azurePrContext,
  discoverAzurePrs,
  loadAzurePrAssociations,
  azurePrKey,
  type AzurePrDiscoveryGroup,
  azurePrScope,
  azurePrUrl,
  findAzurePrs,
  loadAzurePrAssociation,
  parseAzurePrLocation,
  readAzurePr,
  readAzurePrFile,
  readAzurePrSection,
  saveAzurePrAssociation,
  type AzurePr,
  type AzurePrAssociation,
  type AzurePrPage,
  type AzurePrTarget,
  type AzurePrThread,
} from "../lib/azureRepos";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";

const button =
  "rounded-md px-2 py-1 text-[12px] text-content hover:bg-content/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
const field =
  "w-full rounded-md border border-content/15 bg-content/5 px-2 py-1.5 text-[12px] text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const drafts = new Map<string, { link: string; branch: string }>();
const threadSelections = new Map<string, { id: number | null; page: number }>();
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function AzurePrReview({
  embedded = false,
  cwd,
  branch,
  sourceSessionId,
  enabled,
  linkedWorkItem,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  enabled: boolean;
  linkedWorkItem?: LinkedWorkItem;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [association, setAssociation] = useState(() =>
    loadAzurePrAssociation(cwd, branch, sourceSessionId),
  );
  const update = (value: AzurePrAssociation | null) => {
    saveAzurePrAssociation(
      value,
      cwd,
      branch,
      sourceSessionId,
      association?.target,
    );
    setAssociation(
      value ?? loadAzurePrAssociation(cwd, branch, sourceSessionId),
    );
  };
  useEffect(() => {
    setAssociation(loadAzurePrAssociation(cwd, branch, sourceSessionId));
  }, [cwd, branch, sourceSessionId]);
  return enabled ? (
    <AzurePrPanel
      embedded={embedded}
      key={azurePrScope(cwd, branch, sourceSessionId)}
      cwd={cwd}
      branch={branch}
      sourceSessionId={sourceSessionId}
      linkedWorkItem={linkedWorkItem}
      association={association}
      onChange={update}
      onClose={onClose}
      onReveal={onReveal}
    />
  ) : null;
}

function AzurePrPanel({
  embedded,
  cwd,
  branch,
  sourceSessionId,
  association,
  linkedWorkItem,
  onChange,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  association: AzurePrAssociation | null;
  linkedWorkItem?: LinkedWorkItem;
  onChange: (value: AzurePrAssociation | null) => void;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [status, setStatus] = useState<AzureStatus | null>(null);
  const [choosing, setChoosing] = useState(!association);
  const [linking, setLinking] = useState(false);
  const [repairRefresh, setRepairRefresh] = useState(0);
  const [discovery, setDiscovery] = useState<{
    groups: AzurePrDiscoveryGroup[];
    errors: string[];
  } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const scope = azurePrScope(cwd, branch, sourceSessionId);
  const [link, setLink] = useState(
    drafts.get(scope)?.link ??
      (association ? azurePrUrl(association.target) : ""),
  );
  const [lookupBranch, setLookupBranch] = useState(
    drafts.get(scope)?.branch ?? branch,
  );
  const rememberDraft = (link: string, branch: string) => {
    drafts.delete(scope);
    drafts.set(scope, { link, branch });
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
  };
  const [candidates, setCandidates] = useState<Awaited<
    ReturnType<typeof findAzurePrs>
  > | null>(null);
  const [lookup, setLookup] = useState<AzurePrTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const repairDraft = useRef<{ key: string; instruction: string } | null>(null);
  useEffect(() => {
    const refresh = () => {
      const run = ++generation.current;
      pending.current = false;
      setBusy(false);
      setVerified(false);
      setCandidates(null);
      void azureConnected()
        .then((next) => {
          if (generation.current === run) setStatus(next);
        })
        .catch((error) => {
          if (generation.current === run) setError(message(error));
        });
    };
    refresh();
    window.addEventListener(AZURE_CHANGE_EVENT, refresh);
    return () => {
      generation.current++;
      window.removeEventListener(AZURE_CHANGE_EVENT, refresh);
    };
  }, []);
  useEffect(() => {
    if (embedded || !status?.connected || !status.accountId) {
      setDiscovery(null);
      return;
    }
    let cancelled = false;
    const id = generation.current;
    setDiscovering(true);
    setDiscovery(null);
    void discoverAzurePrs(
      cwd,
      branch,
      status,
      linkedWorkItem,
      () => !cancelled && generation.current === id,
    )
      .then((result) => {
        if (!cancelled && generation.current === id) setDiscovery(result);
      })
      .catch((error) => {
        if (!cancelled && generation.current === id)
          setDiscovery({ groups: [], errors: [message(error)] });
      })
      .finally(() => {
        if (!cancelled && generation.current === id) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, branch, status, linkedWorkItem, discoveryVersion]);
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    const id = generation.current;
    setBusy(true);
    setError("");
    try {
      await action(() => id === generation.current);
    } catch (error) {
      if (id === generation.current) setError(message(error));
    } finally {
      if (id === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const find = (skip = 0) =>
    run(async (current) => {
      if (!status?.connected || !status.accountId)
        throw new Error("Connect Azure DevOps in Settings first.");
      const location =
        skip && lookup
          ? lookup
          : { ...parseAzurePrLocation(link), accountId: status.accountId };
      if (location.site !== status.site)
        throw new Error(
          `This link belongs to ${location.site}. Connect that organization in Settings or choose a link from ${status.site}.`,
        );
      const result = await findAzurePrs(location, lookupBranch, skip);
      if (current()) {
        setLookup(location);
        setCandidates(result);
      }
    });
  const choose = (pr: AzurePr, group = candidates) =>
    run(async (current) => {
      if (!group || !status) return;
      const target = { ...group.target, number: pr.pullRequestId };
      const summary = await readAzurePr(target);
      if (!current()) return;
      onChange({
        ...summary,
        target,
        cwd,
        branch,
        sourceSessionId,
        account: status.account,
        repositoryName: group.repositoryName,
        projectName: group.projectName,
      });
      setVerified(true);
      setCandidates(null);
      setChoosing(false);
      setLinking(false);
      drafts.delete(scope);
    });
  useEffect(() => {
    if (
      association ||
      link.trim() ||
      !discovery ||
      discovery.errors.length ||
      discovery.groups.some((group) => group.nextSkip != null)
    )
      return;
    const matches = discovery.groups.flatMap((group) =>
      group.items.map((pr) => ({ pr, group })),
    );
    if (matches.length === 1) void choose(matches[0].pr, matches[0].group);
    // A completed discovery may select a unique match; later unlinking does not rerun discovery.
  }, [discovery]);
  const refresh = () =>
    run(async (current) => {
      if (!association) return;
      const summary = await readAzurePr(association.target).catch((error) => {
        if (current()) setVerified(false);
        throw error;
      });
      if (current()) {
        onChange({ ...association, ...summary });
        setVerified(true);
      }
    });
  const connected = !!status?.connected && !!status.accountId;
  const sameAccount =
    !!association &&
    status?.site === association.target.site &&
    status?.accountId === association.target.accountId;
  useEffect(() => {
    if (sameAccount) void refresh();
    // Read once on opening or reconnecting; saving the result must not poll.
  }, [status, repairRefresh]);
  return (
    <section
      aria-label="Azure pull requests"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div
        ref={body}
        className="mx-auto w-full max-w-3xl space-y-3 px-5 py-4 text-[12px]"
      >
        {!embedded ? <header className="flex items-center justify-between gap-3 border-b border-content/10 pb-3">
          <h2 className="text-[13px] font-medium">Pull requests</h2>
          <span className="truncate text-content/50" title={cwd}>
            {branch || "Detached checkout"}
          </span>
        </header> : null}
        <details className="text-content/60" open={!connected}>
          <summary className="cursor-pointer focus-visible:outline-accent">
            Azure Repos
            {connected && status?.account
              ? ` · ${status.account}`
              : " · Connect account"}
          </summary>
          <p className="break-words text-content/60">
            {status
              ? connected
                ? `${status.account} · ${status.site} · credentials on this device`
                : "Connect the shared Azure DevOps account to inspect PRs."
              : "Checking Azure connection…"}
          </p>
          <p className="break-all text-content/50">
            Worktree: {cwd}
            <br />
            Branch: {branch || "detached"} · Session:{" "}
            {sourceSessionId ?? "Choose an agent when sending"}
          </p>
          <button
            className={button}
            onClick={() => {
              void emit("open_settings", { section: "general" })
                .then(onClose)
                .catch((error) => setError(message(error)));
            }}
          >
            {" "}
            {connected ? "Connection settings" : "Connect Azure DevOps"}
          </button>
        </details>
        {!embedded && !choosing && association ? (
          <button className={button} onClick={() => setChoosing(true)}>
            Choose another PR
          </button>
        ) : null}
        {choosing ? (
          <section className="space-y-2" aria-label="Related Azure PRs">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Linked to this work</h3>
              <button
                className={button}
                disabled={discovering || !connected}
                onClick={() => setDiscoveryVersion((value) => value + 1)}
              >
                Refresh matches
              </button>
            </div>
            {discovering ? (
              <p role="status">Finding story links, then branch matches…</p>
            ) : null}
            {discovery?.errors.map((error) => (
              <p key={error} className="break-words text-content/60">
                {error}
              </p>
            ))}
            {discovery &&
            !discovery.groups.some((group) => group.items.length) ? (
              <p className="text-content/60">
                No accessible PR found for this story or branch. Link an
                existing PR to review it here.
              </p>
            ) : null}
            {discovery?.groups.map((group, groupIndex) => (
              <div
                key={`${azurePrKey(group.target)}:${groupIndex}`}
                className="space-y-1"
              >
                {group.items.length ? (
                  <p className="break-words text-content/50">
                    {group.origins.join(" · ")}
                  </p>
                ) : null}
                {group.items.map((pr) => (
                  <button
                    key={pr.pullRequestId}
                    className={`${button} block w-full text-left`}
                    disabled={busy}
                    onClick={() => void choose(pr, group)}
                  >
                    <span className="block">
                      #{pr.pullRequestId} {pr.title} · {pr.status}
                    </span>
                    <span className="block break-words text-content/50">
                      {group.projectName}/{group.repositoryName} ·{" "}
                      {pr.sourceRefName} → {pr.targetRefName} ·{" "}
                      {pr.lastMergeSourceCommit?.commitId.slice(0, 8) ??
                        "unknown revision"}
                    </span>
                  </button>
                ))}
                {group.nextSkip != null ? (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void run(async (current) => {
                        const page = await findAzurePrs(
                          group.target,
                          branch,
                          group.nextSkip!,
                        );
                        if (current())
                          setDiscovery((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  groups: previous.groups.map((value, index) =>
                                    index === groupIndex
                                      ? { ...page, origins: group.origins }
                                      : value,
                                  ),
                                }
                              : previous,
                          );
                      })
                    }
                  >
                    Next PRs · {group.repositoryName}
                  </button>
                ) : null}
              </div>
            ))}
            {loadAzurePrAssociations(cwd, branch, sourceSessionId).map(
              (saved) => (
                <button
                  key={azurePrKey(saved.target)}
                  className={`${button} block w-full text-left`}
                  disabled={
                    busy ||
                    saved.target.accountId !== status?.accountId ||
                    saved.target.site !== status?.site
                  }
                  onClick={() =>
                    void choose(saved.pr, {
                      target: saved.target,
                      projectName: saved.projectName,
                      repositoryName: saved.repositoryName,
                      items: [saved.pr],
                      nextSkip: null,
                    })
                  }
                >
                  Saved PR #{saved.pr.pullRequestId} · {saved.projectName}/
                  {saved.repositoryName} · {saved.pr.title}
                </button>
              ),
            )}
          </section>
        ) : null}
        {choosing && !linking ? (
          <button className={`${button} bg-content/10`} disabled={!connected || busy} onClick={() => setLinking(true)}>
            Link a PR
          </button>
        ) : null}
        {choosing && linking ? (
            <form
              className="max-w-lg space-y-3 rounded-md border border-content/10 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void find();
              }}
            >
              <p className="font-medium">Link a PR</p>
              <label className="block">
                PR link or repository remote
                <input
                  aria-label="Azure PR link or repository remote"
                  maxLength={2048}
                  className={field}
                  value={link}
                  disabled={busy}
                  onChange={(event) => {
                    setLink(event.target.value);
                    rememberDraft(event.target.value, lookupBranch);
                    setCandidates(null);
                    setLookup(null);
                  }}
                  placeholder="https://dev.azure.com/org/project/_git/repo/pullrequest/13"
                />
              </label>
              <details className="text-content/60">
                <summary className="cursor-pointer">Find by branch</summary>
                <label className="mt-2 block">
                  Branch (for repository lookup)
                  <input
                    maxLength={1024}
                    className={field}
                    value={lookupBranch}
                    disabled={busy}
                    onChange={(event) => {
                      setLookupBranch(event.target.value);
                      rememberDraft(link, event.target.value);
                      setCandidates(null);
                      setLookup(null);
                    }}
                  />
                </label>
              </details>
              <button
                className={button}
                disabled={busy || !connected || !link.trim()}
              >
                {busy ? "Verifying…" : "Find PR"}
              </button>
              <button type="button" className={button} disabled={busy} onClick={() => { setLinking(false); setCandidates(null); setLookup(null); }}>
                Cancel
              </button>
            </form>
        ) : null}
        {error ? (
          <p role="alert" className="break-words text-content">
            {error}
          </p>
        ) : null}
        {candidates ? (
          <div className="space-y-1">
            <p>
              {candidates.items.length
                ? "Choose the exact PR to link:"
                : "No matching PR. Check the branch or paste a specific PR link."}
            </p>
            {candidates.items.map((pr) => (
              <button
                key={pr.pullRequestId}
                className={`${button} block w-full text-left`}
                disabled={busy}
                onClick={() => void choose(pr)}
              >
                <span className="block">
                  #{pr.pullRequestId} {pr.title} · {pr.status}
                </span>
                <span className="block break-words text-content/50">
                  {candidates.projectName}/{candidates.repositoryName} ·{" "}
                  {pr.sourceRefName} → {pr.targetRefName} ·{" "}
                  {pr.lastMergeSourceCommit?.commitId.slice(0, 8) ??
                    "unknown revision"}
                </span>
              </button>
            ))}
            {candidates.nextSkip != null ? (
              <button
                disabled={busy}
                className={button}
                onClick={() => void find(candidates.nextSkip!)}
              >
                Next PRs
              </button>
            ) : null}
          </div>
        ) : null}
        {association ? (
          <section className="space-y-2 border-t border-content/10 pt-3">
            {!embedded ? <h3 className="font-medium">
              #{association.pr.pullRequestId} {association.pr.title}
            </h3> : null}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-content/55">
              <span className="rounded bg-content/5 px-1.5 py-0.5 text-[11px] text-content/75">{association.pr.isDraft ? "Draft" : association.pr.status === "active" ? "Open" : association.pr.status}</span>
              <span>{association.projectName}/{association.repositoryName}</span>
              <span className="min-w-0 truncate" title={`${association.pr.sourceRefName} → ${association.pr.targetRefName}`}>{association.pr.sourceRefName.replace(/^refs\/heads\//, "")} → {association.pr.targetRefName.replace(/^refs\/heads\//, "")}</span>
            </p>
            <details>
              <summary className="cursor-pointer text-content/60">
                Repository, account and revision
              </summary>
              <p className="break-all text-content/55">
                Account: {association.account} ({association.target.accountId})
                <br />
                Repository: {association.target.repository}
                <br />
                {association.pr.sourceRefName} → {association.pr.targetRefName}
                <br />
                Source / target revision: {association.revision}
              </p>
              {!embedded ? <button
                className={button}
                disabled={busy}
                onClick={() => {
                  try {
                    onChange(null);
                    setVerified(false);
                    setChoosing(true);
                  } catch (error) {
                    setError(message(error));
                  }
                }}
              >
                Unlink PR
              </button> : null}
            </details>
            <div className="flex flex-wrap gap-1">
              <button
                className={button}
                disabled={busy || !sameAccount}
                onClick={() => void refresh()}
              >
                Refresh PR
              </button>
              {!embedded ? <button
                className={button}
                onClick={() => {
                  void openUrl(azurePrUrl(association.target)).catch((error) =>
                    setError(message(error)),
                  );
                }}
              >
                Open in Azure
              </button> : null}
            </div>
            {!sameAccount ? (
              <p role="alert">
                Reconnect the linked Azure account to read this PR, or choose
                another PR.
              </p>
            ) : !verified ? (
              <p>
                {busy ? "Updating PR…" : "Could not update this saved PR. Retry with Refresh PR."}
              </p>
            ) : null}
            <details className="text-content/60">
              <summary className="cursor-pointer">
                Reviewers ({association.pr.reviewers.length})
              </summary>
              <p>
                {association.pr.reviewers
                  .slice(0, 50)
                  .map(
                    (reviewer) =>
                      `${reviewer.displayName}: ${vote(reviewer.vote)}${reviewer.isRequired ? " (required)" : ""}`,
                  )
                  .join("; ") || "None listed"}
              </p>
            </details>
            {sameAccount ? (
              <fieldset disabled={!verified || busy} className="min-w-0">
              <AzurePrDetails
                key={`${association.revision}:${azurePrKey(association.target)}`}
                association={association}
                verified={verified}
                onStale={() => {
                  setVerified(false);
                  setError(
                    "PR revision or access changed. Refresh PR before sending context.",
                  );
                }}
                onHandoff={onClose}
                repairInstruction={repairDraft.current?.key === azurePrKey(association.target) ? repairDraft.current.instruction : undefined}
                onRefreshEvidence={(instruction) => {
                  repairDraft.current = { key: azurePrKey(association.target), instruction };
                  onReveal?.();
                  setRepairRefresh(value => value + 1);
                }}
              />
              </fieldset>
            ) : null}
          </section>
        ) : null}
      </div>
    </section>
  );
}

function vote(value: number) {
  return (
    (
      {
        10: "approved",
        5: "approved with suggestions",
        0: "no vote",
        "-5": "waiting for author",
        "-10": "rejected",
      } as Record<number, string>
    )[value] ?? `unknown vote (${value})`
  );
}

function AzurePrDetails({
  association,
  verified,
  onStale,
  onHandoff,
  onRefreshEvidence,
  repairInstruction,
}: {
  association: AzurePrAssociation;
  verified: boolean;
  onStale: () => void;
  onHandoff: () => void;
  onRefreshEvidence: (instruction: string) => void;
  repairInstruction?: string;
}) {
  const [threads, setThreads] = useState<AzurePrPage<AzurePrThread> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selectionKey = JSON.stringify([
    association.cwd,
    association.sourceSessionId,
    association.target,
    association.revision,
  ]);
  const [expanded, setExpanded] = useState<number | null>(
    threadSelections.get(selectionKey)?.id ?? null,
  );
  const pageRef = useRef(threadSelections.get(selectionKey)?.page ?? 0);
  const preparation = useRef<AbortController | null>(null);
  const rememberThread = (id: number | null) => {
    threadSelections.delete(selectionKey);
    threadSelections.set(selectionKey, { id, page: pageRef.current });
    if (threadSelections.size > 100)
      threadSelections.delete(threadSelections.keys().next().value!);
    setExpanded(id);
  };
  const generation = useRef(0);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setBusy(false);
    return () => {
      mounted.current = false;
      preparation.current?.abort();
      generation.current++;
    };
  }, []);
  const read = async (action: (current: () => boolean) => Promise<void>) => {
    if (pending.current) return;
    const id = generation.current;
    const current = () => mounted.current && generation.current === id;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action(current);
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const load = (skip = pageRef.current) =>
    read(async (current) => {
      const next = await readAzurePrSection<AzurePrThread>(
        association.target,
        association.revision,
        "threads",
        skip,
      );
      if (current()) {
        pageRef.current = skip;
        setThreads(next);
      }
    });
  useEffect(() => {
    if (verified) void load();
  }, [verified]);
  const send = (thread: AzurePrThread) =>
    read(async (current) => {
      // Recheck the revision before opening the existing #8 destination picker.
      try {
        await readAzurePr(association.target, association.revision);
      } catch (error) {
        if (current()) onStale();
        throw error;
      }
      if (!current()) return;
      requestAgentContext({
        context: azurePrContext(association, thread),
        cwd: association.cwd,
        sourceSessionId: association.sourceSessionId,
        requireDestinationSelection: !association.sourceSessionId,
        onPrepared: onHandoff,
      });
    });
  const repairComments = (selected = threads?.items ?? [], commentId?: number) =>
    read(async (current) => {
      const controller = new AbortController();
      preparation.current = controller;
      const draft = await commentsRepair(
        association,
        selected,
        pageRef.current,
        () => current() && !controller.signal.aborted,
        commentId,
        controller.signal,
      ).finally(() => { if (preparation.current === controller) preparation.current = null; });
      if (!current()) return;
      requestAgentContext({
        context: { ...draft.context, instruction: repairInstruction ?? draft.context.instruction },
        repair: draft.evidence,
        onRefreshEvidence,
        cwd: draft.evidence.head.cwd,
        sourceSessionId: draft.evidence.kind === "comments" ? draft.evidence.association.sourceSessionId : undefined,
        requireDestinationSelection: false,
        onPrepared: onHandoff,
      });
    });
  return (
    <div className="space-y-2">
      <RepairStatus
        scope={azurePrKey(association.target)}
        cwd={association.cwd}
      />
      {association.pr.status === "active" &&
      threads?.items.some(unresolvedThread) ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void repairComments()}
        >
          Address comments{threads.items.filter(unresolvedThread).reduce((count, thread) => count + thread.comments.filter(comment => !comment.isDeleted).length, 0) > 20 ? " · first 20 comments" : ""}
        </button>
      ) : null}
      <button className={button} disabled={busy} onClick={() => void load()}>
        {busy
          ? preparation.current ? "Preparing checkout…" : "Loading review…"
          : threads
            ? "Refresh comments"
            : "Load comments"}
      </button>
      {busy && preparation.current ? <button className={button} onClick={() => preparation.current?.abort()}>Cancel preparation</button> : null}
      {error ? <p role="alert">{error}</p> : null}
      {threads?.items.length === 0 ? <p>No review threads.</p> : null}
      {threads?.items
        .filter((thread) => !thread.isDeleted)
        .map((thread) => (
          <details
            key={thread.id}
            open={expanded === thread.id}
            onToggle={(event) => {
              if (event.currentTarget.open) rememberThread(thread.id);
              else if (expanded === thread.id) rememberThread(null);
            }}
            className="rounded-md border border-content/10 px-2 py-1"
          >
            <summary className="cursor-pointer break-words">
              Thread {thread.id} · {thread.status} ·{" "}
              {thread.threadContext?.filePath ?? "General discussion"}
            </summary>
            {expanded === thread.id ? (
              <div className="space-y-2 pt-2">
                <p className="text-content/50">
                  Right line {thread.threadContext?.rightFileStart?.line ?? "—"}{" "}
                  · Left line {thread.threadContext?.leftFileStart?.line ?? "—"}{" "}
                  · Iteration{" "}
                  {thread.pullRequestThreadContext?.iterationContext
                    ?.secondComparingIteration ?? "not supplied"}
                </p>
                {thread.comments
                  .filter((comment) => !comment.isDeleted)
                  .slice(0, 50)
                  .map((comment) => (
                    <div key={comment.id}>
                      <p className="text-content/55">
                        {comment.author?.displayName ?? "Unknown author"}
                      </p>
                      <AgentMarkdown
                        text={(comment.content ?? "").slice(0, 32_000)}
                        cwd={association.cwd}
                      />
                      {association.pr.status === "active" && unresolvedThread(thread) ? <button className={button} disabled={busy} onClick={() => void repairComments([thread], comment.id)}>Address this comment</button> : null}
                    </div>
                  ))}
                {thread.comments.length > 50 ? (
                  <p>Showing 50 comments. Open in Azure for the rest.</p>
                ) : null}
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void send(thread)}
                >
                  Send thread to agent
                </button>
              </div>
            ) : null}
          </details>
        ))}
      {threads && pageRef.current > 0 ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void load(Math.max(0, pageRef.current - 50))}
        >
          Previous threads
        </button>
      ) : null}
      {threads?.nextSkip != null ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void load(threads.nextSkip!)}
        >
          Next threads
        </button>
      ) : null}
      <details className="border-t border-content/10 pt-2 text-content/60">
        <summary className="cursor-pointer">
          Files, policies and statuses
        </summary>
        <AzureReviewSection
          association={association}
          section="iterations"
          onHandoff={onHandoff}
        />
        <AzureReviewSection
          association={association}
          section="policies"
          onHandoff={onHandoff}
        />
        <AzureReviewSection
          association={association}
          section="statuses"
          onHandoff={onHandoff}
        />
      </details>
    </div>
  );
}

type ReviewRow = {
  id: number | string;
  description?: string;
  status?: string;
  state?: string;
  sourceRefCommit?: { commitId: string };
  targetRefCommit?: { commitId: string };
  configuration?: { isBlocking?: boolean; type?: { displayName?: string } };
  context?: { genre?: string; name?: string };
  item?: { path: string };
  originalPath?: string;
  changeType?: string;
};

function AzureReviewSection({
  association,
  section,
  iteration = null,
  onHandoff,
}: {
  association: AzurePrAssociation;
  section: "iterations" | "policies" | "statuses" | "changes";
  iteration?: number | null;
  onHandoff: () => void;
}) {
  const [page, setPage] = useState<AzurePrPage<ReviewRow> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedIteration, setSelectedIteration] = useState<number | null>(
    null,
  );
  const [pageSkip, setPageSkip] = useState(0);
  const [filePath, setFilePath] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setBusy(false);
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const label = {
    iterations: "Iterations",
    policies: "Policies",
    statuses: "PR statuses",
    changes: "Changed files",
  }[section];
  const load = async (skip = 0) => {
    if (pending.current) return;
    const id = generation.current;
    const current = () => mounted.current && generation.current === id;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await readAzurePrSection<ReviewRow>(
        association.target,
        association.revision,
        section,
        skip,
        iteration,
      );
      if (current()) {
        setPage(next);
        setPageSkip(skip);
        setFilePath(null);
      }
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="space-y-1 border-t border-content/10 pt-2">
      <button className={button} disabled={busy} onClick={() => void load()}>
        {busy
          ? `Loading ${label.toLowerCase()}…`
          : `${page ? "Refresh" : "Load"} ${label.toLowerCase()}`}
      </button>
      {section === "policies" || section === "statuses" ? (
        <p className="text-content/50">
          {label} are provider evidence, not an independently verified CI
          result.
        </p>
      ) : null}
      {error ? (
        <p role="alert">
          {error}{" "}
          <button
            className={button}
            disabled={busy}
            onClick={() => void load()}
          >
            Retry {label.toLowerCase()}
          </button>
        </p>
      ) : null}
      {page?.items.length === 0 ? (
        <p>No {label.toLowerCase()} returned.</p>
      ) : null}
      {page?.items.map((row, index) => (
        <div
          key={`${row.id ?? row.item?.path}:${index}`}
          className="break-words px-2 py-1"
        >
          {section === "iterations" ? (
            <button
              className={`${button} w-full text-left`}
              onClick={() => setSelectedIteration(Number(row.id))}
            >
              Iteration {row.id} ·{" "}
              {row.sourceRefCommit?.commitId.slice(0, 8) ?? "unknown source"} →{" "}
              {row.targetRefCommit?.commitId.slice(0, 8) ?? "unknown target"} ·
              Show changes
            </button>
          ) : section === "changes" ? (
            <button
              className={`${button} w-full text-left`}
              onClick={() => setFilePath(row.item?.path ?? null)}
            >
              {row.changeType} ·{" "}
              {row.originalPath ? `${row.originalPath} → ` : ""}
              {row.item?.path} · View diff
            </button>
          ) : (
            <p>
              {row.configuration?.type?.displayName ??
                row.context?.name ??
                row.id}{" "}
              · {row.status ?? row.state ?? "unknown"}
              {row.configuration?.isBlocking ? " · required" : ""}
            </p>
          )}
          {row.description ? (
            <p className="text-content/55">{row.description.slice(0, 2000)}</p>
          ) : null}
        </div>
      ))}
      {page && pageSkip > 0 ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void load(Math.max(0, pageSkip - 50))}
        >
          Previous {label.toLowerCase()}
        </button>
      ) : null}
      {page?.nextSkip != null ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void load(page.nextSkip!)}
        >
          Next {label.toLowerCase()}
        </button>
      ) : null}
      {selectedIteration != null ? (
        <AzureReviewSection
          key={selectedIteration}
          association={association}
          section="changes"
          iteration={selectedIteration}
          onHandoff={onHandoff}
        />
      ) : null}
      {filePath && iteration ? (
        <AzurePrFile
          key={`${iteration}:${filePath}:${pageSkip}`}
          association={association}
          iteration={iteration}
          path={filePath}
          skip={pageSkip}
          onHandoff={onHandoff}
        />
      ) : null}
    </section>
  );
}

function AzurePrFile({
  association,
  iteration,
  path,
  skip,
  onHandoff,
}: {
  association: AzurePrAssociation;
  iteration: number;
  path: string;
  skip: number;
  onHandoff: () => void;
}) {
  const [file, setFile] = useState<Awaited<
    ReturnType<typeof readAzurePrFile>
  > | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [sending, setSending] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setSending(false);
    let cancelled = false;
    setError("");
    void readAzurePrFile(
      association.target,
      association.revision,
      iteration,
      path,
      skip,
    )
      .then((file) => {
        if (!cancelled) setFile(file);
      })
      .catch((error) => {
        if (!cancelled) setError(message(error));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
    };
  }, [association.target, association.revision, iteration, path, skip, retry]);
  const diff = useMemo(
    () => (file ? buildUnifiedFile(file.original, file.modified) : null),
    [file],
  );
  const send = async () => {
    if (!file || !diff || pending.current) return;
    const id = generation.current;
    const current = () => mounted.current && generation.current === id;
    pending.current = true;
    setSending(true);
    setError("");
    try {
      await readAzurePr(association.target, association.revision);
      if (!current()) return;
      const origin = `${azurePrUrl(association.target)} · account ${association.target.accountId} · checkout ${association.cwd} · session ${association.sourceSessionId ?? "not assigned"} · revision ${association.revision} · iteration ${iteration} · ${file.baseCommit} → ${file.sourceCommit}`;
      const context = contextFromText(
        `Azure PR #${association.target.number} · ${path}`,
        formatUnifiedHunk(diff.lines),
        origin,
      );
      context.entries[0].language = "diff";
      requestAgentContext({
        context,
        cwd: association.cwd,
        sourceSessionId: association.sourceSessionId,
        requireDestinationSelection: !association.sourceSessionId,
        onPrepared: onHandoff,
      });
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) {
        pending.current = false;
        setSending(false);
      }
    }
  };
  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert">
          {error}{" "}
          <button
            className={button}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry file
          </button>
        </p>
      ) : null}
      {!file && !error ? <p>Loading selected file…</p> : null}
      {file && diff ? (
        <>
          <p className="break-all text-content/50">
            Iteration {iteration}: {file.baseCommit} → {file.sourceCommit}
          </p>
          <UnifiedDiffView
            files={[
              {
                id: path,
                path,
                label: path,
                blocks: diff.blocks,
                additions: diff.additions,
                deletions: diff.deletions,
                contextActions: false,
              },
            ]}
            fill={false}
            fileLayout="cards"
          />
          <button
            className={button}
            disabled={sending}
            onClick={() => void send()}
          >
            {sending ? "Checking revision…" : "Send file diff to agent"}
          </button>
        </>
      ) : null}
    </div>
  );
}
