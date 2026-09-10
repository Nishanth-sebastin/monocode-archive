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
import { Modal } from "./Modal";

const button =
  "rounded-md px-2 py-1 text-[12px] text-content hover:bg-content/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
const field =
  "w-full rounded-md border border-content/15 bg-content/5 px-2 py-1.5 text-[12px] text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const drafts = new Map<string, { link: string; branch: string }>();
const threadSelections = new Map<string, { id: number | null; page: number }>();
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function AzurePrReview({
  cwd,
  branch,
  sourceSessionId,
  enabled,
  linkedWorkItem,
}: {
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  enabled: boolean;
  linkedWorkItem?: LinkedWorkItem;
}) {
  const [association, setAssociation] = useState(() =>
    loadAzurePrAssociation(cwd, branch, sourceSessionId),
  );
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
    setOpen(false);
  }, [cwd, branch, sourceSessionId]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="shrink-0 border-b border-content/10 px-2 py-1">
      <button
        ref={trigger}
        type="button"
        disabled={!enabled}
        className={`${button} w-full text-left`}
        onClick={() => setOpen(true)}
      >
        {association ? (
          <>
            <span className="block truncate">
              Azure PR #{association.pr.pullRequestId} · {association.pr.title}
            </span>
            <span className="text-content/50">
              {association.pr.status} ·{" "}
              {association.pr.reviewers.some((reviewer) => reviewer.vote < 0)
                ? "Review needs attention"
                : "Open review"}{" "}
              · saved revision {association.revision.slice(0, 8)}
            </span>
          </>
        ) : (
          "Review Azure PRs"
        )}
      </button>
      {open && enabled ? (
        <AzurePrDialog
          cwd={cwd}
          branch={branch}
          sourceSessionId={sourceSessionId}
          linkedWorkItem={linkedWorkItem}
          association={association}
          onChange={update}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

function AzurePrDialog({
  cwd,
  branch,
  sourceSessionId,
  association,
  linkedWorkItem,
  onChange,
  onClose,
}: {
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  association: AzurePrAssociation | null;
  linkedWorkItem?: LinkedWorkItem;
  onChange: (value: AzurePrAssociation | null) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<AzureStatus | null>(null);
  const [choosing, setChoosing] = useState(!association);
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
    if (!status?.connected || !status.accountId) {
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
  return (
    <Modal
      trapFocus
      title="Azure PR review"
      onClose={onClose}
      className="max-h-[80vh]"
    >
      <div ref={body} className="space-y-3 p-4 text-[12px]">
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
        {!choosing && association ? (
          <button className={button} onClick={() => setChoosing(true)}>
            Choose another PR
          </button>
        ) : null}
        {choosing ? (
          <section className="space-y-2" aria-label="Related Azure PRs">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">PRs for this work</h3>
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
                No accessible PR matches found. Link another PR below.
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
        {choosing ? (
          <details open={!!link}>
            <summary className="cursor-pointer text-content/60">
              Link another PR manually
            </summary>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void find();
              }}
            >
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
              <label className="block">
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
              <button
                className={button}
                disabled={busy || !connected || !link.trim()}
              >
                {busy ? "Loading…" : "Find PR"}
              </button>
            </form>
          </details>
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
            <h3 className="font-medium">
              #{association.pr.pullRequestId} {association.pr.title}
            </h3>
            <p>
              {association.pr.isDraft ? "Draft · " : ""}
              {association.pr.status} · {association.projectName}/
              {association.repositoryName}
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
            </details>
            <div className="flex flex-wrap gap-1">
              <button
                className={button}
                disabled={busy || !sameAccount}
                onClick={() => void refresh()}
              >
                Refresh PR
              </button>
              <button
                className={button}
                onClick={() => {
                  void openUrl(azurePrUrl(association.target)).catch((error) =>
                    setError(message(error)),
                  );
                }}
              >
                Open in Azure
              </button>
              <button
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
              </button>
            </div>
            {!sameAccount ? (
              <p role="alert">
                Reconnect the linked Azure account to read this PR, or choose
                another PR.
              </p>
            ) : !verified ? (
              <p>
                Saved snapshot. Refresh PR before loading or sending review
                context.
              </p>
            ) : null}
            <p>
              Reviewers:{" "}
              {association.pr.reviewers
                .slice(0, 50)
                .map(
                  (reviewer) =>
                    `${reviewer.displayName}: ${vote(reviewer.vote)}${reviewer.isRequired ? " (required)" : ""}`,
                )
                .join("; ") || "None listed"}
            </p>
            {verified && sameAccount ? (
              <AzurePrDetails
                key={`${association.revision}:${association.target.repository}:${association.target.number}`}
                association={association}
                onStale={() => {
                  setVerified(false);
                  setError(
                    "PR revision or access changed. Refresh PR before sending context.",
                  );
                }}
                onHandoff={onClose}
              />
            ) : null}
            <p className="text-content/45">
              Push the branch and create the PR in your Git/Azure tools.
              Inspection and agent context do not publish or merge.
            </p>
          </section>
        ) : null}
      </div>
    </Modal>
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
  onStale,
  onHandoff,
}: {
  association: AzurePrAssociation;
  onStale: () => void;
  onHandoff: () => void;
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
  const rememberThread = (id: number | null) => {
    threadSelections.delete(selectionKey);
    threadSelections.set(selectionKey, { id, page: pageRef.current });
    if (threadSelections.size > 100)
      threadSelections.delete(threadSelections.keys().next().value!);
    setExpanded(id);
  };
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      if (mounted.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const load = (skip = pageRef.current) =>
    read(async () => {
      const next = await readAzurePrSection<AzurePrThread>(
        association.target,
        association.revision,
        "threads",
        skip,
      );
      if (mounted.current) {
        pageRef.current = skip;
        setThreads(next);
      }
    });
  const send = (thread: AzurePrThread) =>
    read(async () => {
      // Recheck the revision before opening the existing #8 destination picker.
      try {
        await readAzurePr(association.target, association.revision);
      } catch (error) {
        if (mounted.current) onStale();
        throw error;
      }
      if (!mounted.current) return;
      requestAgentContext({
        context: azurePrContext(association, thread),
        cwd: association.cwd,
        sourceSessionId: association.sourceSessionId,
        requireDestinationSelection: !association.sourceSessionId,
      });
      onHandoff();
    });
  return (
    <div className="space-y-2">
      <button className={button} disabled={busy} onClick={() => void load()}>
        {busy
          ? "Loading review…"
          : threads
            ? "Refresh threads"
            : "Load threads"}
      </button>
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
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
      if (mounted.current) {
        setPage(next);
        setPageSkip(skip);
        setFilePath(null);
      }
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      if (mounted.current) {
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
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setError("");
    setFile(null);
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
    };
  }, [association.target, association.revision, iteration, path, skip, retry]);
  const diff = useMemo(
    () => (file ? buildUnifiedFile(file.original, file.modified) : null),
    [file],
  );
  const send = async () => {
    if (!file || !diff || pending.current) return;
    pending.current = true;
    setSending(true);
    setError("");
    try {
      await readAzurePr(association.target, association.revision);
      if (!mounted.current) return;
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
      });
      onHandoff();
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      if (mounted.current) {
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
