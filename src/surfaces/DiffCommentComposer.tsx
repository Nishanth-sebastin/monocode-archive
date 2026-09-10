import { contextFromText, requestAgentContext } from "../lib/agentContext";
import { useState } from "react";
import { MessageSquarePlus, X } from "../chrome/icons";
import { Popover, type PopoverAnchor } from "../chrome/Popover";
import { diffCommentLocation, formatDiffComment } from "../lib/diffComment";
import { MOD } from "../lib/platform";
import { requestAddToChat } from "../lib/quoteDraft";
import type { UnifiedLine } from "../lib/unifiedDiff";

export type DiffCommentComposerTarget = {
  line: UnifiedLine;
  anchor: PopoverAnchor;
};

export function DiffCommentComposer({
  path,
  sourcePath = path,
  target,
  onDismiss,
}: {
  path: string;
  sourcePath?: string;
  target: DiffCommentComposerTarget;
  onDismiss: () => void;
}) {
  const [comment, setComment] = useState("");
  const location = diffCommentLocation({ path, line: target.line });
  const addToChat = () => {
    const text = formatDiffComment({ path: sourcePath, line: target.line }, comment);
    if (!text) return;
    requestAddToChat(text, "plain");
    onDismiss();
  };

  return (
    <Popover
      anchor={target.anchor}
      side="right"
      align="start"
      gap={6}
      width={320}
      onDismiss={onDismiss}
      role="dialog"
      aria-label={`Comment on ${location}`}
      className="p-2"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          addToChat();
        }}
      >
        <div className="mb-1.5 flex items-center gap-2 px-0.5">
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-content/55"
            title={location}
          >
            {location}
          </span>
          <button
            type="button"
            title="Cancel comment"
            aria-label="Cancel comment"
            onClick={onDismiss}
            className="grid size-5 shrink-0 place-items-center rounded text-content/45 hover:bg-content/10 hover:text-content"
          >
            <X className="size-3" strokeWidth={1.75} />
          </button>
        </div>
        <textarea
          autoFocus
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              comment.trim()
            ) {
              event.preventDefault();
              addToChat();
            }
          }}
          placeholder="Leave a comment…"
          className="max-h-40 min-h-18 w-full resize-y rounded-lg border border-content/10 bg-background-base/70 px-2.5 py-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/35 focus:border-content/20"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[10px] text-content/35">{MOD}↩ to add</span>
          <button type="button" disabled={!comment.trim()} className="text-[11px] text-content/60 underline disabled:opacity-40" onClick={() => requestAgentContext({ context: contextFromText(`Diff comment ${location}`, formatDiffComment({ path, line: target.line }, comment), sourcePath) })}>Send to agent…</button>
          <button
            type="submit"
            disabled={!comment.trim()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-content px-2.5 text-[12px] font-medium text-background-base hover:opacity-80 disabled:cursor-default disabled:opacity-40"
          >
            <MessageSquarePlus className="size-3.5" strokeWidth={1.75} />
            Add to chat
          </button>
        </div>
      </form>
    </Popover>
  );
}
