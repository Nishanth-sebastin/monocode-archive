import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  actionsForProject,
  agentActionsSnapshot,
  loadAgentActions,
  subscribeAgentActions,
  type AgentAction,
} from "../lib/agentActions";
import type { ProjectRecord } from "../lib/projects";
import type { HarnessId, Session } from "../lib/session";
import type { TaskWorkspace } from "../lib/taskWorkspaces";
import {
  AgentActionSheet,
  AgentActionsSheet,
  type ActionRun,
} from "./AgentActionSheet";
import { SlidersHorizontal, Zap } from "./icons";
import { Popover } from "./Popover";

/**
 * Composer entry for saved agent actions. The popover stays a plain list —
 * context is only resolved once a run is actually configured and submitted.
 */
export function AgentActionsMenu({
  session,
  workCwd,
  task,
  project,
  onRun,
  onRunNew,
}: {
  session: Session;
  workCwd: string;
  task?: TaskWorkspace | null;
  project?: ProjectRecord;
  onRun: (run: ActionRun) => void;
  onRunNew?: (
    run: ActionRun,
    destination: { cwd: string; harness: HarnessId; model: string },
  ) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<AgentAction | null>(null);
  const [managing, setManaging] = useState(false);
  const raw = useSyncExternalStore(
    subscribeAgentActions,
    agentActionsSnapshot,
  );
  const actions = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => actionsForProject(project?.id, loadAgentActions()),
    [raw, project?.id],
  );

  return (
    <div ref={anchor} className="relative shrink-0">
      <button
        type="button"
        title="Agent actions"
        aria-label="Agent actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className={`grid size-6.5 shrink-0 place-items-center rounded-md ${
          open
            ? "bg-content/20 text-content"
            : "bg-content/10 text-content/50 hover:bg-content/15 hover:text-content"
        }`}
      >
        <Zap className="size-3.5" strokeWidth={1.5} />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="start"
          width={240}
          onDismiss={() => setOpen(false)}
          role="menu"
          aria-label="Agent actions"
          className="p-1.5"
        >
          <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-content/40">
            Agent actions
          </p>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setRunning(action);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/10"
            >
              <Zap className="size-3.5 shrink-0 text-content/45" />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {action.name}
              </span>
              {action.projectId ? (
                <span className="shrink-0 text-[10px] text-content/35">
                  Project
                </span>
              ) : null}
            </button>
          ))}
          {actions.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-content/45">
              No actions yet — create one below.
            </p>
          ) : null}
          <div className="mt-1 border-t border-content/10 pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setManaging(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/10"
            >
              <SlidersHorizontal className="size-3.5 shrink-0 text-content/45" />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                Edit actions…
              </span>
            </button>
          </div>
        </Popover>
      ) : null}
      {running ? (
        <AgentActionSheet
          action={running}
          session={session}
          workCwd={workCwd}
          task={task}
          project={project}
          onRun={onRun}
          onRunNew={onRunNew}
          onClose={() => setRunning(null)}
        />
      ) : null}
      {managing ? (
        <AgentActionsSheet
          project={project}
          onClose={() => setManaging(false)}
        />
      ) : null}
    </div>
  );
}
