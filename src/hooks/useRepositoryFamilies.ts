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
      // Recent subfolders are aliases, not worktree roots. Revalidate them
      // before publishing so a refresh cannot briefly split the rail group.
      const aliases = paths.filter(
        (candidate) =>
          pathKey(candidate) !== pathKey(path) &&
          getVerifiedFamilies().get(pathKey(candidate))?.commonDir ===
            family.commonDir &&
          !family.worktrees.some(
            (child) => pathKey(child.path) === pathKey(candidate),
          ),
      );
      const refreshedAliases = await Promise.all(
        aliases.map(async (alias) => {
          try {
            return [pathKey(alias), await probe(alias)] as const;
          } catch {
            return null;
          }
        }),
      );
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
      for (const alias of refreshedAliases) {
        if (alias) verified.set(...alias);
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
    let running = false;
    const pending = new Set<string>();
    const unsubscribe = subscribeGitChanged((changed) => {
      const paths: string[] = JSON.parse(familyPaths);
      const changedKey = changed ? pathKey(changed) : undefined;
      const changedFamily = changedKey
        ? getVerifiedFamilies().get(changedKey)
        : undefined;
      for (const path of paths) {
        const key = pathKey(path);
        if (
          !changedKey ||
          key === changedKey ||
          changedKey.startsWith(`${key}/`) ||
          (changedFamily &&
            getVerifiedFamilies().get(key)?.commonDir ===
              changedFamily.commonDir)
        )
          pending.add(path);
      }
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (!cancelled && pending.size > 0) {
            const path = pending.values().next().value!;
            pending.delete(path);
            await discoverRepositoryFamilies(
              JSON.parse(familyPaths),
              (path) =>
                invoke<RepositoryFamily>("git_repository_family", {
                  cwd: path,
                }),
              () => cancelled,
              path,
            );
          }
        } finally {
          running = false;
        }
      })();
    });
    return () => {
      cancelled = true;
      pending.clear();
      unsubscribe();
    };
  }, [cwd, familyPaths]);
  return families;
}
