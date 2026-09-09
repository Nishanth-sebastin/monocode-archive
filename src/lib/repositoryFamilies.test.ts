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
    workingCopyName({ ...main, main: false, path: "/repo-fix ż" }, family),
  ).toBe("fix ż");
  expect(
    workingCopyName({ ...main, main: false, path: "/external space" }, family),
  ).toBe("external space");
});
