import { pathKey } from "./paths";
import type { RecentProject, ProjectRailSections } from "./recents";

export type WorkingCopy = {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  missing: boolean;
  locked: string | null;
  prunable: string | null;
};
export type RepositoryFamily = {
  commonDir: string;
  checkout: string;
  worktrees: WorkingCopy[];
};

let verifiedFamilies: ReadonlyMap<string, RepositoryFamily> = new Map();
const listeners = new Set<() => void>();
export const getVerifiedFamilies = () => verifiedFamilies;
export function subscribeRepositoryFamilies(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishRepositoryFamilies(
  next: ReadonlyMap<string, RepositoryFamily>,
) {
  verifiedFamilies = next;
  for (const listener of listeners) listener();
}

export function workingCopyName(
  child: WorkingCopy,
  family: RepositoryFamily,
): string {
  if (child.main) return "main";
  const name = child.path.split("/").pop() ?? child.path;
  const main = family.worktrees
    .find((entry) => entry.main)
    ?.path.split("/")
    .pop();
  return main && name.startsWith(`${main}-`)
    ? name.slice(main.length + 1)
    : name;
}

/** Only fresh Git evidence collapses rows. Original recents and metadata remain
 * intact, so missing checkouts and conflicting customizations are recoverable. */
export function groupRepositoryFamilies(
  sections: ProjectRailSections,
  verified: ReadonlyMap<string, RepositoryFamily>,
): ProjectRailSections {
  const seen = new Set<string>();
  const group = (items: RecentProject[]) =>
    items.filter((item) => {
      const family = verified.get(pathKey(item.path));
      if (!family) return true;
      const key = pathKey(family.commonDir);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // Preserve a pinned representative first, then the user's existing order.
  return { pinned: group(sections.pinned), projects: group(sections.projects) };
}
