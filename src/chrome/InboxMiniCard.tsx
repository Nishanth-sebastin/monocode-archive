import { ChevronRight, CircleDot, GitPullRequest, X } from "./icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GithubLabel, InboxComposerCard } from "../lib/githubTasks";
import { InboxProviderMark } from "./InboxProviderMark";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";

type Props = {
  card: InboxComposerCard;
  onDismiss?: () => void;
};

export function InboxMiniCard({ card, onDismiss }: Props) {
  const KindIcon = card.kind === "pr" ? GitPullRequest : CircleDot;
  const kindLabel =
    card.kind === "pr"
      ? card.provider === "gitlab"
        ? "Merge request"
        : "Pull request"
      : "Issue";
  const providerLabel =
    card.provider === "jira"
      ? "Jira"
      : card.provider === "linear"
        ? "Linear"
        : card.provider === "gitlab"
          ? "GitLab"
          : "GitHub";

  return (
    <div className="px-3 pt-2">
      <div className="relative rounded-md border border-content/10 bg-content/6 px-2.5 py-2 pr-8">
        <button
          type="button"
          title={`Open in ${providerLabel}`}
          aria-label={`Open ${kindLabel} ${card.identifier} in ${providerLabel}`}
          disabled={!card.url}
          onClick={() => {
            if (card.url) void openUrl(card.url);
          }}
          className="flex w-full flex-col text-left disabled:cursor-default"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <InboxProviderMark
              provider={card.provider}
              className="size-3.5 shrink-0"
            />
            <KindIcon
              className="size-3 shrink-0 text-content/45"
              strokeWidth={1.75}
            />
            <span className="min-w-0 truncate text-[11px] text-content/50">
              {kindLabel} · {card.identifier}
            </span>
          </span>
          <span className="mt-1 line-clamp-1 text-[13px] font-semibold leading-snug text-content">
            {card.title}
          </span>
          <span className="mt-1 flex w-full min-w-0 items-center gap-2">
            {card.source ? (
              <span className="min-w-0 flex-1 truncate text-[11px] text-content/45">
                {card.source}
              </span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            {card.labels.length > 0 ? (
              <span className="flex min-w-0 shrink-0 items-center gap-1">
                {card.labels.map((label) => (
                  <InboxMiniLabel key={label.name} label={label} />
                ))}
              </span>
            ) : null}
          </span>
        </button>
        {card.contextSummary ? (
          <p className="mt-2 border-t border-content/10 pt-2 text-[11px] text-content/55">
            {card.contextSummary.replace(
              /\d+ files/,
              `${card.attachments?.length ?? 0} files`,
            )}{" "}
            · next message only
          </p>
        ) : null}
        {card.contextPreview ? (
          <details className="group/context-preview mt-2 text-[12px] text-content/55">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 hover:bg-content/5 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 shrink-0 group-open/context-preview:rotate-90" />
              Preview selected context
            </summary>
            <div className="mt-3 max-h-80 space-y-4 overflow-auto pr-2">
              {card.contextPreview.description !== undefined ? (
                <section>
                  <h4 className="mb-2 font-medium text-content">Description</h4>
                  <AgentMarkdown
                    text={card.contextPreview.description || "No description"}
                    textOnly
                  />
                </section>
              ) : (
                <p>Ticket title and link only; description excluded.</p>
              )}
              {card.contextPreview.comments.map((comment) => (
                <section
                  key={comment.id}
                  className="border-t border-content/10 pt-3"
                >
                  <h4 className="mb-2 font-medium text-content">
                    {comment.author}{" "}
                    <span className="font-normal text-content/45">
                      · {comment.createdAt?.slice(0, 10)}
                    </span>
                  </h4>
                  <AgentMarkdown text={comment.body} textOnly />
                </section>
              ))}
              <p className="text-[11px] text-content/40">
                Only files shown in the attachment chips are included. Nothing
                else is fetched automatically.
              </p>
            </div>
          </details>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            title="Remove"
            aria-label={`Remove ${kindLabel} ${card.identifier}`}
            onClick={onDismiss}
            className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function InboxMiniLabel({ label }: { label: GithubLabel }) {
  const color = labelColor(label.color);
  return (
    <span className="inline-flex min-w-0 max-w-20 items-center gap-1 rounded bg-content/8 px-1.5 py-px text-[10px] text-content/50">
      {color ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      ) : null}
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  );
}

function labelColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex}`;
}
