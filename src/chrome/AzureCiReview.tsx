import { ciRepair } from "../lib/repair";
import { RepairStatus } from "./RepairStatus";
import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  azureConnected,
  AZURE_CHANGE_EVENT,
  type AzureStatus,
} from "../lib/azure";
import { requestAgentContext } from "../lib/agentContext";
import {
  ciContext,
  ciKey,
  ciLogContext,
  ciLookup,
  ciMatchLabel,
  ciMatches,
  ciRead,
  ciScope,
  ciState,
  ciUrl,
  loadCiSources,
  parsePipelineUrl,
  saveCiSources,
  type CiCheckout,
  type CiHead,
  type CiJob,
  type CiJobs,
  type CiLog,
  type CiPage,
  type CiRun,
  type CiSource,
} from "../lib/azurePipelines";
import { Modal } from "./Modal";

const button =
  "rounded-md px-2 py-1 text-[12px] text-content hover:bg-content/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
const field =
  "w-full rounded-md border border-content/15 bg-content/5 px-2 py-1.5 text-[12px] text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const drafts = new Map<string, string>();

export function AzureCiReview({
  cwd,
  branch,
  sourceSessionId,
  enabled,
}: {
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  enabled: boolean;
}) {
  const [sources, setSources] = useState(() =>
    loadCiSources(cwd, branch, sourceSessionId),
  );
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const update = (next: CiSource[]) => {
    saveCiSources(next, cwd, branch, sourceSessionId);
    setSources(next);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="shrink-0 border-b border-content/10 px-2 py-1">
      <button
        ref={trigger}
        type="button"
        className={`${button} w-full text-left`}
        disabled={!enabled}
        onClick={() => setOpen(true)}
      >
        <span className="block">
          Azure Pipelines ·{" "}
          {sources.length
            ? `${sources.length} configured`
            : "Connect CI for this work"}
        </span>
        {sources.some((source) => source.last) ? (
          <span className="block truncate text-content/50">
            Saved:{" "}
            {sources
              .filter((source) => source.last)
              .map(
                (source) =>
                  `${source.definitionName}: ${ciState(source.last!.run.status, source.last!.run.result)}`,
              )
              .join(" · ")}{" "}
            · refresh to verify commit
          </span>
        ) : null}
      </button>
      {open && enabled ? (
        <CiDialog
          cwd={cwd}
          branch={branch}
          session={sourceSessionId}
          sources={sources}
          onChange={update}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

function CiDialog({
  cwd,
  branch,
  session,
  sources,
  onChange,
  onClose,
}: {
  cwd: string;
  branch: string;
  session?: string;
  sources: CiSource[];
  onChange: (sources: CiSource[]) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<AzureStatus>();
  const [checkout, setCheckout] = useState<CiCheckout>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(!sources.length);
  const scope = ciScope(cwd, branch, session);
  const [link, setLink] = useState(drafts.get(scope) ?? "");
  const [remote, setRemote] = useState("");
  const generation = useRef(0),
    pending = useRef(false);
  const sourceRef = useRef(sources);
  sourceRef.current = sources;
  useEffect(() => {
    const run = ++generation.current;
    setCheckout(undefined);
    setStatus(undefined);
    setError("");
    setBusy(false);
    pending.current = false;
    void Promise.all([azureConnected(), ciContext(cwd)])
      .then(([status, context]) => {
        if (run !== generation.current) return;
        if (context.branch !== branch)
          throw new Error(
            "Working branch changed. Refresh Changes and reopen CI.",
          );
        setStatus(status);
        setCheckout(context);
        setRemote(context.remotes.length === 1 ? context.remotes[0].url : "");
      })
      .catch((error) => {
        if (run === generation.current) setError(failure(error));
      });
    const changed = () => setVersion((v) => v + 1);
    window.addEventListener(AZURE_CHANGE_EVENT, changed);
    return () => {
      generation.current++;
      window.removeEventListener(AZURE_CHANGE_EVENT, changed);
    };
  }, [cwd, branch, version]);
  const connect = () =>
    void emit("open_settings", { section: "general" })
      .then(onClose)
      .catch((e) => setError(failure(e)));
  const add = async () => {
    if (pending.current || !checkout || !status?.accountId) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const id = generation.current;
    try {
      if (sourceRef.current.length >= 20)
        throw new Error(
          "Limit of 20 CI sources for this work. Remove an unused mapping first.",
        );
      const target = parsePipelineUrl(link, status.accountId);
      if (target.site !== status.site)
        throw new Error(`Connect ${target.site} in Azure settings first.`);
      const page = await ciLookup(target, {
        cwd,
        branch,
        commit: checkout.commit,
        remote,
      });
      if (id !== generation.current) return;
      const source: CiSource = {
        target: page.target,
        definitionName: page.definitionName,
        projectName: page.projectName,
        remote,
        cwd,
        branch,
        session,
      };
      onChange([
        ...sourceRef.current.filter(
          (value) => ciKey(value.target) !== ciKey(source.target),
        ),
        source,
      ]);
      setAdding(false);
      drafts.delete(scope);
      setLink("");
    } catch (error) {
      if (id === generation.current) setError(failure(error));
    } finally {
      if (id === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Modal
      trapFocus
      title="Azure Pipelines"
      onClose={onClose}
      className="max-h-[80vh]"
    >
      <div className="space-y-3 p-4 text-[12px]">
        <p className="break-words text-content/60">
          {status?.connected
            ? `${status.account} · ${status.site} · credentials on this device`
            : "Connect the shared Azure account with Build (Read) to inspect CI."}
        </p>
        <p className="break-all text-content/50">
          Worktree: {cwd}
          <br />
          Branch: {branch || "detached"} · Session:{" "}
          {session ?? "Choose when sending"}
          <br />
          Checkout commit: {checkout?.commit ?? "Checking…"}
        </p>
        <p className="text-content/50">
          Each source is independent. A passing run does not establish that all
          required CI passes. PR merge builds need verified source-head
          evidence.
        </p>
        <div className="flex flex-wrap gap-1">
          <button className={button} onClick={connect}>
            {status?.connected ? "Connection settings" : "Connect Azure DevOps"}
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => setVersion((v) => v + 1)}
          >
            Refresh checkout and CI
          </button>
          {!adding ? (
            <button className={button} onClick={() => setAdding(true)}>
              Add pipeline
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="break-words">
            {error}
          </p>
        ) : null}
        {adding ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label className="block">
              Pipeline link
              <input
                aria-label="Azure pipeline link"
                className={field}
                value={link}
                maxLength={2048}
                disabled={busy}
                placeholder="https://dev.azure.com/org/project/_build?definitionId=7"
                onChange={(e) => {
                  setLink(e.target.value);
                  drafts.delete(scope);
                  drafts.set(scope, e.target.value);
                  if (drafts.size > 100)
                    drafts.delete(drafts.keys().next().value!);
                }}
              />
            </label>
            <label className="block">
              Repository for this pipeline
              <select
                aria-label="Pipeline repository remote"
                className={field}
                disabled={busy}
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
              >
                <option value="">Choose the exact checkout remote</option>
                {checkout?.remotes.map((value) => (
                  <option key={`${value.name}:${value.url}`} value={value.url}>
                    {value.name} · {value.url}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={button}
              disabled={
                busy ||
                !status?.connected ||
                !checkout ||
                !link.trim() ||
                !remote
              }
            >
              {busy ? "Verifying…" : "Connect pipeline"}
            </button>
          </form>
        ) : null}
        {checkout
          ? sources.map((source) => (
              <CiSourcePanel
                key={`${ciKey(source.target)}:${checkout.commit}:${version}`}
                source={source}
                head={{
                  cwd,
                  branch,
                  commit: checkout.commit,
                  remote: source.remote,
                }}
                status={status}
                onSave={(last) =>
                  onChange(
                    sourceRef.current.map((value) =>
                      ciKey(value.target) === ciKey(source.target)
                        ? { ...value, last }
                        : value,
                    ),
                  )
                }
                onRemove={() =>
                  onChange(
                    sourceRef.current.filter(
                      (value) => ciKey(value.target) !== ciKey(source.target),
                    ),
                  )
                }
                onHandoff={onClose}
              />
            ))
          : null}
      </div>
    </Modal>
  );
}

function CiSourcePanel({
  source,
  head,
  status,
  onSave,
  onRemove,
  onHandoff,
}: {
  source: CiSource;
  head: CiHead;
  status?: AzureStatus;
  onSave: (last: CiSource["last"]) => void;
  onRemove: () => void;
  onHandoff: () => void;
}) {
  const [page, setPage] = useState<CiPage>();
  const [selected, setSelected] = useState<CiRun>();
  const [jobs, setJobs] = useState<CiJobs>();
  const [skip, setSkip] = useState(0);
  const [job, setJob] = useState<CiJob>();
  const [log, setLog] = useState<CiLog>();
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0),
    pending = useRef(false);
  const sameAccount =
    !!status?.connected &&
    status.site === source.target.site &&
    status.accountId === source.target.accountId;
  const run = async (
    action: (current: () => boolean) => Promise<void>,
    detail = false,
  ) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    (detail ? setDetailError : setError)("");
    const id = generation.current;
    try {
      await action(() => id === generation.current);
    } catch (error) {
      if (id === generation.current)
        (detail ? setDetailError : setError)(failure(error));
    } finally {
      if (id === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const refresh = (continuation: string | null = null) =>
    void run(async (current) => {
      const next = await ciLookup(source.target, head, continuation);
      if (!current()) return;
      setPage(next);
      const unchanged =
        selected &&
        next.items.some(
          (value) =>
            value.id === selected.id && value.revision === selected.revision,
        );
      if (!unchanged) {
        setSelected(undefined);
        setJobs(undefined);
        setJob(undefined);
        setLog(undefined);
        setDetailError(
          selected
            ? "Selected run changed or left this page. Choose fresh evidence."
            : "",
        );
      }
    });
  useEffect(() => {
    const id = ++generation.current;
    pending.current = false;
    if (sameAccount) refresh();
    else
      setError(
        "Reconnect the mapped Azure organization/account to read this source.",
      );
    return () => {
      if (generation.current === id) generation.current++;
    };
  }, [sameAccount]);
  const select = (value: CiRun) =>
    void run(async (current) => {
      const checked = await ciRead<CiRun>(
        source.target,
        head,
        value,
        "summary",
      );
      if (!current()) return;
      setSelected(checked);
      setJobs(undefined);
      setJob(undefined);
      setLog(undefined);
      setSkip(0);
      setDetailError("");
      onSave({ run: checked, commit: head.commit, checkedAt: Date.now() });
    });
  const loadJobs = (skip = 0) =>
    void run(async (current) => {
      if (!selected) return;
      const data = await ciRead<CiJobs>(source.target, head, selected, "jobs", {
        skip,
      });
      if (!current()) return;
      setJobs(data);
      setSkip(skip);
      setJob(undefined);
      setLog(undefined);
    }, true);
  const loadLog = (value: CiJob, startLine?: number) =>
    void run(async (current) => {
      if (!selected || !value.attempt || !value.logId) return;
      const data = await ciRead<CiLog>(source.target, head, selected, "log", {
        recordId: value.id,
        attempt: value.attempt,
        logId: value.logId,
        startLine,
      });
      if (current()) {
        setJob(value);
        setLog(data);
      }
    }, true);
  const handoff = (repair = false) =>
    void run(async (current) => {
      if (!selected || !job || !log || !ciMatches(selected)) return;
      const checked = await ciRead<CiLog>(
        source.target,
        head,
        selected,
        "log",
        {
          recordId: job.id,
          attempt: log.attempt,
          logId: log.logId,
          startLine: log.startLine,
        },
      );
      if (!current()) return;
      const draft = repair ? ciRepair(source, head, selected, job, checked) : undefined;
      requestAgentContext({
        repair: draft?.evidence,
        context: draft?.context ?? ciLogContext(source, head, selected, job, checked),
        cwd: head.cwd,
        sourceSessionId: source.session,
        requireDestinationSelection: !source.session,
      });
      onHandoff();
    }, true);
  const external = (id?: number) =>
    void openUrl(ciUrl(source.target, id)).catch((error) =>
      setError(failure(error)),
    );
  return (
    <section className="space-y-2 border-t border-content/10 pt-3">
      <RepairStatus scope={ciKey(source.target)} cwd={head.cwd} />
      <h3 className="font-medium">
        {source.definitionName} · {source.projectName}
      </h3>
      <details>
        <summary className="cursor-pointer text-content/50">
          Pipeline mapping and account
        </summary>
        <p className="break-all text-content/50">
          {source.target.site} · account {source.target.accountId}
          <br />
          Definition {source.target.definition} · {source.target.repositoryType}
          /{source.target.repositoryId}
          <br />
          {source.remote}
        </p>
      </details>
      <div className="flex flex-wrap gap-1">
        <button
          className={button}
          disabled={busy || !sameAccount}
          onClick={() => refresh()}
        >
          Refresh runs
        </button>
        <button className={button} onClick={() => external()}>
          Open pipeline in Azure
        </button>
        <button className={button} disabled={busy} onClick={onRemove}>
          Remove mapping
        </button>
      </div>
      {busy ? (
        <p role="status" className="text-content/50">
          Loading selected CI evidence…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words">
          {error}
        </p>
      ) : null}
      {page && !page.items.some(ciMatches) ? (
        <p className="text-content/60">
          No matching run in this page for checkout {head.commit.slice(0, 8)}.
          Check the mapping or load older runs.
        </p>
      ) : null}
      {page?.items.map((value) => (
        <button
          key={value.id}
          className={`${button} block w-full text-left ${selected?.id === value.id ? "bg-content/10" : ""}`}
          disabled={busy || !sameAccount}
          onClick={() => select(value)}
        >
          <span className="block">
            Run {value.id} · {value.number} ·{" "}
            {ciState(value.status, value.result)}
          </span>
          <span className="block break-words text-content/50">
            {ciMatchLabel(value)} ·{" "}
            {value.commit?.slice(0, 8) || "unknown commit"} · {value.branch}
          </span>
        </button>
      ))}
      {page?.continuation ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => refresh(page.continuation)}
        >
          Older runs
        </button>
      ) : null}
      {selected ? (
        <div className="space-y-2 border-t border-content/10 pt-2">
          <p>
            Selected run {selected.id} ·{" "}
            {ciState(selected.status, selected.result)} ·{" "}
            {ciMatchLabel(selected)}
          </p>
          <button className={button} onClick={() => external(selected.id)}>
            Open run in Azure
          </button>
          <button
            className={button}
            disabled={busy || !sameAccount}
            onClick={() => loadJobs()}
          >
            Load jobs
          </button>
          {detailError ? (
            <p role="alert" className="break-words">
              {detailError}
            </p>
          ) : null}
          {jobs?.items.map((value) => (
            <div
              key={`${value.id}:${value.attempt}`}
              className="space-y-1 rounded border border-content/10 p-2"
            >
              <p className="break-words">
                {value.parentName ? `${value.parentName} / ` : ""}
                {value.name} · {value.type} ·{" "}
                {ciState(value.state, value.result)} · attempt{" "}
                {value.attempt ?? "unknown"}
              </p>
              {value.previousAttempts?.length ? (
                <p className="text-content/50">
                  Earlier attempts:{" "}
                  {value.previousAttempts
                    .map((value) => value.attempt)
                    .join(", ")}{" "}
                  · open in Azure for historical logs
                </p>
              ) : null}
              <button
                className={button}
                disabled={
                  busy || !sameAccount || !value.logId || !value.attempt
                }
                onClick={() => loadLog(value)}
              >
                Load log · {value.name}
              </button>
            </div>
          ))}
          {jobs && skip > 0 ? (
            <button
              className={button}
              disabled={busy}
              onClick={() => loadJobs(Math.max(0, skip - 50))}
            >
              Previous jobs
            </button>
          ) : null}
          {jobs?.nextSkip != null ? (
            <button
              className={button}
              disabled={busy}
              onClick={() => loadJobs(jobs.nextSkip!)}
            >
              Next jobs
            </button>
          ) : null}
          {job && log ? (
            <section className="space-y-2">
              <h4>
                {job.name} · attempt {log.attempt} · log {log.logId}
              </h4>
              <p className="text-content/50">
                Lines {log.startLine + 1}–{log.endLine + 1} of {log.lineCount}.
                Bounded excerpt; common secret patterns removed. Review before
                sending.
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-content/10 bg-content/5 p-2 text-[11px]">
                {log.text || "No log text available."}
              </pre>
              <div className="flex flex-wrap gap-1">
                {log.startLine > 0 ? (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      loadLog(job, Math.max(0, log.startLine - 500))
                    }
                  >
                    Earlier log lines
                  </button>
                ) : null}
                {log.endLine + 1 < log.lineCount ? (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => loadLog(job, log.endLine + 1)}
                  >
                    Later log lines
                  </button>
                ) : null}
                <button
                  className={button}
                  disabled={busy || !sameAccount || !ciMatches(selected)}
                  onClick={() => handoff()}
                >
                  Send log to agent
                </button>
                {selected.result === "failed" && job.result === "failed" && ciMatches(selected) ? <button className={button} disabled={busy || !sameAccount} onClick={() => handoff(true)}>Fix CI</button> : null}
              </div>
              {!ciMatches(selected) ? (
                <p className="text-content/50">
                  This run is not verified for the current checkout commit.
                  Refresh or choose matching evidence before handoff.
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
