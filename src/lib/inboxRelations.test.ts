import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { InboxItem } from "./githubTasks";
import {
  groupInboxRelations,
  loadInboxRelations,
  type InboxRelationEdge,
} from "./inboxRelations";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const call = vi.mocked(invoke);

const item = (number: number, over: Partial<InboxItem> = {}): InboxItem => ({
  provider: "jira",
  kind: "jira",
  id: String(number),
  number,
  identifier: `ENG-${number}`,
  title: `Issue ${number}`,
  url: `https://team.atlassian.net/browse/ENG-${number}`,
  site: "https://team.atlassian.net",
  repo: "",
  projectPath: "",
  labels: [],
  assignees: [],
  state: "open",
  updatedAt: "",
  draft: false,
  ...over,
});

const edge = (
  key: string,
  label: string,
  target: InboxItem | null,
  over: Partial<InboxRelationEdge> = {},
): InboxRelationEdge => ({
  key,
  label,
  ref: target?.identifier ?? over.ref ?? "",
  item: target,
  ...over,
});

describe("groupInboxRelations", () => {
  it("orders canonical groups and keeps provider labels inside them", () => {
    const groups = groupInboxRelations(item(1), [
      edge("related", "relates to", item(5)),
      edge("parent", "Parent", item(2)),
      edge("blocked-by", "is blocked by", item(4)),
      edge("children", "Sub-task", item(3)),
      edge("blocks", "blocks", item(6)),
      edge("duplicate", "duplicates", item(7)),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "parent",
      "children",
      "blocks",
      "blocked-by",
      "related",
      "duplicate",
    ]);
    expect(groups[0].label).toBe("Parent");
    expect(groups[4].edges[0].label).toBe("relates to");
  });

  it("drops self-links and dedupes repeated targets per group", () => {
    const groups = groupInboxRelations(item(1), [
      edge("related", "relates to", item(1)),
      edge("related", "relates to", item(2)),
      edge("related", "relates to", item(2)),
      edge("blocks", "blocks", item(2)),
    ]);
    const related = groups.find((group) => group.key === "related");
    expect(related?.edges).toHaveLength(1);
    expect(groups.find((group) => group.key === "blocks")?.edges).toHaveLength(
      1,
    );
  });

  it("keeps ref-only edges and orders custom groups last", () => {
    const groups = groupInboxRelations(item(1), [
      edge("custom-b", "mirrors", null, { ref: "EXT-9" }),
      edge("related", "relates to", item(2)),
      edge("custom-a", "causes", null, { ref: "EXT-8" }),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "related",
      "custom-a",
      "custom-b",
    ]);
    const custom = groups[1].edges[0];
    expect(custom.item).toBeNull();
    expect(custom.label).toBe("causes");
    expect(groups[1].label).toBe("causes");
  });

  it("treats an empty key as related and skips empty edges", () => {
    const groups = groupInboxRelations(item(1), [
      edge("", "linked", item(2)),
      edge("related", "", null),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("related");
    expect(groups[0].edges).toHaveLength(1);
  });

  it("drops ref-only self-links and dedupes case-variant keys", () => {
    const groups = groupInboxRelations(item(1), [
      edge("related", "relates to", null, { ref: "ENG-1" }),
      edge("related", "relates to", null, { ref: "#1" }),
      edge("Blocks", "blocks", item(2)),
      edge("blocks", "blocks", item(2)),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("blocks");
    expect(groups[0].edges).toHaveLength(1);
  });
});

describe("loadInboxRelations", () => {
  it("degrades a malformed Jira target to a ref-only row instead of failing", async () => {
    call.mockResolvedValue({
      edges: [
        { key: "related", label: "relates to", ref: "ENG-9", item: { broken: true } },
        {
          key: "parent",
          label: "Parent",
          ref: "ENG-2",
          item: {
            id: "10002",
            key: "ENG-2",
            fields: {
              summary: "Parent issue",
              status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
              project: { key: "ENG", name: "Engineering" },
              updated: "2026-01-01T00:00:00Z",
            },
          },
        },
      ],
      truncated: true,
    });
    const relations = await loadInboxRelations(item(1));
    expect(call).toHaveBeenCalledWith("jira_issue_relations", {
      site: "https://team.atlassian.net",
      id: "1",
    });
    expect(relations.truncated).toBe(true);
    const broken = relations.groups
      .find((group) => group.key === "related")
      ?.edges[0];
    expect(broken?.ref).toBe("ENG-9");
    expect(broken?.item).toBeNull();
    expect(
      relations.groups.find((group) => group.key === "parent")?.edges[0].item
        ?.identifier,
    ).toBe("ENG-2");
  });

  it("normalizes GitHub edges and keeps foreign rows display-only", async () => {
    call.mockResolvedValue({
      edges: [
        {
          key: "children",
          label: "Sub-issue",
          ref: "#9",
          foreign: false,
          item: {
            number: 9,
            title: "Sub",
            url: "https://github.com/acme/web/issues/9",
            state: "open",
            updatedAt: "",
            repo: "acme/web",
            foreign: false,
          },
        },
        {
          key: "children",
          label: "Sub-issue",
          ref: "#4",
          foreign: true,
          item: {
            number: 4,
            title: "Other repo",
            url: "https://github.com/acme/api/issues/4",
            state: "open",
            updatedAt: "",
            repo: "acme/api",
            foreign: true,
          },
        },
      ],
      truncated: false,
    });
    const source = item(1, {
      provider: "github",
      kind: "issue",
      repo: "acme/web",
      projectPath: "/repo",
      account: "acme",
    });
    const relations = await loadInboxRelations(source);
    expect(call).toHaveBeenCalledWith("git_github_issue_relations", {
      cwd: "/repo",
      kind: "issue",
      number: 1,
    });
    const children = relations.groups.find((group) => group.key === "children");
    expect(children?.edges).toHaveLength(2);
    expect(children?.edges[0].foreign).toBe(false);
    expect(children?.edges[0].item?.account).toBe("acme");
    expect(children?.edges[1].foreign).toBe(true);
  });
});
