import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FAILING_CHECK_CONCLUSIONS,
  githubPrDiff,
  githubPrState,
  githubRepo,
  githubReviewDecisionLabel,
  githubReviewStateLabel,
  githubWorkItemComment,
  githubWorkItemThread,
  type GithubPrDiff,
  type GithubPrState,
  type GithubWorkItemComment,
  type GithubWorkItemThread,
} from "../lib/githubTasks";
import {
  githubCiRepair,
  githubCommentsRepair,
  type RepairEvidence,
} from "../lib/repair";
import { requestAgentContext, type AgentContext } from "../lib/agentContext";
import { notifyGitChanged } from "../lib/fs";
import { openProjectPath } from "../lib/recents";
import { openWatchSheet } from "../lib/watchers";
import { RepairStatus } from "./RepairStatus";
import { InboxPrDiff } from "../surfaces/InboxPrDiff";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";

const button =
  "rounded-md px-2 py-1 text-[12px] text-content hover:bg-content/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
const field =
  "w-full rounded-md border border-content/15 bg-content/5 px-2 py-1.5 text-[12px] text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isReviewThread = (comment: GithubWorkItemComment) =>
  comment.kind === "review_comment";

/** Same shape as the repair evidence scope — repo case is significant. */
export function githubPrScope(repo: string, number: number): string {
  return `github-pr:${repo.trim()}#${number}`;
}

/**
 * GitHub pull-request review — the PR identity is explicit (`repo` +
 * `number`) and verified against the checkout, so identical numbers in
 * different repositories never share a surface.
 */
export function GithubPrReview({
  embedded = false,
  cwd,
  repo,
  number,
  branch = "",
  sourceSessionId,
  enabled,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  /** owner/repo the PR lives in — empty resolves it from the checkout. */
  repo: string;
  number: number;
  branch?: string;
  sourceSessionId?: string;
  enabled: boolean;
  onClose: () => void;
  onReveal?: () => void;
}) {
  if (enabled && number <= 0)
    return (
      <p role="alert" className="px-5 py-4 text-[12px]">
        This delivery is missing its GitHub repository or PR number. Open the
        review again from the PR or a session checkout.
      </p>
    );
  return enabled ? (
    <GithubPrPanel
      key={githubPrScope(repo || cwd, number)}
      embedded={embedded}
      cwd={cwd}
      repo={repo}
      number={number}
      branch={branch}
      sourceSessionId={sourceSessionId}
      onClose={onClose}
      onReveal={onReveal}
    />
  ) : null;
}

function GithubPrPanel({
  embedded,
  cwd,
  repo: boundRepo,
  number,
  branch,
  sourceSessionId,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  repo: string;
  number: number;
  branch?: string;
  sourceSessionId?: string;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [pr, setPr] = useState<GithubPrState | null>(null);
  const [repo, setRepo] = useState(boundRepo);
  const [repoError, setRepoError] = useState("");
  const [diff, setDiff] = useState<GithubPrDiff | null>(null);
  const [thread, setThread] = useState<GithubWorkItemThread | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [repairRefresh, setRepairRefresh] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const repairDraft = useRef<{ key: string; instruction: string } | null>(null);
  const scope = githubPrScope(repo || boundRepo || cwd, number);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  const run = async (action: (current: () => boolean) => Promise<void>) => {
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

  const refresh = () =>
    run(async (current) => {
      // The repository binding is part of the PR identity — a checkout that
      // resolves to a different repo must not show this PR's number.
      const resolved = (await githubRepo(cwd).catch(() => "")).trim();
      if (!current()) return;
      if (boundRepo && resolved && resolved.toLowerCase() !== boundRepo.toLowerCase()) {
        setVerified(false);
        setRepoError(
          `This checkout resolves to ${resolved}; the PR is bound to ${boundRepo}. Open a checkout of that repository.`,
        );
        return;
      }
      setRepoError("");
      if (resolved && resolved !== repo) setRepo(resolved);
      const [state, nextDiff, nextThread] = await Promise.all([
        githubPrState(cwd, number),
        githubPrDiff(cwd, number).catch(() => null),
        githubWorkItemThread(cwd, "pr", number, { force: true }),
      ]);
      if (!current()) return;
      if (state.number !== number)
        throw new Error("GitHub returned a different PR. Check the repository binding.");
      setPr(state);
      setDiff(nextDiff);
      setThread(nextThread);
      setVerified(true);
    });

  useEffect(() => {
    void refresh();
    // Read once on open or after an evidence refresh; never polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairRefresh]);

  const onRefreshEvidence = (instruction: string) => {
    repairDraft.current = { key: scope, instruction };
    onReveal?.();
    setRepairRefresh((value) => value + 1);
  };
  const repairInstruction =
    repairDraft.current?.key === scope
      ? repairDraft.current.instruction
      : undefined;

  const sendEvidence = (
      prepare: () => Promise<{
        evidence: RepairEvidence;
        context: AgentContext;
      }>,
    ) =>
    run(async (current) => {
      const draft = await prepare();
      if (!current()) return;
      requestAgentContext({
        context: {
          ...draft.context,
          instruction: repairInstruction ?? draft.context.instruction,
        },
        repair: draft.evidence,
        onRefreshEvidence,
        cwd: draft.evidence.head.cwd,
        sourceSessionId,
        requireDestinationSelection: !sourceSessionId,
        onPrepared: onClose,
      });
    });

  const sendComments = (comments: GithubWorkItemComment[]) =>
    sendEvidence(() => githubCommentsRepair({ cwd, repo, number, comments }));

  const sendChecks = () =>
    sendEvidence(() => githubCiRepair({ cwd, repo, number }));

  const openWorktree = () =>
    run(async (current) => {
      if (!pr?.headRefOid)
        throw new Error("Refresh the PR to read its head before preparing a checkout.");
      const path = await invoke<string>("github_pr_prepare_checkout", {
        cwd,
        repo,
        number,
        expectedRevision: pr.headRefOid,
        requestId: crypto.randomUUID(),
      });
      if (!current()) return;
      notifyGitChanged(cwd);
      openProjectPath(path);
    });

  const threads = (thread?.comments ?? []).filter(isReviewThread);
  const conversation = (thread?.comments ?? []).filter(
    (comment) => !isReviewThread(comment),
  );
  const unresolved = threads.filter((comment) => !comment.resolved);
  const failing = (pr?.checks ?? []).filter((check) =>
    FAILING_CHECK_CONCLUSIONS.includes(check.conclusion),
  );
  const open = pr?.state.trim().toUpperCase() === "OPEN";
  const checksSummary = (() => {
    const checks = pr?.checks ?? [];
    if (!checks.length) return "No checks";
    const inProgress = checks.filter(
      (check) => check.status !== "completed",
    ).length;
    const parts = [
      `${checks.length - failing.length - inProgress}/${checks.length} passing`,
    ];
    if (failing.length) parts.push(`${failing.length} failing`);
    if (inProgress) parts.push(`${inProgress} pending`);
    return parts.join(" · ");
  })();

  return (
    <section
      aria-label="GitHub pull request"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto w-full max-w-3xl space-y-3 px-5 py-4 text-[12px]">
        {!embedded ? (
          <header className="flex items-center justify-between gap-3 border-b border-content/10 pb-3">
            <h2 className="text-[13px] font-medium">Pull request</h2>
            <span className="truncate text-content/50" title={cwd}>
              {repo ? `${repo} · ` : ""}
              {branch || "Repository checkout"}
            </span>
          </header>
        ) : null}
        {pr ? (
          <section className="space-y-2">
            {!embedded ? (
              <h3 className="font-medium">
                #{pr.number} {pr.title}
              </h3>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-content/55">
              <span className="rounded bg-content/5 px-1.5 py-0.5 text-[11px] text-content/75">
                {pr.isDraft
                  ? "Draft"
                  : pr.state.trim().toUpperCase() === "OPEN"
                    ? "Open"
                    : pr.state || "Unknown"}
              </span>
              {repo ? <span>{repo}</span> : null}
              {githubReviewDecisionLabel(pr.reviewDecision) ? (
                <span>{githubReviewDecisionLabel(pr.reviewDecision)}</span>
              ) : null}
              {pr.mergeStateStatus ? (
                <span>Merge: {pr.mergeStateStatus.toLowerCase()}</span>
              ) : null}
              <span>{checksSummary}</span>
              <span
                className="min-w-0 truncate"
                title={`${pr.headRefName} → ${pr.baseRefName}`}
              >
                {pr.headRefName} → {pr.baseRefName}
              </span>
            </p>
            <details>
              <summary className="cursor-pointer text-content/60">
                Repository and revision
              </summary>
              <p className="break-all text-content/55">
                Repository: {repo || "resolved from checkout"}
                <br />
                {pr.headRefName} → {pr.baseRefName}
                <br />
                Head revision: {pr.headRefOid || "unknown"}
              </p>
            </details>
            <div className="flex flex-wrap gap-1">
              <button
                className={button}
                disabled={busy}
                onClick={() => void refresh()}
              >
                Refresh PR
              </button>
              <button
                className={button}
                onClick={() => {
                  void openUrl(pr.url).catch((error) =>
                    setError(message(error)),
                  );
                }}
              >
                Open on GitHub
              </button>
              <button
                className={button}
                disabled={busy || !open}
                onClick={() => void openWorktree()}
              >
                Open in worktree
              </button>
              {open ? (
                <button
                  className={button}
                  onClick={() =>
                    openWatchSheet({
                      source: {
                        kind: "github-pr",
                        cwd,
                        repo,
                        number,
                        ...(sourceSessionId
                          ? { sessionId: sourceSessionId }
                          : {}),
                      },
                      name: `Reviews · ${repo}#${number}`,
                    })
                  }
                >
                  Watch reviews
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
        {repoError ? <p role="alert">{repoError}</p> : null}
        {!verified && !repoError ? (
          <p>{busy ? "Loading PR…" : "Could not read this PR. Retry with Refresh PR."}</p>
        ) : null}
        {verified && pr ? (
          <RepairStatus scope={githubPrScope(repo, number)} cwd={cwd} />
        ) : null}
        {verified && pr ? (
          <GithubPrSections
            key={`${pr.headRefOid}:${repairRefresh}`}
            cwd={cwd}
            number={number}
            pr={pr}
            diff={diff}
            thread={thread}
            threads={threads}
            conversation={conversation}
            unresolved={unresolved}
            failing={failing}
            busy={busy}
            sendComments={sendComments}
            sendChecks={sendChecks}
            onThreadRefresh={() => void refresh()}
          />
        ) : null}
        {error ? (
          <p role="alert" className="break-words">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function GithubPrSections({
  cwd,
  number,
  pr,
  diff,
  thread,
  threads,
  conversation,
  unresolved,
  failing,
  busy,
  sendComments,
  sendChecks,
  onThreadRefresh,
}: {
  cwd: string;
  number: number;
  pr: GithubPrState;
  diff: GithubPrDiff | null;
  thread: GithubWorkItemThread | null;
  threads: GithubWorkItemComment[];
  conversation: GithubWorkItemComment[];
  unresolved: GithubWorkItemComment[];
  failing: GithubPrState["checks"];
  busy: boolean;
  sendComments: (comments: GithubWorkItemComment[]) => void;
  sendChecks: () => void;
  onThreadRefresh: () => void;
}) {
  const open = pr.state.trim().toUpperCase() === "OPEN";
  return (
    <div className="space-y-2">
      {open && unresolved.length ? (
        <button className={button} disabled={busy} onClick={() => sendComments(unresolved)}>
          Address comments
        </button>
      ) : null}
      {open && failing.length ? (
        <button className={button} disabled={busy} onClick={sendChecks}>
          Send failing checks to agent
        </button>
      ) : null}
      <details className="rounded-md border border-content/10 px-2 py-1">
        <summary className="cursor-pointer text-content/60">
          Checks ({pr.checks.length})
        </summary>
        {pr.checks.length === 0 ? (
          <p className="pt-1 text-content/50">No checks on this PR head.</p>
        ) : (
          <ul className="space-y-1 pt-1">
            {pr.checks.slice(0, 50).map((check, index) => (
              <li key={`${check.name}:${index}`} className="break-words">
                <span
                  className={
                    FAILING_CHECK_CONCLUSIONS.includes(check.conclusion)
                      ? "text-rose-400/90"
                      : check.status !== "completed"
                        ? "text-content/60"
                        : "text-emerald-400/90"
                  }
                >
                  {check.name} · {check.conclusion || check.status || "unknown"}
                </span>
                {check.outputTitle ? (
                  <span className="text-content/50"> · {check.outputTitle}</span>
                ) : null}
                {check.url ? (
                  <button
                    className={button}
                    onClick={() => void openUrl(check.url).catch(() => undefined)}
                  >
                    Open run
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </details>
      <section aria-label="Pull request diff" className="space-y-1">
        <h4 className="text-content/60">Changed files</h4>
        {diff ? (
          <InboxPrDiff diff={diff} />
        ) : (
          <p className="text-content/50">Diff unavailable. Refresh PR to retry.</p>
        )}
      </section>
      <section aria-label="Review threads" className="space-y-1">
        <h4 className="text-content/60">
          Review threads ({threads.length}
          {thread?.truncated ? " · first page" : ""})
        </h4>
        {threads.length === 0 ? <p>No review threads.</p> : null}
        {threads.map((comment) => (
          <GithubReviewThread
            key={comment.id}
            cwd={cwd}
            number={number}
            comment={comment}
            open={open}
            busy={busy}
            sendComments={sendComments}
            onThreadRefresh={onThreadRefresh}
          />
        ))}
      </section>
      {conversation.length ? (
        <details className="border-t border-content/10 pt-2 text-content/60">
          <summary className="cursor-pointer">
            Conversation ({conversation.length})
          </summary>
          <div className="space-y-2 pt-2">
            {conversation.slice(0, 50).map((comment) => (
              <div key={comment.id}>
                <p className="text-content/55">
                  {comment.author}
                  {comment.state
                    ? ` · ${githubReviewStateLabel(comment.state) || comment.state.toLowerCase()}`
                    : ""}
                </p>
                <AgentMarkdown text={comment.body.slice(0, 32_000)} cwd={cwd} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function GithubReviewThread({
  cwd,
  number,
  comment,
  open,
  busy,
  sendComments,
  onThreadRefresh,
}: {
  cwd: string;
  number: number;
  comment: GithubWorkItemComment;
  open: boolean;
  busy: boolean;
  sendComments: (comments: GithubWorkItemComment[]) => void;
  onThreadRefresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const replies = (comment.replies ?? []).slice(0, 50);
  const reply = async () => {
    if (replying || !draft.trim()) return;
    setReplying(true);
    setReplyError("");
    try {
      await githubWorkItemComment(cwd, "pr", number, draft, {
        inReplyTo: comment.threadId,
      });
      if (!mounted.current) return;
      setDraft("");
      onThreadRefresh();
    } catch (error) {
      if (mounted.current) setReplyError(message(error));
    } finally {
      if (mounted.current) setReplying(false);
    }
  };
  return (
    <details className="rounded-md border border-content/10 px-2 py-1">
      <summary className="cursor-pointer break-words">
        {comment.path || "Review thread"}
        {comment.line != null ? `:${comment.line}` : ""} ·{" "}
        {comment.resolved ? "Resolved" : "Unresolved"} · {1 + replies.length}{" "}
        comments
      </summary>
      <div className="space-y-2 pt-2">
        {[comment, ...replies].map((row) => (
          <div key={row.id}>
            <p className="text-content/55">{row.author}</p>
            <AgentMarkdown text={row.body.slice(0, 32_000)} cwd={cwd} />
          </div>
        ))}
        {open && !comment.resolved ? (
          <button
            className={button}
            disabled={busy}
            onClick={() => sendComments([comment])}
          >
            Send thread to agent
          </button>
        ) : null}
        {open && comment.threadId ? (
          <div className="space-y-1">
            <textarea
              aria-label="Reply to review thread"
              className={field}
              rows={2}
              maxLength={64_000}
              value={draft}
              disabled={replying}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Reply inside this review thread…"
            />
            <button
              className={button}
              disabled={replying || !draft.trim()}
              onClick={() => void reply()}
            >
              {replying ? "Replying…" : "Reply"}
            </button>
            {replyError ? <p role="alert">{replyError}</p> : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}
