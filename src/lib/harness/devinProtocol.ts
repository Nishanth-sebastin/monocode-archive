import { promptBlocks, type PromptContentBlock } from "../attachments";
import { modelsFor, type AgentModel } from "../models";
import type { Attachment, RuntimeMode, ToolPreview } from "../session";
import { normalizeTaskListStatus } from "../taskList";
import type { UserQuestion, UserQuestionReply } from "../userQuestion";
import type { ApprovalDecision, HarnessEvent } from "./types";
import { nativeCommandInvocation, type NativeCommand } from "./nativeCommands";
import {
  composeToolTitle,
  extractSearchQuery,
  extractShellCommand,
  extractSkillName,
  extractToolPreview,
} from "./preview";

/**
 * `elicitation.form` advertises form-mode questions; an empty `elicitation`
 * object advertises no modes and Devin would never send `elicitation/create`.
 */
export const DEVIN_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
};

export const AUTH_HELP =
  "Devin CLI is not signed in. Run `devin auth login` in a terminal, then retry.";

/**
 * True when Devin CLI output reports a real auth problem. Matches explicit
 * failure phrases rather than any "login"/"auth" substring so routine stderr
 * logs like `toolbox::tools::exec::login_shell_env` snapshots don't surface a
 * spurious "not signed in" error while the session works fine.
 */
const DEVIN_AUTH_MESSAGE =
  /not (?:signed|logged) in|not authenticated|unauthori[sz]ed|authentication (?:required|failed|error)|(?:please|then|must) (?:log|sign) ?in|(?:log|sign) ?in (?:required|first|again|to continue)|(?:signed|logged) out|invalid (?:api key|access token|token|credentials?)|expired (?:token|credentials?|session)|(?:token|credentials?|session)(?:\s+(?:has|have|is))?\s+expired|(?:401|403)[^\n]*(?:unauthori[sz]ed|forbidden)|(?:unauthori[sz]ed|forbidden)[^\n]*\b(?:401|403)\b|devin auth login/i;

export function isDevinAuthMessage(text: string): boolean {
  return DEVIN_AUTH_MESSAGE.test(text);
}

export type DevinConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options: DevinConfigChoice[];
};

export type DevinConfigChoice = {
  value: string;
  name: string;
  contextWindow?: number;
};

export type DevinPermissionRequest = {
  title: string;
  kind?: string;
  callId?: string;
  preview?: ToolPreview;
  optionIds: string[];
};

/** One schema property of a Devin `elicitation/create` request. */
export type DevinElicitField = {
  key: string;
  multi: boolean;
  /** UserQuestion option id → the schema value Devin expects back. */
  values: Record<string, unknown>;
};

const MAX_CATALOG_ITEMS = 200;
/** Raw variant cap before grouping — Devin currently ships ~420 choices. */
const MAX_CATALOG_VARIANTS = 2000;
const MAX_DESCRIPTION_CHARS = 240;

/** Devin advertises image and embedded-context prompt blocks. */
export function devinPromptBlocks(
  text: string,
  attachments: Attachment[] = [],
): PromptContentBlock[] {
  return promptBlocks(text, attachments);
}

export function devinSpawnArgs(): string[] {
  return ["acp"];
}

/**
 * Pick a provider-advertised session mode for a MonoCode runtime mode.
 * `session/set_mode` silently ignores unknown ids, so only ids the session
 * actually listed are candidates. Nothing suitable → keep Devin's own mode.
 */
export function devinModeId(
  runtimeMode: RuntimeMode,
  planning: boolean,
  advertised: string[],
): string | undefined {
  const pick = (candidates: string[]) =>
    candidates.find((id) => advertised.includes(id));
  if (planning) {
    return pick(["plan", "ask"]);
  }
  switch (runtimeMode) {
    case "full-access":
      return pick(["bypass", "dangerous", "yolo", "auto-accept"]);
    case "auto":
      return pick(["smart", "auto", "autonomous"]);
    case "auto-accept-edits":
      return pick([
        "accept-edits",
        "accept_edits",
        "acceptedits",
        "acceptEdits",
      ]);
    case "supervised":
      // Devin exposes no prompt-for-everything ACP mode; accept-edits still
      // routes shell commands through request_permission, which we surface.
      return pick(["normal", "manual", "default", "accept-edits", "code"]);
    default:
      return undefined;
  }
}

export function devinModesFromSetup(result: unknown): {
  currentModeId?: string;
  availableModeIds: string[];
} {
  const rec = asRecord(result);
  const modes = asRecord(rec?.modes);
  const available = Array.isArray(modes?.availableModes)
    ? modes.availableModes
    : Array.isArray(modes?.available_modes)
      ? modes.available_modes
      : [];
  const ids = available.flatMap((item) => {
    const id = asRecord(item)?.id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
  const current =
    stringField(modes ?? {}, "currentModeId") ??
    stringField(modes ?? {}, "current_mode_id");
  return { currentModeId: current, availableModeIds: ids };
}

/** Mode ids are also offered as a `mode` config option on some versions. */
export function devinModeIdsFromConfig(options: DevinConfigOption[]): string[] {
  const mode =
    options.find((option) => option.id === "mode") ??
    options.find((option) => option.category === "mode");
  return (mode?.options ?? []).map((choice) => choice.value).filter(Boolean);
}

export function devinConfigOptions(raw: unknown): DevinConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const rec = asRecord(item);
    const id = String(rec?.id ?? rec?.configId ?? "").trim();
    if (!id) return [];
    const choices = Array.isArray(rec?.options) ? rec.options : [];
    return [
      {
        id,
        name: stringField(rec ?? {}, "name"),
        category: stringField(rec ?? {}, "category"),
        type: stringField(rec ?? {}, "type"),
        currentValue:
          typeof rec?.currentValue === "string" && rec.currentValue.trim()
            ? rec.currentValue
            : undefined,
        options: choices.flatMap((choice) => {
          const option = asRecord(choice);
          const value = String(option?.value ?? option?.id ?? "").trim();
          if (!value) return [];
          const meta = asRecord(option?._meta) ?? option ?? {};
          return [
            {
              value,
              name:
                stringField(option ?? {}, "name") ??
                stringField(option ?? {}, "label") ??
                value,
              contextWindow:
                numberField(meta, "cognition.ai/contextWindow") ??
                numberField(meta, "contextWindow"),
            },
          ];
        }),
      },
    ];
  });
}

export function devinModelConfigId(options: DevinConfigOption[]): string {
  const exact = options.find((option) => option.id === "model");
  if (exact) return exact.id;
  const byCategory = options.find(
    (option) =>
      option.category === "model" &&
      option.type === "select" &&
      option.options.length > 0,
  );
  return byCategory?.id ?? "model";
}

/**
 * Devin bakes the reasoning level into the model uid (`claude-opus-5-high`,
 * `gpt-5-6-sol-none-priority`). These patterns pull the level word back out of
 * a variant label so the picker can offer one model row with a separate
 * Reasoning select instead of one row per level. The first match wins — in a
 * Fusion label the primary's level precedes the sidekick's, so only the
 * primary's level is split out.
 */
const DEVIN_LEVELS: { re: RegExp; level: string }[] = [
  { re: /\bNo Thinking\b/i, level: "none" },
  { re: /\bNone\b/i, level: "none" },
  { re: /\bMinimal\b/i, level: "minimal" },
  { re: /\bLow(?:\s+Thinking)?\b/i, level: "low" },
  { re: /\bMedium(?:\s+Thinking)?\b/i, level: "medium" },
  { re: /\b(?:X-?High|Extra[- ]High)(?:\s+Thinking)?\b/i, level: "xhigh" },
  { re: /\bHigh(?:\s+Thinking)?\b/i, level: "high" },
  { re: /\bMax(?:\s+Thinking)?\b/i, level: "max" },
  { re: /\bThinking\b/i, level: "thinking" },
];

/**
 * Last resort when a label carries no level word (e.g. Devin starts omitting
 * `name` so the label is the uid itself): strip trailing speed/context
 * segments, then a trailing level segment, from the uid.
 */
const DEVIN_UID_LEVEL =
  /^(.*?)[-_](none|minimal|low|medium|high|xhigh|max|thinking)((?:[-_](?:fast|priority|1m))*)$/i;

const DEVIN_LEVEL_RANK: Record<string, number> = {
  default: 0,
  none: 1,
  minimal: 2,
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  max: 7,
  thinking: 8,
};

const DEVIN_LEVEL_LABEL: Record<string, string> = {
  default: "Standard",
  none: "No Thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  thinking: "Thinking",
};

type DevinVariant = {
  uid: string;
  /** Label with the reasoning level removed — the picker row's name. */
  descriptor: string;
  level: string;
  contextWindow?: number;
};

function parseDevinVariant(
  uid: string,
  label: string,
  contextWindow?: number,
): DevinVariant {
  const name = label.trim() || uid;
  let best: { index: number; end: number; level: string } | undefined;
  for (const { re, level } of DEVIN_LEVELS) {
    const match = re.exec(name);
    if (match && (!best || match.index < best.index)) {
      best = { index: match.index, end: match.index + match[0].length, level };
    }
  }
  if (!best) {
    const suffix = DEVIN_UID_LEVEL.exec(uid);
    if (suffix?.[1]) {
      const tail = (suffix[3] ?? "").replace(/priority/gi, "fast");
      const descriptor = `${suffix[1]}${tail}`.replace(/[-_]+/g, " ").trim();
      return {
        uid,
        descriptor: descriptor || name,
        level: suffix[2]!.toLowerCase(),
        contextWindow,
      };
    }
    return { uid, descriptor: name, level: "default", contextWindow };
  }
  const descriptor = `${name.slice(0, best.index)} ${name.slice(best.end)}`
    .replace(/\s+/g, " ")
    .trim();
  return {
    uid,
    descriptor: descriptor || name,
    level: best.level,
    contextWindow,
  };
}

/**
 * Groups variants that differ only in reasoning level into one model carrying
 * a `reasoning` select. Option values are the full variant uids — legacy
 * `MODEL_*` ids and Fusion pairs cannot be recomposed from a base + level.
 * `currentUid` (the session's live value) wins the default when present.
 */
function devinGroupedModels(
  variants: DevinVariant[],
  currentUid?: string,
  usedIds: Set<string> = new Set(),
): AgentModel[] {
  // Case-fold the key — labels that differ only in casing ("Model A" /
  // "model a") are the same family.
  const groups = new Map<string, { descriptor: string; list: DevinVariant[] }>();
  for (const variant of variants) {
    const key = variant.descriptor.toLowerCase();
    const group = groups.get(key);
    if (group) group.list.push(variant);
    else groups.set(key, { descriptor: variant.descriptor, list: [variant] });
  }
  const models: AgentModel[] = [];
  for (const { descriptor, list: members } of groups.values()) {
    if (models.length >= MAX_CATALOG_ITEMS) break;
    // Every variant stays selectable — two uids can share a level word
    // ("X" vs "X Thinking" labels), so disambiguate duplicate labels with the
    // uid rather than dropping a variant.
    const sorted = [...members].sort(
      (a, b) =>
        (DEVIN_LEVEL_RANK[a.level] ?? 9) - (DEVIN_LEVEL_RANK[b.level] ?? 9),
    );
    const levelCounts = new Map<string, number>();
    for (const member of sorted) {
      levelCounts.set(member.level, (levelCounts.get(member.level) ?? 0) + 1);
    }
    const active =
      (currentUid
        ? members.find((member) => member.uid === currentUid)
        : undefined) ?? members[0];
    if (!active) continue;
    const slug =
      descriptor
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || active.uid;
    let id = `devin:${slug}`;
    for (let suffix = 2; usedIds.has(id); suffix += 1) {
      id = `devin:${slug}-${suffix}`;
    }
    usedIds.add(id);
    models.push({
      id,
      harness: "devin",
      name: descriptor,
      nativeId: active.uid,
      ...(active.contextWindow ? { contextWindow: active.contextWindow } : {}),
      ...(sorted.length > 1
        ? {
            settings: [
              {
                id: "reasoning",
                label: "Reasoning",
                kind: "select" as const,
                value: active.uid,
                options: sorted.map((member) => ({
                  value: member.uid,
                  label:
                    (levelCounts.get(member.level) ?? 0) > 1
                      ? `${DEVIN_LEVEL_LABEL[member.level] ?? member.level} (${member.uid})`
                      : (DEVIN_LEVEL_LABEL[member.level] ?? member.level),
                })),
              },
            ],
          }
        : {}),
    });
  }
  return models;
}

/** Dynamic catalog from the session's `model` config option. */
export function devinModelsFromConfig(
  options: DevinConfigOption[],
): AgentModel[] {
  const model =
    options.find((option) => option.id === "model") ??
    options.find((option) => option.category === "model");
  const seen = new Set<string>();
  const variants: DevinVariant[] = [];
  for (const choice of (model?.options ?? []).slice(0, MAX_CATALOG_VARIANTS)) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    variants.push(
      parseDevinVariant(choice.value, choice.name, choice.contextWindow),
    );
  }
  return devinGroupedModels(variants, model?.currentValue);
}

/**
 * Maps a live `model` config value (a variant uid) back to the grouped
 * catalog entry: the model id plus the `reasoning` setting value when the uid
 * is one of that group's levels. Unknown uids keep their raw `devin:<uid>` id.
 */
export function devinModelSelectionForUid(
  options: DevinConfigOption[],
  uid: string,
  cwd?: string,
): { id: string; reasoning?: string } {
  const find = (models: AgentModel[]) => {
    for (const model of models) {
      const reasoning = model.settings?.find(
        (setting) => setting.id === "reasoning",
      );
      if (reasoning?.options.some((option) => option.value === uid)) {
        return { id: model.id, reasoning: uid };
      }
      if (model.nativeId === uid) return { id: model.id };
    }
    return undefined;
  };
  // The picker catalog (from `devin models list`) is the id space the picker
  // displays — prefer it so a reported uid maps to the same row the user sees.
  return (
    find(modelsFor("devin", cwd)) ??
    find(devinModelsFromConfig(options)) ?? { id: `devin:${uid}` }
  );
}

/** The model Devin reports as active after session setup or a config update. */
export function devinCurrentModelId(options: DevinConfigOption[]): string {
  const id = devinModelConfigId(options);
  return options.find((option) => option.id === id)?.currentValue ?? "";
}

/**
 * `devin models list --format json` → `{families: [{slug, variants: [
 * {model_uid, label, max_context_tokens}]}]}`. Variants are the concrete ids
 * `session/set_config_option` accepts; a family with no variants keeps its
 * slug — slugs are selectable aliases.
 */
export function devinModelsFromJson(raw: unknown): AgentModel[] {
  const rec = asRecord(raw);
  const families = Array.isArray(rec?.families) ? rec.families : [];
  const seen = new Set<string>();
  const variants: DevinVariant[] = [];
  const familiesOnly: { slug: string; label: string }[] = [];
  for (const item of families) {
    const family = asRecord(item);
    if (!family) continue;
    const slug = stringField(family, "slug") ?? stringField(family, "family_uid");
    const label =
      stringField(family, "family_label") ??
      stringField(family, "label") ??
      slug ??
      "";
    const entries = Array.isArray(family.variants) ? family.variants : [];
    if (slug && entries.length === 0) familiesOnly.push({ slug, label });
    for (const entry of entries) {
      if (variants.length >= MAX_CATALOG_VARIANTS) break;
      const variant = asRecord(entry);
      const uid = stringField(variant ?? {}, "model_uid");
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      variants.push(
        parseDevinVariant(
          uid,
          stringField(variant ?? {}, "label") ?? uid,
          numberField(variant, "max_context_tokens") ??
            numberField(variant, "context_window"),
        ),
      );
    }
  }
  const usedIds = new Set<string>();
  const models = devinGroupedModels(variants, undefined, usedIds);
  for (const { slug, label } of familiesOnly) {
    if (models.length >= MAX_CATALOG_ITEMS) break;
    let id = `devin:${slug}`;
    for (let suffix = 2; usedIds.has(id); suffix += 1) {
      id = `devin:${slug}-${suffix}`;
    }
    usedIds.add(id);
    models.push({ id, harness: "devin", name: label || slug, nativeId: slug });
  }
  return models;
}

export function devinModelsFromOutput(stdout: string): AgentModel[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf("{");
  if (start < 0) return [];
  try {
    return devinModelsFromJson(JSON.parse(trimmed.slice(start)));
  } catch {
    return [];
  }
}

export function devinCommandsFromUpdate(params: unknown): NativeCommand[] {
  const rec = asRecord(params);
  const update = asRecord(rec?.update) ?? rec;
  const raw =
    (Array.isArray(update?.availableCommands)
      ? update.availableCommands
      : undefined) ??
    (Array.isArray(update?.available_commands)
      ? update.available_commands
      : undefined) ??
    [];
  const commands: NativeCommand[] = [];
  for (const item of raw.slice(0, MAX_CATALOG_ITEMS)) {
    const command = asRecord(item);
    const name = String(command?.name ?? "").trim();
    if (!name || !/^[\w:.-]+$/.test(name)) continue;
    const input = asRecord(command?.input);
    const hint =
      stringField(input ?? {}, "hint") ??
      stringField(command ?? {}, "inputHint") ??
      stringField(command ?? {}, "input_hint");
    commands.push({
      name,
      description: cap(
        stringField(command ?? {}, "description") ?? "",
        MAX_DESCRIPTION_CHARS,
      ),
      invocation: nativeCommandInvocation("devin", name),
      source: "devin",
      ...(hint ? { inputHint: hint } : {}),
    });
  }
  return commands;
}

export function devinEventsFromUpdate(params: unknown): HarnessEvent[] {
  const rec = asRecord(params);
  const update = asRecord(rec?.update) ?? rec;
  if (!update) return [];
  const kind = String(
    update.sessionUpdate ?? update.session_update ?? update.type ?? "",
  );

  if (kind === "agent_message_chunk" || kind === "agent_message") {
    const text = textFromContent(
      update.content ?? update.text,
      kind === "agent_message" ? "\n" : "",
    );
    return text ? [{ type: "message.delta", text }] : [];
  }

  if (kind === "agent_thought_chunk" || kind === "agent_thought") {
    const text = textFromContent(
      update.content ?? update.text,
      kind === "agent_thought" ? "\n" : "",
    );
    return text ? [{ type: "reasoning.delta", text }] : [];
  }

  if (
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "tool_call_content_chunk"
  ) {
    const tool =
      asRecord(update.toolCall) ?? asRecord(update.tool_call) ?? update;
    const callId = String(
      tool.toolCallId ??
        tool.tool_call_id ??
        update.toolCallId ??
        update.tool_call_id ??
        "",
    );
    if (!callId) return [];
    const toolKind =
      stringField(update, "kind") ?? stringField(tool, "kind");
    const status = stringField(update, "status") ?? stringField(tool, "status");
    const preview = extractToolPreview(update, tool);
    const meta = asRecord(update._meta) ?? asRecord(tool._meta);
    const command =
      extractShellCommand(
        update.rawInput,
        tool.rawInput,
        update.raw_input,
        tool.raw_input,
        update.input,
        tool.input,
      ) ??
      (meta?.["cognition.ai/preview_is_shell_command"] === true
        ? stringField(meta, "cognition.ai/terminalPreview") ??
          stringField(meta, "cognition.ai/command")
        : undefined);
    const title =
      composeToolTitle({
        kind: toolKind,
        title: toolLabel(update) ?? toolLabel(tool),
        command,
        skill: extractSkillName(
          update.rawInput,
          tool.rawInput,
          update.raw_input,
          tool.raw_input,
          update.input,
          tool.input,
        ),
        path: preview?.path,
        query:
          preview?.query ??
          extractSearchQuery(
            update.rawInput ??
              tool.rawInput ??
              update.raw_input ??
              tool.raw_input ??
              update.input ??
              tool.input,
          ),
        previewKind: preview?.kind,
      }) ??
      toolLabel(update) ??
      toolLabel(tool);
    return [
      {
        type: "tool.updated",
        callId,
        title,
        kind: toolKind,
        status,
        detail: cap(toolDetail(update, tool) ?? "") || undefined,
        preview,
      },
    ];
  }

  if (kind === "plan" || kind === "current_plan") {
    const event = planEvent(update);
    return event ? [event] : [];
  }

  if (kind === "usage_update" || kind === "context_update") {
    const usage = usageFromUpdate(update);
    return usage ? [usage] : [];
  }

  const usage = usageFromUpdate(update);
  return usage ? [usage] : [];
}

export function devinPermissionRequest(
  params: unknown,
): DevinPermissionRequest {
  const rec = asRecord(params);
  const subject = asRecord(rec?.subject);
  const tool =
    asRecord(rec?.toolCall) ??
    asRecord(rec?.tool_call) ??
    asRecord(subject?.toolCall) ??
    asRecord(subject) ??
    rec ??
    {};
  const command = stringField(subject ?? {}, "command");
  const kind = stringField(tool, "kind") ?? stringField(subject ?? {}, "kind");
  const preview = extractToolPreview(tool, tool);
  const title =
    composeToolTitle({
      kind,
      title: toolLabel(tool),
      command: command ?? extractShellCommand(tool),
      skill: extractSkillName(tool),
      path: preview?.path,
      query: preview?.query ?? extractSearchQuery(tool),
      previewKind: preview?.kind,
    }) ||
    toolLabel(tool) ||
    command ||
    stringField(rec ?? {}, "title") ||
    "Permission";
  const options = Array.isArray(rec?.options) ? rec.options : [];
  const optionIds = options
    .map((item) => asRecord(item)?.optionId ?? asRecord(item)?.option_id)
    .filter((value): value is string => typeof value === "string");

  return {
    title,
    kind,
    callId:
      stringField(tool, "toolCallId") ??
      stringField(tool, "tool_call_id") ??
      stringField(rec ?? {}, "toolCallId"),
    preview,
    optionIds,
  };
}

/**
 * Requests that still reach us are answered by runtime mode: supervised keeps
 * every prompt, auto-accept-edits keeps shell/fetch/other prompts, and the
 * auto/full-access modes answer immediately since Devin already applied its
 * own mode judgement before asking.
 */
export function devinAutoOption(
  runtimeMode: RuntimeMode,
  kind: string | undefined,
  optionIds: string[],
): string | null {
  if (optionIds.length === 0) return null;
  const tool = (kind ?? "").toLowerCase();
  if (runtimeMode === "supervised") return null;
  if (
    runtimeMode === "auto-accept-edits" &&
    (tool === "execute" || tool === "other" || tool === "fetch")
  ) {
    return null;
  }
  if (runtimeMode === "full-access") {
    return pickOption(optionIds, [
      "allow-always",
      "allow_always",
      "allow-once",
      "allow_once",
      "allow",
    ]);
  }
  return pickOption(optionIds, [
    "allow-once",
    "allow_once",
    "allow-always",
    "allow_always",
    "allow",
  ]);
}

export function devinPermissionOptionId(
  decision: ApprovalDecision,
  optionIds: string[],
): string | undefined {
  const wanted =
    decision === "allow"
      ? [
          "allow-once",
          "allow_once",
          "allow-always",
          "allow_always",
          "allow",
        ]
      : [
          "reject-once",
          "reject_once",
          "reject-always",
          "reject_always",
          "reject",
          "deny",
        ];
  const match = pickOption(optionIds, wanted);
  if (match) return match;
  // Never invent an id Devin did not offer; fall back to the first advertised
  // option that looks like an allow/reject, else nothing.
  const kind = decision === "allow" ? "allow" : "reject";
  return optionIds.find((id) => id.toLowerCase().includes(kind));
}

/**
 * Devin asks free-form/choice questions through ACP `elicitation/create`
 * (MCP form schema). Each schema property becomes one UserQuestion; enum and
 * oneOf entries become fixed options, everything else is free text.
 */
export function devinElicitation(params: unknown): {
  title?: string;
  questions: UserQuestion[];
  fields: DevinElicitField[];
} | null {
  const rec = asRecord(params);
  const inner = asRecord(rec?.params) ?? rec;
  const schema =
    asRecord(inner?.requestedSchema) ??
    asRecord(inner?.requested_schema) ??
    asRecord(inner?.schema);
  const properties = asRecord(schema?.properties);
  if (!properties) return null;

  const questions: UserQuestion[] = [];
  const fields: DevinElicitField[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const field = asRecord(value);
    if (!field) continue;
    const type = String(field.type ?? "");
    const multi = type === "array";
    const target = multi ? (asRecord(field.items) ?? field) : field;
    const values: Record<string, unknown> = {};
    const options: { id: string; label: string; description?: string }[] = [];

    const enumValues = Array.isArray(target.enum) ? target.enum : [];
    const enumNames = Array.isArray(target.enumNames)
      ? target.enumNames
      : Array.isArray(target.enum_names)
        ? target.enum_names
        : [];
    enumValues.forEach((entry, index) => {
      const id = String(entry);
      const label =
        typeof enumNames[index] === "string" && enumNames[index].trim()
          ? String(enumNames[index])
          : String(entry);
      options.push({ id, label });
      values[id] = entry;
    });
    for (const item of Array.isArray(target.oneOf) ? target.oneOf : []) {
      const choice = asRecord(item);
      if (!choice || choice.const == null) continue;
      const id = String(choice.const);
      options.push({
        id,
        label: stringField(choice, "title") ?? id,
        ...(stringField(choice, "description")
          ? { description: stringField(choice, "description") }
          : {}),
      });
      values[id] = choice.const;
    }
    if (type === "boolean" && options.length === 0) {
      options.push({ id: "yes", label: "Yes" }, { id: "no", label: "No" });
      values.yes = true;
      values.no = false;
    }

    const prompt =
      stringField(field, "title") ??
      stringField(field, "description") ??
      key;
    questions.push({
      id: key,
      prompt,
      ...(stringField(field, "title") &&
      stringField(field, "description")
        ? { header: stringField(field, "title") }
        : {}),
      multiSelect: multi,
      allowCustom: options.length === 0,
      options,
    });
    fields.push({ key, multi, values });
  }
  if (questions.length === 0) return null;
  const title = stringField(inner ?? {}, "message");
  return { ...(title ? { title } : {}), questions, fields };
}

/** MCP elicitation result: `accept` carries schema values, anything else cancels. */
export function devinElicitationResult(
  reply: UserQuestionReply,
  questions: UserQuestion[],
  fields: DevinElicitField[],
): Record<string, unknown> {
  if (reply.kind !== "answered") return { action: "cancel" };
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const question = questions.find((item) => item.id === field.key);
    if (!question) continue;
    const custom = reply.custom?.[field.key]?.trim();
    const selected = reply.answers[field.key] ?? [];
    if (selected.length === 0 && custom && question.allowCustom) {
      content[field.key] = custom;
      continue;
    }
    const values = selected.flatMap((id) => {
      if (id in field.values) return [field.values[id]];
      if (custom) return [custom];
      return [];
    });
    if (values.length === 0) continue;
    content[field.key] = field.multi ? values : values[0];
  }
  if (Object.keys(content).length === 0) return { action: "cancel" };
  return { action: "accept", content };
}

export function sessionIdFromResult(result: unknown): string | undefined {
  const rec = asRecord(result);
  const id = rec?.sessionId ?? rec?.session_id ?? rec?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export function devinAuthError(error: unknown, verb = "start"): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (isDevinAuthMessage(detail)) {
    return new Error(`${detail.trim()}\n\n${AUTH_HELP}`);
  }
  if (/timed out/i.test(detail)) {
    return new Error(`Devin did not answer initialize. ${AUTH_HELP}`);
  }
  return new Error(`Devin did not ${verb}. ${detail}`);
}

function usageFromUpdate(update: Record<string, unknown>): HarnessEvent | null {
  const usage =
    asRecord(update.usage) ??
    asRecord(update.tokenUsage) ??
    asRecord(update.token_usage) ??
    (hasUsageFields(update) ? update : null);
  if (!usage) return null;
  const used =
    numberField(usage, "used") ??
    numberField(usage, "usedTokens") ??
    numberField(usage, "used_tokens") ??
    numberField(usage, "totalTokens") ??
    numberField(usage, "total_tokens") ??
    sumNumbers(usage, [
      "inputTokens",
      "outputTokens",
      "input_tokens",
      "output_tokens",
    ]);
  const window =
    numberField(usage, "size") ??
    numberField(usage, "window") ??
    numberField(usage, "contextWindow") ??
    numberField(usage, "context_window") ??
    numberField(usage, "maxTokens") ??
    numberField(usage, "max_tokens");
  if (used == null && window == null) return null;
  return {
    type: "context",
    used: used ?? undefined,
    window: window ?? undefined,
  };
}

function hasUsageFields(rec: Record<string, unknown>): boolean {
  return (
    numberField(rec, "used") != null ||
    numberField(rec, "usedTokens") != null ||
    numberField(rec, "inputTokens") != null ||
    numberField(rec, "totalTokens") != null
  );
}

function planEvent(update: Record<string, unknown>): HarnessEvent | null {
  const entries = update.entries ?? update.plan;
  if (Array.isArray(entries)) {
    const items = entries.flatMap((item) => {
      const rec = asRecord(item);
      if (!rec) return [];
      const content = String(rec.content ?? rec.text ?? rec.title ?? "").trim();
      if (!content) return [];
      return [
        {
          text: content,
          status: normalizeTaskListStatus(rec.status),
        },
      ];
    });
    return { type: "tasks.updated", items };
  }
  if (typeof update.text === "string" && update.text.trim()) {
    return { type: "plan", text: update.text };
  }
  return null;
}

function toolLabel(rec: Record<string, unknown>): string | undefined {
  return (
    humanField(rec, "title") ??
    humanField(rec, "name") ??
    humanField(rec, "toolName") ??
    humanField(rec, "tool_name")
  );
}

function toolDetail(
  update: Record<string, unknown>,
  tool: Record<string, unknown>,
): string | undefined {
  const content =
    textFromContent(update.content, "\n") ||
    textFromContent(tool.content, "\n");
  if (content.trim()) return cap(content);
  const output = update.rawOutput ?? tool.rawOutput;
  if (typeof output === "string" && output.trim()) return cap(output);
  const outputText = textFromContent(output);
  return outputText.trim() ? cap(outputText) : undefined;
}

function cap(value: string, max = 8_000): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

function pickOption(optionIds: string[], preferred: string[]): string | null {
  for (const id of preferred) {
    if (optionIds.includes(id)) return id;
  }
  return null;
}

function humanField(
  rec: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringField(rec, key);
  if (!value || looksLikeCallId(value)) return undefined;
  return value;
}

function looksLikeCallId(value: string): boolean {
  const text = value.trim();
  return (
    /^(call[-_]?|tool[-_])[a-z0-9_-]+$/i.test(text) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      text,
    )
  );
}

function textFromContent(content: unknown, separator = ""): string {
  if (typeof content === "string") return content;
  const rec = asRecord(content);
  if (rec && typeof rec.text === "string") return rec.text;
  if (rec && rec.content != null) return textFromContent(rec.content, separator);
  if (Array.isArray(content)) {
    return content
      .map((item) => textFromContent(item, separator))
      .filter(Boolean)
      .join(separator);
  }
  return "";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function stringField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(
  rec: Record<string, unknown>,
  keys: string[],
): number | undefined {
  let total = 0;
  let found = false;
  for (const key of keys) {
    const value = numberField(rec, key);
    if (value == null) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}
