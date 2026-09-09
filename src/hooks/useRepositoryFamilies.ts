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

export function useRepositoryFamilies(recents: RecentProject[], cwd: string) {
  const [families, setFamilies] = useState<Map<string, RepositoryFamily>>(
    new Map(),
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
    void (async () => {
      const verified = new Map<string, RepositoryFamily>();
      // One probe at a time; inventory supplies sibling identities without a
      // recursive scan or per-child status request.
      for (const path of paths) {
        if (cancelled) return;
        if (verified.has(pathKey(path))) continue;
        try {
          const family = await invoke<RepositoryFamily>(
            "git_repository_family",
            { cwd: path },
          );
          verified.set(pathKey(path), family);
          for (const child of family.worktrees) {
            if (!child.missing && !child.prunable)
              verified.set(pathKey(child.path), family);
          }
        } catch {
          /* Non-Git or unavailable paths remain independent visible rows. */
        }
      }
      if (!cancelled) publishRepositoryFamilies(verified);
    })();
    return () => {
      cancelled = true;
    };
  }, [familyPaths]);
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
