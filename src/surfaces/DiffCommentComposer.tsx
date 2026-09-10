import { contextFromText, requestAgentContext } from "../lib/agentContext";
import { useState } from "react";
import { Bot, MessageSquarePlus, X } from "../chrome/icons";
import { Popover, type PopoverAnchor } from "../chrome/Popover";
import { diffCommentLocation, formatDiffComment } from "../lib/diffComment";
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
      width={360}
      onDismiss={onDismiss}
      role="dialog"
      aria-label={`Comment on ${location}`}
      className="overflow-hidden"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          addToChat();
        }}
      >
        <div className="flex items-center gap-2 border-b border-content/10 px-3 py-2">
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
          placeholder="Comment on this line…"
          className="block max-h-40 min-h-20 w-full resize-y bg-transparent px-3 py-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/35"
        />
        <div className="flex items-center justify-end gap-1 border-t border-content/10 p-1.5">
          <button type="button" disabled={!comment.trim()} className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-content/65 hover:bg-content/5 disabled:opacity-40" onClick={() => { requestAgentContext({ context: contextFromText(`Diff comment ${location}`, formatDiffComment({ path: sourcePath, line: target.line }, comment), sourcePath) }); onDismiss(); }}><Bot className="size-3.5" strokeWidth={1.75} />Send to agent…</button>
          <button
            type="submit"
            disabled={!comment.trim()}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 disabled:cursor-default disabled:opacity-40"
          >
            <MessageSquarePlus className="size-3.5" strokeWidth={1.75} />
            Add to chat
          </button>
        </div>
      </form>
    </Popover>
  );
}
