import type { AgentContext } from "../lib/agentContext";
import { InboxProviderMark } from "./InboxProviderMark";

export function AgentContextChips({
  context,
  onDismiss,
}: {
  context: AgentContext;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-1.5 px-3 pt-2 text-[12px] text-content">
      {context.entries.map((entry) => (
        <details
          key={entry.id}
          className="max-w-full rounded-md border border-content/10 bg-content/5 px-2 py-1"
        >
          <summary className="flex cursor-pointer items-center gap-1.5 focus-visible:outline-accent">
            {entry.ticket ? (
              <InboxProviderMark
                provider={entry.ticket.provider}
                className="size-3 shrink-0"
              />
            ) : null}
            <span className="max-w-64 truncate">{entry.title}</span>
            {entry.status ? (
              <span className="text-[11px] text-content/50">
                {entry.status}
              </span>
            ) : null}
            {entry.truncated ? (
              <span className="text-amber-500">Truncated</span>
            ) : null}
          </summary>
          <p className="my-2 break-all text-[11px] text-content/55">
            {entry.origin}
          </p>
          <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words font-sans">
            {entry.text || "Text omitted by the bundle limit."}
          </pre>
        </details>
      ))}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="px-1 py-1 text-content/50 hover:text-content"
        >
          Remove context
        </button>
      ) : null}
    </div>
  );
}
