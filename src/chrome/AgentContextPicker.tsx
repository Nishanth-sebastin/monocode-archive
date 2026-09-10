import { searchSessions, type SessionSummary } from "../lib/sessionStore";
import { useEffect, useRef, useState } from "react";
import { getVerifiedFamilies } from "../lib/repositoryFamilies";
import type { AgentContextRequest } from "../lib/agentContext";
import {
  HARNESS_TITLE,
  HARNESSES,
  harnessSupportsAttachments,
  newDefaultSession,
  newSession,
  sessionWorkCwd,
  type Session,
} from "../lib/session";
import type { RecentProject } from "../lib/recents";
import { wslLocation } from "../lib/paths";
import { Modal } from "./Modal";
import { CwdPicker } from "./CwdPicker";
import { SecondOpinionButton } from "./SecondOpinionButton";
import { Check, Plus } from "./icons";

export function AgentContextPicker({
  request,
  sessions,
  history = [],
  recents,
  onPrepare,
  onOpen,
  onClose,
}: {
  request: AgentContextRequest;
  sessions: readonly Session[];
  history?: readonly SessionSummary[];
  recents: RecentProject[];
  onPrepare: (
    request: AgentContextRequest,
    destination: string | Session,
    signal?: AbortSignal,
  ) => string | Promise<string>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const tickets =
    request.context.entries.length > 0 &&
    request.context.entries.every((entry) => !!entry.ticket);
  const [destination, setDestination] = useState(
    request.requireDestinationSelection ? "" : request.sourceSessionId ?? "new",
  );
  const [fresh, setFresh] = useState(() => newDefaultSession(request.cwd));
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [savedMatches, setSavedMatches] = useState<Pick<SessionSummary, "id" | "title" | "cwd" | "harness">[]>([]);
  useEffect(() => {
    setSavedMatches([]);
    if (!search.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchSessions({ query: search, includeArchived: false }).then(result => {
        if (!cancelled) setSavedMatches(result.hits.flatMap(hit => { const harness = HARNESSES.find(harness => harness === hit.harness); return harness ? [{ id: hit.sessionId, title: hit.title, cwd: hit.cwd, harness }] : []; }));
      }).catch(() => { if (!cancelled) setError("Could not search saved conversations. Try again."); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [search]);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const preparation = useRef<AbortController | null>(null);
  useEffect(() => () => preparation.current?.abort(), []);
  const body = useRef<HTMLDivElement>(null);
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [
        ...(body.current
          ?.closest('[role="dialog"]')
          ?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea, summary, select",
          ) ?? []),
      ].filter((el) => el.getClientRects().length);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      if (!submitting.current) trigger.current?.focus();
    };
  }, []);
  const available = [...new Map([...savedMatches, ...history, ...sessions].map(session => [session.id, session])).values()];
  const target =
    destination === "new"
      ? fresh
      : available.find((session) => session.id === destination);
  const unsupported = !destination
    ? "Choose an agent conversation or a new conversation."
    : !target
    ? "Conversation closed. Choose another."
    : !tickets &&
        request.context.attachments.length &&
        !harnessSupportsAttachments(target.harness)
      ? "This agent does not support attachments."
      : destination === "new" && (!fresh.cwd || fresh.cwd === "~")
        ? "Choose a project."
        : "";
  const knownProjects = [
    ...new Map(
      [
        ...recents,
        ...[...getVerifiedFamilies().values()].flatMap((family) =>
          family.worktrees
            .filter((tree) => !tree.missing && !tree.prunable)
            .map((tree) => ({ path: tree.path, openedAt: 0 })),
        ),
      ].map((project) => [project.path, project]),
    ).values(),
  ];
  const matches = available
    .filter(
      (session) =>
        !("inboxAsk" in session && session.inboxAsk) &&
        `${session.title} ${sessionWorkCwd(session)} ${HARNESS_TITLE[session.harness]}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .slice()
    .reverse()
    .sort(
      (a, b) =>
        Number(b.id === request.sourceSessionId) -
        Number(a.id === request.sourceSessionId),
    )
    .slice(0, 30);
  return (
    <Modal
      title={tickets ? "Open conversation" : "Send to agent"}
      description={
        tickets
          ? `${request.context.entries.length} selected · titles and descriptions · send when ready`
          : "Selected context · does not auto-send"
      }
      onClose={onClose}
      className="max-h-[85vh] [&_header_h2]:text-base"
    >
      <div ref={body} className="p-2 text-[12px] text-content">
        <input
          autoFocus
          aria-label="Search conversations"
          placeholder="Find a conversation…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="mb-1 h-8 w-full rounded-md border border-content/10 bg-transparent px-2 outline-accent"
        />
        <div
          className="max-h-[min(30vh,240px)] overflow-y-auto"
          aria-label="Conversations"
        >
          {matches.map((session) => (
            <button
              type="button"
              key={session.id}
              data-destination={session.id}
              aria-pressed={destination === session.id}
              onClick={() => setDestination(session.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content/5 ${destination === session.id ? "bg-content/5" : ""}`}
            >
              <Check
                aria-hidden
                className={`size-3.5 shrink-0 ${destination === session.id ? "text-content" : "invisible"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {session.title || "New conversation"}
                </span>
                <span
                  className="block truncate text-[11px] text-content/45"
                  title={sessionWorkCwd(session)}
                >
                  {HARNESS_TITLE[session.harness]} · {sessionWorkCwd(session)}
                  {wslLocation(sessionWorkCwd(session)) ? " · WSL" : ""}
                </span>
              </span>
              {"busy" in session && session.busy ? (
                <span className="shrink-0 text-[11px] text-content/50">
                  Working
                </span>
              ) : null}
            </button>
          ))}
          {!matches.length ? (
            <p className="px-2 py-3 text-content/45">
              No matching conversations
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-pressed={destination === "new"}
          onClick={() => setDestination("new")}
          className={`mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content/5 ${destination === "new" ? "bg-content/5" : ""}`}
        >
          <Plus className="size-3.5" />
          New conversation
        </button>
        {destination === "new" ? (
          <div className="flex min-w-0 items-center justify-between gap-2 px-2 py-1">
            <CwdPicker
              cwd={fresh.cwd}
              recents={knownProjects}
              placement="above"
              onCwdChange={(cwd) => setFresh({ ...fresh, cwd })}
            />
            <span className="flex shrink-0 items-center gap-1 text-content/60">
              {HARNESS_TITLE[fresh.harness]}
              <SecondOpinionButton
                cwd={fresh.cwd}
                from={fresh.harness}
                fromModel={fresh.model}
                includeCurrent
                title="Choose agent"
                onPick={(harness, model) =>
                  setFresh(
                    newSession(harness, fresh.cwd, model, fresh.runtimeMode),
                  )
                }
              />
            </span>
          </div>
        ) : null}
        {error || unsupported ? (
          <p role="alert" className="px-2 py-1 text-red-400">
            {error || unsupported}
          </p>
        ) : null}
        <div className="sticky bottom-0 mt-2 flex justify-end gap-2 border-t border-content/10 bg-background-base pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1.5 text-content/60 hover:bg-content/5"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!!unsupported || pending}
            className="rounded-md bg-content/10 px-2.5 py-1.5 disabled:opacity-40"
            onClick={async () => {
              if (submitting.current || unsupported) return;
              submitting.current = true;
              setPending(true);
              const controller = new AbortController();
              preparation.current = controller;
              try {
                const id = await onPrepare(
                  {
                    ...request,
                    context: request.context,
                  },
                  destination === "new" ? fresh : destination,
                  controller.signal,
                );
                if (controller.signal.aborted) return;
                if (destination !== "new") onOpen(id);
                onClose();
              } catch (reason) {
                setError(String(reason));
                submitting.current = false;
              } finally {
                setPending(false);
              }
            }}
          >
            {pending
              ? "Loading context…"
              : tickets
                ? "Open conversation"
                : "Add to chat"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
