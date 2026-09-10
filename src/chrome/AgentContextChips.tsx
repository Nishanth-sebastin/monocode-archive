import { formatCodeBlock } from "../lib/editorSelection";
import { useRef, useState } from "react";
import { File, X } from "./icons";
import { Popover } from "./Popover";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";
import type { AgentContext } from "../lib/agentContext";
import { InboxMiniCard } from "./InboxMiniCard";

export function AgentContextChips({
  context,
  onDismiss,
}: {
  context: AgentContext;
  onDismiss?: (entryId?: string) => void;
}) {
  return (
    <div
      aria-label="Attached context"
      className="max-h-[min(35vh,240px)] overflow-y-auto overscroll-contain"
    >
      {context.entries
        .filter((entry) => entry.ticket)
        .map((entry) => (
          <InboxMiniCard
            key={entry.id}
            card={{
              ...entry.ticket!,
              contextSummary: entry.truncated
                ? "Description (truncated)"
                : "Description",
              contextPreview: { description: entry.text, comments: [] },
            }}
            onDismiss={onDismiss ? () => onDismiss(entry.id) : undefined}
          />
        ))}
      {context.entries.some((entry) => !entry.ticket) ? (
        <div className="flex flex-wrap items-start gap-1.5 px-3 pt-2 text-[12px] text-content">
          {context.entries
            .filter((entry) => !entry.ticket)
            .map((entry) => (
              <ContextChip
                key={entry.id}
                entry={entry}
                onDismiss={onDismiss ? () => onDismiss(entry.id) : undefined}
              />
            ))}
        </div>
      ) : null}
    </div>
  );
}

function ContextChip({
  entry,
  onDismiss,
}: {
  entry: AgentContext["entries"][number];
  onDismiss?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="group relative flex min-w-0 items-center gap-1.5 rounded-md bg-content/10 py-0.5 pl-1 pr-1">
        <button
          ref={anchor}
          type="button"
          aria-expanded={open}
          title={entry.origin}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded text-content/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <File className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="max-w-[180px] truncate text-[11px] leading-none">
            {entry.title}
          </span>
          {entry.truncated ? (
            <span className="text-[10px] text-amber-500">Truncated</span>
          ) : null}
        </button>
        {onDismiss ? (
          <button
            type="button"
            title="Remove"
            aria-label={`Remove ${entry.title}`}
            onClick={onDismiss}
            className="grid size-4 shrink-0 place-items-center rounded-full text-content/40 hover:bg-content/15 hover:text-content"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        ) : null}
      </div>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          width={460}
          maxHeight={320}
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label="Context preview"
          className="overflow-y-auto p-3"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
              {entry.title}
            </span>
            <button
              type="button"
              aria-label="Close preview"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-content/50 hover:bg-content/5"
            >
              <X className="size-3" />
            </button>
          </div>
          <AgentMarkdown
            text={entry.language ? formatCodeBlock(entry.text, entry.language) : entry.text || "Text omitted by the context limit."}
            textOnly
          />
          <p className="mt-2 break-all border-t border-content/10 pt-2 text-[10px] text-content/45">
            {entry.origin}
          </p>
        </Popover>
      ) : null}
    </>
  );
}
