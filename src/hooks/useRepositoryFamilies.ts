import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { collectRailProjects, type RecentProject } from "../lib/recents";
import { pathKey } from "../lib/paths";
import { subscribeGitChanged } from "../lib/fs";
import {
  publishRepositoryFamilies,
  subscribeRepositoryFamilies,
  getVerifiedFamilies,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";

/** Reuse unchanged families and publish each newly verified repository promptly.
 * Retain only families reachable from the bounded recent-project list. */
export async function discoverRepositoryFamilies(
  paths: string[],
  probe: (path: string) => Promise<RepositoryFamily>,
  cancelled: () => boolean,
  refreshPath?: string,
) {
  const previous = getVerifiedFamilies();
  const retained = new Set(
    paths.flatMap((path) => {
      const family = previous.get(pathKey(path));
      return family ? [pathKey(family.commonDir)] : [];
    }),
  );
  publishRepositoryFamilies(
    new Map(
      [...previous].filter(([, family]) =>
        retained.has(pathKey(family.commonDir)),
      ),
    ),
  );
  for (const path of paths) {
    if (cancelled()) return;
    if (
      getVerifiedFamilies().has(pathKey(path)) &&
      pathKey(path) !== pathKey(refreshPath ?? "")
    )
      continue;
    try {
      const family = await probe(path);
      if (cancelled()) return;
      // Merge with the latest state: Git refresh may have updated another family.
      const verified = new Map(getVerifiedFamilies());
      const old = verified.get(pathKey(path));
      for (const [key, value] of verified) {
        if (
          pathKey(value.commonDir) === pathKey(family.commonDir) ||
          (old && pathKey(value.commonDir) === pathKey(old.commonDir))
        )
          verified.delete(key);
      }
      verified.set(pathKey(path), family);
      for (const child of family.worktrees) {
        if (!child.missing && !child.prunable)
          verified.set(pathKey(child.path), family);
      }
      publishRepositoryFamilies(verified);
    } catch {
      // A failed active refresh must not leave stale ownership evidence.
      if (cancelled()) return;
      const verified = new Map(getVerifiedFamilies());
      const old = verified.get(pathKey(path));
      if (old) {
        for (const [key, value] of verified)
          if (pathKey(value.commonDir) === pathKey(old.commonDir))
            verified.delete(key);
        publishRepositoryFamilies(verified);
      }
    }
  }
}

export function useRepositoryFamilies(recents: RecentProject[], cwd: string) {
  const [families, setFamilies] = useState<Map<string, RepositoryFamily>>(
    () => new Map(getVerifiedFamilies()),
  );
  useEffect(
    () =>
      subscribeRepositoryFamilies(() =>
        setFamilies(new Map(getVerifiedFamilies())),
      ),
    [],
  );
  const familyPaths = JSON.stringify(
    [...collectRailProjects(recents, cwd).values()]
      .map((item) => item.path)
      .sort(),
  );
  useEffect(() => {
    let cancelled = false;
    const paths: string[] = JSON.parse(familyPaths);
    // The active checkout is useful first; cached siblings require no probe.
    paths.sort(
      (a, b) =>
        Number(pathKey(b) === pathKey(cwd)) -
        Number(pathKey(a) === pathKey(cwd)),
    );
    void discoverRepositoryFamilies(
      paths,
      (path) =>
        invoke<RepositoryFamily>("git_repository_family", { cwd: path }),
      () => cancelled,
      cwd,
    );
    return () => {
      cancelled = true;
    };
  }, [familyPaths, cwd]);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    return (() => {
      const unsubscribe = subscribeGitChanged(() => {
        if (pending) return;
        pending = true;
        void invoke<RepositoryFamily>("git_repository_family", { cwd })
          .then((family) => {
            if (cancelled) return;
            {
              const next = new Map(getVerifiedFamilies());
              for (const [key, value] of next) {
                if (pathKey(value.commonDir) === pathKey(family.commonDir))
                  next.delete(key);
              }
              next.set(pathKey(cwd), family);
              for (const child of family.worktrees) {
                if (!child.missing && !child.prunable)
                  next.set(pathKey(child.path), family);
              }
              publishRepositoryFamilies(next);
            }
          })
          .catch(() => {})
          .finally(() => {
            pending = false;
          });
      });
      return () => {
        cancelled = true;
        unsubscribe();
      };
    })();
  }, [cwd]);
  return families;
}
