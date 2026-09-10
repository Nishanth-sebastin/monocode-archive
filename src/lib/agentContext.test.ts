import { describe, expect, it, vi } from "vitest";
import {
  boundAgentContext,
  composeAgentContext,
  contextFromChanges,
  contextFromText,
  contextFromTickets,
  MAX_CONTEXT_TEXT,
  prepareSessionContext,
} from "./agentContext";
import type { InboxItem } from "./githubTasks";
import { isBlankSession, type Session } from "./session";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const session = {
  id: "recipient",
  harness: "codex",
  cwd: "/other",
  busy: true,
} as Session;
const ticket = {
  provider: "jira",
  account: "alice",
  site: "https://team.atlassian.net",
  id: "1",
  number: 1,
  identifier: "ENG-1",
  title: "Ticket",
  url: "https://team.atlassian.net/browse/ENG-1",
  state: "Open",
  repo: "ENG",
  labels: [],
} as unknown as InboxItem;

describe("selected context preparation", () => {
  it("does not replace or retarget a conversation with prepared context", () => {
    const empty = { ...session, busy: false, blocks: [] };
    expect(isBlankSession(empty)).toBe(true);
    expect(
      isBlankSession(
        prepareSessionContext(
          empty,
          contextFromText("File", "Contents", "/source"),
        ),
      ),
    ).toBe(false);
    expect(
      isBlankSession({
        ...empty,
        inboxCard: contextFromTickets([ticket]).entries[0].ticket,
      }),
    ).toBe(false);
  });
  it("bounds text visibly and preserves every ticket's identity even after exhaustion", () => {
    const context = contextFromTickets([
      ticket,
      { ...ticket, account: "bob" },
      { ...ticket, provider: "azure" },
    ]);
    expect(new Set(context.entries.map((entry) => entry.id)).size).toBe(3);
    const bounded = boundAgentContext({
      ...context,
      entries: context.entries.map((entry) => ({
        ...entry,
        text: "x".repeat(MAX_CONTEXT_TEXT),
      })),
    });
    expect(bounded.entries.map((entry) => entry.text).join("")).toHaveLength(
      MAX_CONTEXT_TEXT,
    );
    expect(bounded.entries[1].truncated).toBe(true);
    expect(bounded.entries[1].origin).toContain("bob");
    expect(composeAgentContext(bounded, "Review")).toContain(
      "untrusted context",
    );
    expect(composeAgentContext(bounded, "Review")).toContain(
      "Selected context truncated",
    );
  });

  it("prepares for the exact busy recipient without sending, queuing or altering its links", () => {
    const original = {
      ...session,
      linkedWorkItem: {
        kind: "issue" as const,
        repo: "other/repo",
        number: 7,
        url: "https://github.com/other/repo/issues/7",
      },
    };
    const context = contextFromText(
      "Selected response",
      "Only this passage",
      "source-session /source/worktree message-4",
    );
    const next = prepareSessionContext(original, context);
    expect(next.id).toBe("recipient");
    expect(next.busy).toBe(true);
    expect(next.linkedWorkItem).toBe(original.linkedWorkItem);
    expect(next.queuedMessages).toBeUndefined();
    expect(original.contextDraft).toBeUndefined();
    expect(prepareSessionContext(next, context)).toBe(next);
    expect(() =>
      prepareSessionContext(
        next,
        contextFromText("Other", "Other", "Elsewhere"),
      ),
    ).toThrow("already has prepared context");
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("appends an explicitly selected hunk to owning-session context without duplication", () => {
    const files = contextFromText("a.ts", "Before / after", "/repo");
    const comment = contextFromText("a.ts:5", "Review this line", "/repo");
    const next = prepareSessionContext(
      prepareSessionContext(session, files),
      comment,
      true,
    );
    expect(next.contextDraft?.entries).toHaveLength(2);
    expect(prepareSessionContext(next, comment, true)).toBe(next);
    const refreshed = {
      ...comment,
      id: "new-capture",
      entries: [{ ...comment.entries[0], text: "Updated selection" }],
    };
    const updated = prepareSessionContext(next, refreshed, true);
    expect(updated.contextDraft?.entries).toHaveLength(2);
    expect(updated.contextDraft?.entries[1].text).toBe("Updated selection");
  });

  it("rejects oversized bundles and unsupported image recipients without losing the draft", () => {
    const context = contextFromText("Image", "Screenshot", "source");
    context.attachments = [
      {
        id: "image",
        kind: "image",
        mimeType: "image/png",
        name: "image.png",
        size: 10,
        data: "aW1hZ2U=",
      },
    ];
    expect(() =>
      prepareSessionContext({ ...session, harness: "fx" }, context),
    ).toThrow("does not support attachments");
    expect(() =>
      boundAgentContext({
        ...context,
        attachments: Array(21).fill(context.attachments[0]),
      }),
    ).toThrow("20 files");
    expect(() =>
      boundAgentContext({
        ...context,
        entries: Array(21).fill(context.entries[0]),
      }),
    ).toThrow("20 items");
  });

  it("captures the selected diff kind and retains deleted-file snapshots", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      status: "deleted",
      original: "old content",
      current: "",
      binary: false,
      tooLarge: false,
    });
    const context = await contextFromChanges("/source", [
      { relative: "a.ts", kind: "staged" },
    ]);
    expect(invoke).toHaveBeenLastCalledWith("git_file_diff", {
      cwd: "/source",
      relative: "a.ts",
      staged: true,
    });
    expect(context.entries[0].origin).toContain("staged · deleted");
    expect(context.entries[0].text).toContain("old content");
    vi.mocked(invoke).mockResolvedValueOnce({ binary: true });
    await expect(
      contextFromChanges("/source", [{ relative: "a.bin", kind: "unstaged" }]),
    ).rejects.toThrow("binary or oversized");
  });
});
