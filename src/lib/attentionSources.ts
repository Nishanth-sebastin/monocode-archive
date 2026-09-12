import {
  ATTENTION_ACTION,
  ATTENTION_INFO,
  ATTENTION_URGENT,
  type AttentionItem,
} from "./attention";
import { composeToolTitle } from "./harness/preview";
import { displayPath } from "./paths";
import type { RepairRecord } from "./repair";
import {
  HARNESS_TITLE,
  sessionDisplayTitle,
  sessionWorkCwd,
  type Session,
} from "./session";
import type { SessionReminder } from "./sessionReminders";

/**
 * Local signals → AttentionItems (#76 "feed the queue from local signals
 * first"). These rows are *derived*: recomputed from live state on every
 * read, so they clear the moment the underlying condition resolves — an
 * answered approval, a reviewed session, a released repair. They are never
 * written to the attention store; only their mute state persists.
 */

function pendingApprovals(session: Session): AttentionItem[] {
  const items: AttentionItem[] = [];
  const title = sessionDisplayTitle(session.title, session.harness);
  const cwd = sessionWorkCwd(session);
  for (const block of session.blocks) {
    if (!block.approval || block.approval.decided) continue;
    const preview = block.tool?.preview;
    const what =
      composeToolTitle({
        kind: block.tool?.kind,
        title: block.text || block.tool?.title,
        path: preview?.path
          ? displayPath(preview.path, session.cwd)
          : preview?.fileName,
        query: preview?.query,
        previewKind: preview?.kind,
        cwd: session.cwd,
      }) || block.text;
    items.push({
      key: `approval:${session.id}:${block.approval.requestId}`,
      kind: "approval",
      title: what ? `Approve: ${what.slice(0, 120)}` : `${HARNESS_TITLE[session.harness]} needs approval`,
      detail: title,
      urgency: ATTENTION_URGENT,
      at: block.startedAt ?? Date.now(),
      signature: `approval:${block.approval.requestId}`,
      provider: undefined,
      cwd,
      sessionId: session.id,
      action: { kind: "open-session", sessionId: session.id },
    });
  }
  if (session.pendingQuestion) {
    const question = session.pendingQuestion;
    items.push({
      key: `question:${session.id}:${question.requestId}`,
      kind: "approval",
      title:
        question.title ||
        question.questions[0]?.prompt ||
        `${HARNESS_TITLE[session.harness]} has a question`,
      detail: title,
      urgency: ATTENTION_URGENT,
      at: Date.now(),
      signature: `question:${question.requestId}`,
      cwd,
      sessionId: session.id,
      action: { kind: "open-session", sessionId: session.id },
    });
  }
  return items;
}

function finishedItems(
  session: Session,
): AttentionItem[] {
  const title = sessionDisplayTitle(session.title, session.harness);
  const cwd = sessionWorkCwd(session);
  // Signature binds to the turn that finished — a new turn finishing later
  // resurfaces even if the user muted this row.
  let turnStart: number | undefined;
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    if (session.blocks[i].role === "user") {
      turnStart = session.blocks[i].startedAt;
      break;
    }
  }
  const signature = `finished:${turnStart ?? 0}`;
  return [
    {
      key: `finished:${session.id}:${signature}`,
      kind: "finished",
      title: `${title} finished`,
      detail: displayPath(cwd) || "Review the result",
      urgency: ATTENTION_ACTION,
      at: Date.now(),
      signature,
      cwd,
      sessionId: session.id,
      action: { kind: "open-changes", sessionId: session.id },
    },
  ];
}

function reminderItems(reminder: SessionReminder): AttentionItem[] {
  return [
    {
      key: `reminder:${reminder.sessionId}:${reminder.dueAt}`,
      kind: "reminder",
      title: reminder.title || "Session reminder",
      detail: `${HARNESS_TITLE[reminder.harness]} · ${displayPath(reminder.cwd)}`,
      urgency: ATTENTION_URGENT,
      at: reminder.firedAt ?? reminder.dueAt,
      signature: `reminder:${reminder.dueAt}`,
      cwd: reminder.cwd,
      sessionId: reminder.sessionId,
      action: { kind: "open-session", sessionId: reminder.sessionId },
    },
  ];
}

const REPAIR_ATTENTION: Record<string, { urgency: 1 | 2; label: string }> = {
  blocked: { urgency: ATTENTION_ACTION, label: "Repair blocked" },
  uncertain: { urgency: ATTENTION_ACTION, label: "Repair result uncertain" },
  completed: { urgency: ATTENTION_INFO, label: "Repair finished" },
};

function repairItems(record: RepairRecord, sessions: Session[]): AttentionItem[] {
  const attention = REPAIR_ATTENTION[record.state];
  if (!attention) return [];
  const session = sessions.find((row) => row.id === record.session);
  // The owning conversation is gone — the record stays for reconciliation but
  // cannot be actioned; drop it from the queue rather than showing a dead row.
  if (!session) return [];
  return [
    {
      key: `repair:${record.id}`,
      kind: "repair",
      title: `${attention.label} · ${sessionDisplayTitle(session.title, session.harness)}`,
      detail: record.detail,
      urgency: attention.urgency,
      at: record.at,
      signature: `repair:${record.state}:${record.at}`,
      cwd: record.cwd,
      sessionId: session.id,
      action: { kind: "open-session", sessionId: session.id },
    },
  ];
}

/**
 * Everything the local session state currently wants the user to see.
 * `unseenFinishedIds` is the same set the Working rail card uses.
 */
export function deriveLocalAttention(input: {
  sessions: Session[];
  unseenFinishedIds: ReadonlySet<string>;
  reminders: SessionReminder[];
  repairs: RepairRecord[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const byId = new Set(input.unseenFinishedIds);
  for (const session of input.sessions) {
    if (session.inboxAsk) continue;
    items.push(...pendingApprovals(session));
    if (byId.has(session.id)) items.push(...finishedItems(session));
  }
  for (const reminder of input.reminders) {
    items.push(...reminderItems(reminder));
  }
  for (const record of input.repairs) {
    items.push(...repairItems(record, input.sessions));
  }
  return items;
}
