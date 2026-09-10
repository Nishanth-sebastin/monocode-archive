import { getVerifiedFamilies } from "../lib/repositoryFamilies";
import { useEffect, useRef, useState } from "react";
import { type AgentContextRequest } from "../lib/agentContext";
import {
  HARNESS_TITLE,
  harnessSupportsAttachments,
  newDefaultSession,
  newSession,
  sessionWorkCwd,
  type Session,
} from "../lib/session";
import type { RecentProject } from "../lib/recents";
import { wslLocation } from "../lib/paths";
import { Modal } from "./Modal";
import { AgentContextChips } from "./AgentContextChips";
import { AttachmentChip } from "./AttachmentChip";
import { CwdPicker } from "./CwdPicker";
import { SecondOpinionButton } from "./SecondOpinionButton";

export function AgentContextPicker({
  request,
  sessions,
  recents,
  onPrepare,
  onOpen,
  onClose,
}: {
  request: AgentContextRequest;
  sessions: readonly Session[];
  recents: RecentProject[];
  onPrepare: (
    request: AgentContextRequest,
    destination: string | Session,
  ) => string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
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
  const [destination, setDestination] = useState(
    request.sourceSessionId ?? "new",
  );
  const [fresh, setFresh] = useState(() => newDefaultSession(request.cwd));
  const [search, setSearch] = useState("");
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<string>();
  const submitting = useRef(false);
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
      trigger.current?.focus();
    };
  }, []);
  const target =
    destination === "new"
      ? fresh
      : sessions.find((session) => session.id === destination);
  const unsupported = !target
    ? "Conversation closed. Choose another destination."
    : request.context.attachments.length &&
        !harnessSupportsAttachments(target.harness)
      ? "This agent cannot receive attachments. Choose another agent."
      : destination === "new" && (!fresh.cwd || fresh.cwd === "~")
        ? "Choose a project or worktree."
        : "";
  const matches = sessions
    .filter(
      (session) =>
        !session.inboxAsk &&
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
      title="Send to agent"
      description="Prepare selected context · does not auto-send"
      onClose={onClose}
      className="max-h-[80vh] [&_header_h2]:text-lg"
    >
      <div ref={body} className="space-y-3 p-3 text-[13px] text-content">
        <AgentContextChips context={request.context} />
        <div className="flex flex-wrap gap-1">
          {request.context.attachments.map((file) => (
            <AttachmentChip key={file.id} attachment={file} />
          ))}
        </div>
        {prepared ? (
          <div role="status" className="space-y-2">
            <p>
              Prepared in {target?.title || "conversation"} ·{" "}
              {target ? HARNESS_TITLE[target.harness] : ""}.
            </p>
            <button
              type="button"
              className="rounded bg-content/10 px-3 py-1.5"
              onClick={() => {
                onOpen(prepared);
                onClose();
              }}
            >
              Open conversation
            </button>
          </div>
        ) : (
          <>
            <label className="block">
              Instruction <span className="text-content/45">(optional)</span>
              <textarea
                rows={2}
                maxLength={4000}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                className="mt-1 w-full rounded border border-content/10 bg-transparent p-2 outline-accent"
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-1">Destination</legend>
              <input
                aria-label="Search conversations"
                placeholder="Search conversations"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full rounded border border-content/10 bg-transparent px-2 py-1.5 outline-accent"
              />
              <div className="max-h-40 overflow-auto">
                {matches.map((session) => (
                  <label
                    key={session.id}
                    className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-content/5"
                  >
                    <input
                      type="radio"
                      name="context-destination"
                      value={session.id}
                      checked={destination === session.id}
                      onChange={() => setDestination(session.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">
                        {session.title || "New session"} ·{" "}
                        {HARNESS_TITLE[session.harness]} ·{" "}
                        {session.busy ? "Working" : "Unknown"}
                      </span>
                      <span className="block break-all text-[11px] text-content/50">
                        {sessionWorkCwd(session)} ·{" "}
                        {wslLocation(sessionWorkCwd(session)) ? "WSL" : "Local"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 px-2">
                <input
                  type="radio"
                  name="context-destination"
                  checked={destination === "new"}
                  onChange={() => setDestination("new")}
                />
                New session…
              </label>
              {destination === "new" ? (
                <div className="space-y-2 rounded border border-content/10 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <CwdPicker
                      cwd={fresh.cwd}
                      recents={knownProjects}
                      placement="below"
                      onCwdChange={(cwd) => setFresh(newDefaultSession(cwd))}
                    />
                    <span className="flex items-center gap-1">
                      {HARNESS_TITLE[fresh.harness]}
                      <SecondOpinionButton
                        cwd={fresh.cwd}
                        from={fresh.harness}
                        fromModel={fresh.model}
                        includeCurrent
                        title="Choose agent"
                        onPick={(harness, model) =>
                          setFresh(
                            newSession(
                              harness,
                              fresh.cwd,
                              model,
                              fresh.runtimeMode,
                            ),
                          )
                        }
                      />
                    </span>
                  </div>
                  <p className="break-all text-[11px] text-content/50">
                    {fresh.cwd} · {wslLocation(fresh.cwd) ? "WSL" : "Local"}
                  </p>
                </div>
              ) : null}
            </fieldset>
            <p className="text-[11px] text-content/50">
              Prepare a draft even while an agent works. Queue and send remain
              available in its composer according to provider capabilities.
            </p>
            {error || unsupported ? (
              <p role="alert" className="text-red-400">
                {error || unsupported}
              </p>
            ) : null}
            <div className="sticky bottom-0 flex justify-end gap-2 border-t border-content/10 bg-background-base py-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded px-3 py-1.5 hover:bg-content/5"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!!unsupported}
                className="rounded bg-content/10 px-3 py-1.5 disabled:opacity-40"
                onClick={() => {
                  if (submitting.current || unsupported) return;
                  submitting.current = true;
                  try {
                    const id = onPrepare(
                      {
                        ...request,
                        context: { ...request.context, instruction },
                      },
                      destination === "new" ? fresh : destination,
                    );
                    if (destination === "new") onClose();
                    else setPrepared(id);
                  } catch (reason) {
                    setError(String(reason));
                    submitting.current = false;
                  }
                }}
              >
                {destination === "new"
                  ? "Start session and prepare"
                  : "Prepare in chat"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
