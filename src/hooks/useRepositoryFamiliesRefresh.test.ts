// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useRepositoryFamilies } from "./useRepositoryFamilies";
import { publishRepositoryFamilies } from "../lib/repositoryFamilies";
import { notifyGitChanged } from "../lib/fs";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (_: string, { cwd }: { cwd: string }) => ({
    commonDir: `${cwd}/.git`,
    checkout: cwd,
    worktrees: [],
  })),
}));

it("refreshes the changed family, drains distinct events and preserves global refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const paths = ["/repo-a", "/repo-b", "/repo-c"];
  const recents = paths.map((path) => ({ path, openedAt: 1 }));
  function Fixture() {
    useRepositoryFamilies(recents, paths[0]);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Fixture)));
    vi.mocked(invoke).mockClear();
    await act(async () => notifyGitChanged(paths[1]));
    expect(vi.mocked(invoke).mock.calls.map(([, args]) => args)).toEqual([
      { cwd: paths[1] },
    ]);
    vi.mocked(invoke).mockClear();
    await act(async () => {
      notifyGitChanged(paths[0]);
      notifyGitChanged(paths[2]);
    });
    expect(vi.mocked(invoke).mock.calls.map(([, args]) => args)).toEqual([
      { cwd: paths[0] },
      { cwd: paths[2] },
    ]);
    vi.mocked(invoke).mockClear();
    await act(async () => notifyGitChanged());
    expect(vi.mocked(invoke).mock.calls.map(([, args]) => args)).toEqual(
      paths.map((cwd) => ({ cwd })),
    );
  } finally {
    await act(async () => root.unmount());
    publishRepositoryFamilies(new Map());
    vi.unstubAllGlobals();
  }
});
