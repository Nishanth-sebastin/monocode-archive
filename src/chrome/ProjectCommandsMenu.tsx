import { useMemo, useState, useSyncExternalStore } from "react";
import { prettyCwd } from "../lib/paths";
import type { ProjectCommand, ProjectRecord } from "../lib/projects";
import {
  loadReusableCommands,
  resolveCommandGroup,
  resolveCommandTarget,
  reusableCommandsSnapshot,
  subscribeReusableCommands,
  type ReusableCommand,
} from "../lib/projectCommands";
import type { ProjectTerminalDock } from "../lib/projectTerminal";
import type { FilePaneTab } from "../lib/layout";
import type { TaskWorkspace } from "../lib/taskWorkspaces";
import { Play, SlidersHorizontal, Square } from "./icons";
import { Popover, type PopoverAnchor } from "./Popover";

type CommandLike = Pick<
  ProjectCommand,
  "id" | "name" | "command" | "repositoryId" | "relativeCwd" | "steps"
>;

/**
 * Saved commands for a project or task. Each row resolves its target live so
 * the menu always shows where the command will actually run — a task child
 * worktree, a repository anchor, or the project folder.
 */
export function ProjectCommandsMenu({
  anchor,
  project,
  task,
  dock,
  fallbackCwd,
  onRun,
  onStop,
  onManage,
  onClose,
}: {
  anchor: PopoverAnchor;
  project?: ProjectRecord;
  task?: TaskWorkspace | null;
  dock?: ProjectTerminalDock;
  /** Folder reusable commands fall back to when no stored project resolves. */
  fallbackCwd?: string;
  /** Resolves to an error string when the command could not be launched. */
  onRun: (command: CommandLike) => void | string | Promise<string | void>;
  onStop: (fileId: string) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const raw = useSyncExternalStore(
    subscribeReusableCommands,
    reusableCommandsSnapshot,
  );
  const reusable = useMemo(() => loadReusableCommands(), [raw]);
  const [failures, setFailures] = useState<{ name: string; error: string }[]>(
    [],
  );

  const bound = (presetId: string): FilePaneTab | undefined =>
    dock?.pane.files.find((file) => file.command?.presetId === presetId);

  const run = (command: CommandLike) => {
    void Promise.resolve(onRun(command)).then((error) => {
      if (typeof error === "string" && error)
        setFailures([{ name: command.name, error }]);
      else onClose();
    });
  };

  const runGroup = (groupId: string) => {
    const group = project?.commandGroups.find((item) => item.id === groupId);
    if (!project || !group) return;
    const members = group.commandIds
      .map((id) => project.commands.find((item) => item.id === id))
      .filter((item): item is ProjectCommand => !!item);
    const { runs, failures: failed } = resolveCommandGroup({
      commands: members,
      project,
      task,
      fallbackCwd,
    });
    // Resolution failures are known now; launch failures come back from the
    // runner — both kinds keep the menu open and are reported by name.
    void Promise.all(
      runs.map((entry) =>
        Promise.resolve(onRun(entry.command)).then((error) =>
          typeof error === "string" && error
            ? { name: entry.command.name, error }
            : null,
        ),
      ),
    ).then((launchFailures) => {
      const all = [
        ...failed.map((entry) => ({
          name: entry.command.name,
          error: entry.error,
        })),
        ...launchFailures.filter(
          (entry): entry is { name: string; error: string } => !!entry,
        ),
      ];
      setFailures(all);
      if (!all.length) onClose();
    });
  };

  const row = (command: CommandLike) => {
    const target = resolveCommandTarget({ command, project, task, fallbackCwd });
    const file = bound(command.id);
    const running = !!file?.foreground;
    const failed =
      file?.command?.failed !== undefined &&
      file.command.failed === file.command.runId;
    return (
      <div
        key={command.id}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-content/10"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-content">
            {command.name}
            {failed ? (
              <span className="text-red-400"> · step failed</span>
            ) : null}
          </div>
          <div className="truncate text-[11px] text-content/40">
            {"error" in target
              ? target.error
              : `${command.steps?.length ? `${command.steps.length} steps · ` : ""}${command.command} — ${target.source === "task" ? "task worktree" : target.label ? `${target.label} checkout` : "project folder"} ${prettyCwd(target.cwd)}`}
          </div>
        </div>
        {running && file ? (
          <button
            type="button"
            role="menuitem"
            title={`Stop ${command.name}`}
            aria-label={`Stop ${command.name}`}
            onClick={() => onStop(file.id)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/15 hover:text-content"
          >
            <Square className="size-3" strokeWidth={1.75} />
          </button>
        ) : (
          <button
            type="button"
            role="menuitem"
            title={
              "error" in target ? target.error : `Run ${command.name}`
            }
            aria-label={`Run ${command.name}`}
            disabled={"error" in target}
            onClick={() => run(command)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/15 hover:text-content disabled:opacity-30"
          >
            <Play className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>
    );
  };

  const groups = project?.commandGroups ?? [];
  const commands = project?.commands ?? [];
  const empty = !groups.length && !commands.length && !reusable.length;
  // A bare point anchor comes from a rail context menu — open to the right
  // of the cursor like the other rail menus; an element anchor is the dock
  // button, which sits at the bottom edge and opens upward.
  const pointAnchor =
    anchor != null &&
    !(anchor instanceof HTMLElement) &&
    !("current" in anchor) &&
    !("bottom" in anchor) &&
    "x" in anchor;

  return (
    <Popover
      anchor={anchor}
      {...(pointAnchor
        ? { side: "right" as const }
        : { side: "top" as const, align: "end" as const })}
      width={300}
      onDismiss={onClose}
      role="menu"
      aria-label="Saved commands"
      className="p-1.5"
    >
      <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-content/40">
        {task ? `Commands · ${task.name}` : "Commands"}
      </p>
      {groups.length ? (
        <div className="flex flex-col">
          {groups.map((group) => {
            const members = group.commandIds
              .map((id) => commands.find((item) => item.id === id))
              .filter((item): item is ProjectCommand => !!item);
            return (
              <div
                key={group.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-content/10"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-content">
                    {group.name}
                  </div>
                  <div className="truncate text-[11px] text-content/40">
                    {members.map((item) => item.name).join(" · ")}
                  </div>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  title={`Run all commands in ${group.name}`}
                  aria-label={`Run all commands in ${group.name}`}
                  onClick={() => runGroup(group.id)}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/15 hover:text-content"
                >
                  <Play className="size-3.5" strokeWidth={1.75} />
                </button>
              </div>
            );
          })}
          <div className="mx-2 my-1 border-t border-content/10" />
        </div>
      ) : null}
      {commands.length ? (
        <div className="flex flex-col">{commands.map(row)}</div>
      ) : null}
      {reusable.length ? (
        <div className="flex flex-col">
          {commands.length || groups.length ? (
            <div className="mx-2 my-1 border-t border-content/10" />
          ) : null}
          {reusable.map((command: ReusableCommand) => row(command))}
        </div>
      ) : null}
      {failures.length ? (
        <div className="mx-2 mt-1 rounded-lg bg-red-500/10 px-2 py-1.5">
          {failures.map((failure) => (
            <p key={failure.name} className="text-[11px] text-red-400">
              {failure.name}: {failure.error}
            </p>
          ))}
        </div>
      ) : null}
      {empty ? (
        <p className="px-2 py-1.5 text-[12px] text-content/45">
          No saved commands yet.
        </p>
      ) : null}
      <div className="mt-1 border-t border-content/10 pt-1">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onManage();
            onClose();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/10"
        >
          <SlidersHorizontal className="size-3.5 shrink-0 text-content/45" />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            Manage commands…
          </span>
        </button>
      </div>
    </Popover>
  );
}
