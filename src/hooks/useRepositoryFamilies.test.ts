import { afterEach, expect, it, vi } from "vitest";
import { discoverRepositoryFamilies } from "./useRepositoryFamilies";
import {
  getVerifiedFamilies,
  publishRepositoryFamilies,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";
const family = (path: string): RepositoryFamily => ({
  commonDir: `${path}/.git`,
  checkout: path,
  worktrees: [],
});
afterEach(() => publishRepositoryFamilies(new Map()));

it("reuses cached families, publishes before a slow repository, and drops unused cache", async () => {
  publishRepositoryFamilies(
    new Map([
      ["/cached", family("/cached")],
      ["/unused", family("/unused")],
    ]),
  );
  let finish!: (value: RepositoryFamily) => void;
  const slow = new Promise<RepositoryFamily>((resolve) => {
    finish = resolve;
  });
  const probe = vi.fn((path: string) =>
    path === "/slow" ? slow : Promise.resolve(family(path)),
  );
  const done = discoverRepositoryFamilies(
    ["/new", "/cached", "/slow"],
    probe,
    () => false,
  );
  await vi.waitFor(() => expect(getVerifiedFamilies().has("/new")).toBe(true));
  expect(getVerifiedFamilies().has("/cached")).toBe(true);
  expect(getVerifiedFamilies().has("/unused")).toBe(false);
  expect(probe.mock.calls.map(([path]) => path)).toEqual(["/new", "/slow"]);
  finish(family("/slow"));
  await done;
});

it("refreshes only active cached ownership and discards stale aliases on failure", async () => {
  const previous = family("/main");
  publishRepositoryFamilies(
    new Map([
      ["/main", previous],
      ["/child", previous],
      ["/other", family("/other")],
    ]),
  );
  const probe = vi.fn(async () => {
    throw new Error("Unavailable");
  });
  await discoverRepositoryFamilies(
    ["/child", "/other"],
    probe,
    () => false,
    "/child",
  );
  expect(probe).toHaveBeenCalledTimes(1);
  expect([...getVerifiedFamilies().keys()]).toEqual(["/other"]);
});

it("does not publish cancelled discovery or overwrite concurrent updates to another family", async () => {
  let finish!: (value: RepositoryFamily) => void;
  let cancelled = false;
  const done = discoverRepositoryFamilies(
    ["/new"],
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => cancelled,
  );
  publishRepositoryFamilies(new Map([["/other", family("/other")]]));
  finish(family("/new"));
  await done;
  expect([...getVerifiedFamilies().keys()]).toEqual(["/other", "/new"]);
  const pending = discoverRepositoryFamilies(
    ["/later"],
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => cancelled,
  );
  cancelled = true;
  finish(family("/later"));
  await pending;
  expect(getVerifiedFamilies().has("/later")).toBe(false);
});
