import { invoke } from "@tauri-apps/api/core";
import { contextTicketKey } from "./agentContext";
import { azureItem } from "./azure";
import { jiraIssue } from "./jira";
import type { LinearIssue } from "./linear";
import type { InboxItem } from "./githubTasks";

/**
 * One provider-native link from the open Inbox item to another work item.
 * `key` only picks a display group; `label` keeps the provider's own wording.
 */
export type InboxRelationEdge = {
  key: string;
  label: string;
  ref: string;
  /** Normalized target when the provider returned a readable item. */
  item: InboxItem | null;
  /** Target lives in a different repository than the open item. */
  foreign?: boolean;
};

export type InboxRelationGroup = {
  key: string;
  label: string;
  edges: InboxRelationEdge[];
};

export type InboxRelations = {
  groups: InboxRelationGroup[];
  truncated: boolean;
};

const GROUP_ORDER = [
  "parent",
  "children",
  "blocks",
  "blocked-by",
  "related",
  "duplicate",
];

const GROUP_LABEL: Record<string, string> = {
  parent: "Parent",
  children: "Children",
  blocks: "Blocks",
  "blocked-by": "Blocked by",
  related: "Related",
  duplicate: "Duplicates",
};

type RawEdge = {
  key?: string;
  label?: string;
  ref?: string;
  item?: unknown;
  foreign?: boolean;
};

function edgeIdentity(source: InboxItem, edge: InboxRelationEdge): string {
  if (edge.item) return contextTicketKey(edge.item);
  return `${source.provider}:${edge.ref.toLowerCase()}`;
}

/** Group, dedupe and order edges. Self-links and duplicates never render. */
export function groupInboxRelations(
  source: InboxItem,
  edges: readonly InboxRelationEdge[],
): InboxRelationGroup[] {
  const self = contextTicketKey(source);
  // Ref-only edges can still point back at the source — match its known refs.
  const selfRefs = new Set<string>();
  if (source.identifier) selfRefs.add(source.identifier.toLowerCase());
  if (source.number) selfRefs.add(`#${source.number}`);
  const seen = new Set<string>();
  const groups = new Map<string, InboxRelationGroup>();
  for (const edge of edges) {
    if (!edge.ref.trim() && !edge.item) continue;
    const identity = edgeIdentity(source, edge);
    if (identity === self || (!edge.item && selfRefs.has(edge.ref.toLowerCase()))) continue;
    const key = edge.key.trim().toLowerCase() || "related";
    const dedupe = `${key}:${identity}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: GROUP_LABEL[key] ?? (edge.label.trim() || "Related"),
        edges: [],
      };
      groups.set(key, group);
    }
    group.edges.push({ ...edge, key });
  }
  const ordered = [...groups.values()];
  ordered.sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.key);
    const bi = GROUP_ORDER.indexOf(b.key);
    if (ai === -1 && bi === -1) return a.label.localeCompare(b.label);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return ordered;
}

function linkedGitItem(
  source: InboxItem,
  provider: "github" | "gitlab",
  raw: unknown,
): InboxItem | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as {
    number?: number;
    title?: string;
    url?: string;
    state?: string;
    updatedAt?: string;
    repo?: string;
  };
  if (!Number.isFinite(row.number) || (row.number ?? 0) <= 0) return null;
  return {
    provider,
    kind: "issue",
    number: row.number!,
    title: typeof row.title === "string" ? row.title : "",
    url: typeof row.url === "string" ? row.url : "",
    state: typeof row.state === "string" ? row.state : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    labels: [],
    assignees: [],
    draft: false,
    repo: typeof row.repo === "string" ? row.repo : source.repo,
    projectPath: source.projectPath,
    account: source.account,
  };
}

function normalizeEdges(
  edges: readonly RawEdge[],
  item: (raw: unknown) => InboxItem | null,
): InboxRelationEdge[] {
  return edges.slice(0, 50).flatMap((edge) => {
    const ref = typeof edge.ref === "string" ? edge.ref.trim() : "";
    let linked: InboxItem | null = null;
    try {
      // One malformed target degrades to a ref-only row — it must not
      // reject the whole relations load.
      linked = item(edge.item);
    } catch {
      linked = null;
    }
    if (!ref && !linked) return [];
    return [
      {
        key: typeof edge.key === "string" ? edge.key : "related",
        label: typeof edge.label === "string" ? edge.label : "Related",
        ref: ref || (linked ? `#${linked.number}` : ""),
        item: linked,
        foreign: edge.foreign === true,
      },
    ];
  });
}

/**
 * Fetch the provider-native relation page for an open Inbox item. Each
 * provider answers for itself; callers isolate failures per provider.
 */
export async function loadInboxRelations(
  item: InboxItem,
): Promise<InboxRelations> {
  let edges: InboxRelationEdge[] = [];
  let truncated = false;
  if (item.provider === "jira") {
    const raw = await invoke<{ edges?: RawEdge[]; truncated?: boolean }>(
      "jira_issue_relations",
      { site: item.site, id: item.id },
    );
    truncated = raw.truncated === true;
    edges = normalizeEdges(raw.edges ?? [], (node) =>
      node && typeof node === "object" && (node as { id?: string }).id
        ? {
            ...jiraIssue(item.site ?? "", node as Parameters<typeof jiraIssue>[1]),
            account: item.account,
          }
        : null,
    );
  } else if (item.provider === "azure") {
    const raw = await invoke<{ edges?: RawEdge[]; truncated?: boolean }>(
      "azure_item_relations",
      { site: item.site, id: item.id },
    );
    truncated = raw.truncated === true;
    edges = normalizeEdges(raw.edges ?? [], (node) =>
      node && typeof node === "object" && (node as { id?: number }).id
        ? {
            ...azureItem(item.site ?? "", node as Parameters<typeof azureItem>[1]),
            account: item.account,
          }
        : null,
    );
  } else if (item.provider === "linear") {
    const raw = await invoke<{ edges?: RawEdge[]; truncated?: boolean }>(
      "linear_issue_relations",
      { id: item.id },
    );
    truncated = raw.truncated === true;
    edges = normalizeEdges(raw.edges ?? [], (node) => {
      if (!node || typeof node !== "object" || !(node as LinearIssue).id) {
        return null;
      }
      const issue = node as LinearIssue;
      return {
        ...issue,
        provider: "linear" as const,
        kind: "linear" as const,
        account: item.account,
      };
    });
  } else if (item.provider === "github" || item.provider === "gitlab") {
    const command =
      item.provider === "github"
        ? "git_github_issue_relations"
        : "gitlab_issue_relations";
    const kind = item.kind === "pr" ? "pr" : "issue";
    const raw = await invoke<{ edges?: RawEdge[]; truncated?: boolean }>(
      command,
      { cwd: item.projectPath, kind, number: item.number },
    );
    truncated = raw.truncated === true;
    edges = normalizeEdges(raw.edges ?? [], (node) =>
      linkedGitItem(item, item.provider as "github" | "gitlab", node),
    );
  }
  return { groups: groupInboxRelations(item, edges), truncated };
}
