import type { AgentModel } from "../models";
import {
  acpAuthError,
  acpAutoOption,
  acpCommandsFromUpdate,
  acpConfigOptions,
  acpCurrentModelId,
  acpElicitation,
  acpElicitationResult,
  acpEventsFromUpdate,
  acpModeId,
  acpModeIdsFromConfig,
  acpModesFromSetup,
  acpModelConfigId,
  acpPermissionOptionId,
  acpPermissionRequest,
  acpPromptBlocks,
  acpStopReasonMessage,
  asRecord,
  sessionIdFromResult,
  stringField,
  type AcpConfigOption,
  type AcpElicitField,
} from "./acp";

export { asRecord, sessionIdFromResult, stringField };

export type DevinConfigOption = AcpConfigOption;
export type DevinElicitField = AcpElicitField;

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

const MAX_CATALOG_ITEMS = 200;

/** Devin advertises image and embedded-context prompt blocks. */
export const devinPromptBlocks = acpPromptBlocks;

export function devinSpawnArgs(): string[] {
  return ["acp"];
}

export const devinModeId = acpModeId;
export const devinModesFromSetup = acpModesFromSetup;
export const devinModeIdsFromConfig = acpModeIdsFromConfig;
export const devinConfigOptions = acpConfigOptions;
export const devinModelConfigId = acpModelConfigId;
export const devinCurrentModelId = acpCurrentModelId;
export const devinEventsFromUpdate = acpEventsFromUpdate;
export const devinPermissionRequest = acpPermissionRequest;
export const devinAutoOption = acpAutoOption;
export const devinPermissionOptionId = acpPermissionOptionId;
export const devinElicitation = acpElicitation;
export const devinElicitationResult = acpElicitationResult;

export function devinCommandsFromUpdate(params: unknown) {
  return acpCommandsFromUpdate("devin", params);
}

export function devinAuthError(error: unknown, verb = "start"): Error {
  return acpAuthError("Devin", AUTH_HELP, error, verb);
}

export function devinStopReasonMessage(stopReason: string): string | undefined {
  return acpStopReasonMessage("Devin", stopReason);
}

/** Dynamic catalog from the session's `model` config option. */
export function devinModelsFromConfig(
  options: DevinConfigOption[],
): AgentModel[] {
  const model =
    options.find((option) => option.id === "model") ??
    options.find((option) => option.category === "model");
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const choice of (model?.options ?? []).slice(0, MAX_CATALOG_ITEMS)) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    models.push({
      id: `devin:${choice.value}`,
      harness: "devin",
      name: choice.name || choice.value,
      nativeId: choice.value,
      ...(choice.contextWindow ? { contextWindow: choice.contextWindow } : {}),
    });
  }
  return models;
}

/**
 * `devin models list --format json` → `{families: [{slug, variants: [
 * {model_uid, label, max_context_tokens}]}]}`. Family slugs are selectable
 * aliases; variants are the concrete ids `session/set_config_option` accepts.
 */
function devinModelsFromJson(raw: unknown): AgentModel[] {
  const rec = asRecord(raw);
  const families = Array.isArray(rec?.families) ? rec.families : [];
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  const push = (nativeId: string, name: string, contextWindow?: number) => {
    if (!nativeId || seen.has(nativeId) || models.length >= MAX_CATALOG_ITEMS)
      return;
    seen.add(nativeId);
    models.push({
      id: `devin:${nativeId}`,
      harness: "devin",
      name: name || nativeId,
      nativeId,
      ...(contextWindow ? { contextWindow } : {}),
    });
  };
  for (const item of families) {
    const family = asRecord(item);
    if (!family) continue;
    const slug = stringField(family, "slug") ?? stringField(family, "family_uid");
    const label =
      stringField(family, "family_label") ??
      stringField(family, "label") ??
      slug ??
      "";
    if (slug) push(slug, label);
    const variants = Array.isArray(family.variants) ? family.variants : [];
    for (const entry of variants) {
      const variant = asRecord(entry);
      const uid = stringField(variant ?? {}, "model_uid");
      if (!uid) continue;
      push(
        uid,
        stringField(variant ?? {}, "label") ?? uid,
        numberField(variant, "max_context_tokens") ??
          numberField(variant, "context_window"),
      );
    }
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

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
