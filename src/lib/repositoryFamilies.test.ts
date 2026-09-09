import { expect, it } from "vitest";
import {
  groupRepositoryFamilies,
  workingCopyName,
  type RepositoryFamily,
} from "./repositoryFamilies";

it("groups only verified shared metadata, preserving pins, order and original data", () => {
  const main = { path: "/repo", openedAt: 1 };
  const child = { path: "/child space ż", openedAt: 2 };
  const clone = { path: "/clone", openedAt: 3 };
  const missing = { path: "/missing", openedAt: 4 };
  const family = (commonDir: string): RepositoryFamily => ({
    commonDir,
    checkout: main.path,
    worktrees: [],
  });
  const verified = new Map([
    [main.path, family("/repo/.git")],
    [child.path, family("/repo/.git")],
    [clone.path, family("/clone/.git")],
  ]);
  const original = { pinned: [child], projects: [main, clone, missing] };
  const result = groupRepositoryFamilies(original, verified);
  expect(result).toEqual({ pinned: [child], projects: [clone, missing] });
  expect(groupRepositoryFamilies(result, verified)).toEqual(result);
  expect(original.projects).toEqual([main, clone, missing]);
  expect(groupRepositoryFamilies(original, new Map())).toEqual(original);
});

it("shortens generated checkout names without changing unrelated names or paths", () => {
  const main = {
    path: "/repo",
    main: true,
    head: "abc",
    branch: "refs/heads/main",
    missing: false,
    locked: null,
    prunable: null,
  };
  const family = {
    commonDir: "/repo/.git",
    checkout: main.path,
    worktrees: [main],
  };
  expect(workingCopyName(main, family)).toBe("main");
  expect(
    workingCopyName(
      { ...main, main: false, branch: null, path: "/repo-fix ż" },
      family,
    ),
  ).toBe("fix ż");
  expect(
    workingCopyName(
      { ...main, main: false, branch: null, path: "/external space" },
      family,
    ),
  ).toBe("external space");
});

import {
  lastWorkingCopyUse,
  workingCopyAge,
  oldestWorkingCopies,
  hiddenWorkingCopies,
} from "./repositoryFamilies";

it("uses recorded app activity, sorts known oldest first and never treats unknown as stale", () => {
  const child = (path: string, lastUsed?: number) => ({
    path,
    lastUsed,
    head: "abc",
    branch: null,
    main: false,
    missing: false,
    locked: null,
    prunable: null,
  });
  const entries = [child("/new", 300), child("/unknown"), child("/old", 100)];
  expect(oldestWorkingCopies(entries, []).map((entry) => entry.path)).toEqual([
    "/old",
    "/new",
    "/unknown",
  ]);
  expect(entries[0].path).toBe("/new");
  expect(
    lastWorkingCopyUse(entries[2], [{ path: "/old", openedAt: 400 }]),
  ).toBe(400);
  expect(lastWorkingCopyUse(entries[1], [])).toBeNull();
  expect(workingCopyAge(null)).toBe("Activity unknown");
  expect(workingCopyAge(100, 100 + 30 * 86_400_000)).toBe("Used 30d ago");
  expect(workingCopyAge(200, 100)).toBe("Used today");
});

it("loads only bounded presentation paths and tolerates damaged old preferences", () => {
  expect(hiddenWorkingCopies("broken")).toEqual([]);
  expect(hiddenWorkingCopies('{"path":"/repo"}')).toEqual([]);
  expect(hiddenWorkingCopies('["/repo",null,5,"/other"]')).toEqual([
    "/repo",
    "/other",
  ]);
  expect(
    hiddenWorkingCopies(JSON.stringify(Array(2100).fill("/repo"))),
  ).toHaveLength(2000);
});

it("uses the branch as the single label even when the checkout folder differs", () => {
  const copy = {
    path: "/repo-generated-name",
    main: false,
    branch: "refs/heads/fix/actual-branch",
    head: "abc",
    missing: false,
    locked: null,
    prunable: null,
  };
  expect(
    workingCopyName(copy, {
      commonDir: "/repo/.git",
      checkout: "/repo",
      worktrees: [copy],
    }),
  ).toBe("fix/actual-branch");
});

it("reconciles serialized legacy rows without erasing their original presentation data", () => {
  const old = {
    pinned: [{ path: "/child", openedAt: 2 }],
    projects: [
      { path: "/main", openedAt: 1 },
      { path: "/clone", openedAt: 3 },
    ],
  };
  const reloaded = JSON.parse(JSON.stringify(old));
  const family = { commonDir: "/main/.git", checkout: "/main", worktrees: [] };
  const verified = new Map([
    ["/main", family],
    ["/child", family],
    ["/clone", { ...family, commonDir: "/clone/.git" }],
  ]);
  expect(groupRepositoryFamilies(reloaded, verified)).toEqual({
    pinned: [old.pinned[0]],
    projects: [old.projects[1]],
  });
  expect(reloaded).toEqual(old);
  // Losing verification must make original entries recoverable, not delete them.
  expect(groupRepositoryFamilies(reloaded, new Map())).toEqual(old);
});
