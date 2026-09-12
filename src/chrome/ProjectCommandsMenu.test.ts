// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "../lib/projects";
import type { ProjectTerminalDock } from "../lib/projectTerminal";
import type { TaskWorkspace } from "../lib/taskWorkspaces";
import { ProjectCommandsMenu } from "./ProjectCommandsMenu";

const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "p1",
  anchor: "/repo",
  repositories: [
    { id: "r1", commonDir: "/repo/.git", anchor: "/repo" },
    { id: "r2", commonDir: "/other/.git", anchor: "/other" },
  ],
  sets: [],
  commands: [],
  commandGroups: [],
  ...overrides,
});

const task = (overrides: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  id: "t1",
  projectId: "p1",
  name: "Big task",
  children: [
    {
      id: "c1",
      repositoryId: "r1",
      workingCopy: "/repo-wt/big-task",
      sessionIds: [],
      launch: { state: "ready" },
    },
  ],
  createdAt: 0,
  ...overrides,
});

const dock = (files: ProjectTerminalDock["pane"]["files"]): ProjectTerminalDock => ({
  projectPath: "/repo",
  pane: { id: "pane1", files, activeFileId: files[0]?.id ?? "" },
  side: "bottom",
  size: 220,
  open: true,
});

function render(props: Partial<Parameters<typeof ProjectCommandsMenu>[0]>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const handlers = {
    onRun: vi.fn(),
    onStop: vi.fn(),
    onManage: vi.fn(),
    onClose: vi.fn(),
  };
  const run = () =>
    root.render(
      createElement(ProjectCommandsMenu, {
        anchor: { x: 0, y: 0 },
        ...handlers,
        ...props,
      }),
    );
  return { host, root, handlers, run };
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProjectCommandsMenu", () => {
  it("resolves a bound command to its exact task worktree and runs it", async () => {
    const { host, root, handlers, run } = render({
      project: project({
        commands: [
          {
            id: "cmd1",
            name: "Dev server",
            command: "npm run dev",
            repositoryId: "r1",
          },
        ],
      }),
      task: task(),
    });
    try {
      await act(async () => run());
      const row = menu()!;
      expect(row.textContent).toContain("Dev server");
      expect(row.textContent).toContain("task worktree");
      expect(row.textContent).toContain("/repo-wt/big-task");
      await act(async () => byLabel("Run Dev server")!.click());
      expect(handlers.onRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cmd1", command: "npm run dev" }),
      );
      expect(handlers.onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("disables a bound command whose repository is not in the task", async () => {
    const { host, root, run } = render({
      project: project({
        commands: [
          {
            id: "cmd1",
            name: "Other repo",
            command: "make build",
            repositoryId: "r2",
          },
        ],
      }),
      task: task(),
    });
    try {
      await act(async () => run());
      expect(menu()!.textContent).toContain("not part of task");
      expect(byLabel("Run Other repo")!.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("offers Stop for a command whose bound terminal has a foreground process", async () => {
    const { host, root, handlers, run } = render({
      project: project({
        commands: [
          { id: "cmd1", name: "Dev server", command: "npm run dev" },
        ],
      }),
      task: task(),
      dock: dock([
        {
          id: "f1",
          path: "terminal",
          cwd: "/repo-wt/big-task",
          terminal: true,
          foreground: "npm run dev",
          command: {
            presetId: "cmd1",
            name: "Dev server",
            text: "npm run dev",
            runId: 1,
            launched: 1,
          },
        },
      ]),
    });
    try {
      await act(async () => run());
      expect(byLabel("Stop Dev server")).not.toBeNull();
      await act(async () => byLabel("Stop Dev server")!.click());
      expect(handlers.onStop).toHaveBeenCalledWith("f1");
      expect(handlers.onClose).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("runs the resolvable members of a group and reports the failures", async () => {
    const { host, root, handlers, run } = render({
      project: project({
        commands: [
          {
            id: "cmd1",
            name: "Dev server",
            command: "npm run dev",
            repositoryId: "r1",
          },
          {
            id: "cmd2",
            name: "Watcher",
            command: "npm run watch",
            repositoryId: "r2",
          },
        ],
        commandGroups: [
          { id: "g1", name: "Stack", commandIds: ["cmd1", "cmd2"] },
        ],
      }),
      task: task(),
    });
    try {
      await act(async () => run());
      await act(async () =>
        byLabel("Run all commands in Stack")!.click(),
      );
      // cmd1 resolved to the task worktree and ran; cmd2 stayed visible as a
      // named failure and the menu stayed open.
      expect(handlers.onRun).toHaveBeenCalledOnce();
      expect(handlers.onRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cmd1" }),
      );
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(menu()!.textContent).toContain("Watcher");
      expect(menu()!.textContent).toContain("not part of task");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("opens the manage sheet entry point", async () => {
    const { host, root, handlers, run } = render({ project: project() });
    try {
      await act(async () => run());
      expect(menu()!.textContent).toContain("No saved commands yet.");
      const manage = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Manage commands…",
      )!;
      await act(async () => manage.click());
      expect(handlers.onManage).toHaveBeenCalledOnce();
      expect(handlers.onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
