import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  Languages,
  Loader,
  Mic,
  MicOff,
  Square,
  Trash2,
  X,
} from "./icons";
import { Popover } from "./Popover";
import {
  DICTATION_LANGUAGES,
  downloadPercent,
  formatElapsed,
  formatModelSize,
  resolveDictationModel,
  type DictationModelInfo,
  type DictationModelProgress,
} from "../lib/dictation";
import type { Dictation } from "./useDictation";

const TOOL_BUTTON =
  "grid size-6.5 shrink-0 place-items-center rounded-md bg-content/10 text-content/50 hover:bg-content/15 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content/50";

const SECTION_LABEL =
  "px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-content/40";

function ModelRow({
  model,
  selected,
  progress,
  dictation,
}: {
  model: DictationModelInfo;
  selected: boolean;
  progress: DictationModelProgress | undefined;
  dictation: Dictation;
}) {
  const downloading =
    model.downloading ||
    progress?.phase === "downloading" ||
    progress?.phase === "verifying";
  const status = model.installed
    ? "installed"
    : progress?.phase === "failed"
      ? "download failed"
      : model.partialBytes > 0
        ? `${formatModelSize(model.partialBytes)} kept`
        : null;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={() => dictation.selectModel(model.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/10"
      >
        <span className="grid size-3.5 shrink-0 place-items-center">
          {selected ? <Check className="size-3 text-accent" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4.5">
            {model.label}
          </span>
          <span className="block truncate text-[11px] leading-4 text-content/45">
            {model.tier} · {formatModelSize(model.sizeBytes)}
            {status ? ` · ${status}` : ""}
          </span>
        </span>
      </button>
      {downloading ? (
        <>
          <span className="shrink-0 text-[11px] tabular-nums text-content/55">
            {progress?.phase === "verifying"
              ? "Verifying"
              : progress
                ? `${downloadPercent(progress)}%`
                : "…"}
          </span>
          <button
            type="button"
            title="Cancel download"
            aria-label={`Cancel ${model.label} download`}
            onClick={() => dictation.cancelDownload(model.id)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <X className="size-3" />
          </button>
        </>
      ) : model.installed ? (
        <button
          type="button"
          title={`Remove ${model.label}`}
          aria-label={`Remove ${model.label}`}
          onClick={() => dictation.removeModel(model.id)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : (
        <button
          type="button"
          title={
            model.partialBytes > 0
              ? `Resume download — ${formatModelSize(model.partialBytes)} of ${formatModelSize(model.sizeBytes)} on disk`
              : `Download ${model.label} (${formatModelSize(model.sizeBytes)})`
          }
          aria-label={
            model.partialBytes > 0
              ? `Resume ${model.label} download`
              : `Download ${model.label}`
          }
          onClick={() => dictation.installModel(model.id)}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-content/60 hover:bg-content/10 hover:text-content"
        >
          <Download className="size-3.5" />
          {model.partialBytes > 0 || progress?.phase === "failed"
            ? "Resume"
            : null}
        </button>
      )}
    </div>
  );
}

/** ⌘⇧D / Ctrl+Shift+D — press toggles in "toggle" mode, hold dictates in
 * "hold" mode. Uses `code` so the shortcut is layout-independent. */
const DICTATION_HOTKEY_CODE = "KeyD";

function inBlockingUi(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".monocode-terminal")) return true;
  return Boolean(
    target.closest(
      "[data-file-picker], [data-branch-picker], [data-skill-picker], [data-mention-picker], [data-access-picker], [data-model-picker], [data-dictation-menu]",
    ),
  );
}

/** Ticks the chip's elapsed label between partial events — kept here so the
 * 500 ms cadence re-renders only the control, not the whole composer. */
function useElapsedMs(phase: string, audioMs: number, startedAt: number) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (phase !== "starting" && phase !== "recording") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [phase]);
  if (audioMs > 0) return audioMs;
  return phase === "starting" || phase === "recording"
    ? Math.max(0, now - startedAt)
    : 0;
}

/**
 * The composer's dictation affordance: a mic button that toggles or holds
 * recording, a status chip while a session runs, and a popover for
 * model/language/translate/mode settings. Session state lives in
 * `useDictation`; this is presentation.
 */
export function DictationControl({
  dictation,
  enabled,
  hotkeys = false,
}: {
  dictation: Dictation;
  enabled: boolean;
  hotkeys?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const hold = dictation.prefs.mode === "hold";
  const elapsedMs = useElapsedMs(
    dictation.phase,
    dictation.audioMs,
    dictation.startedAt,
  );
  const selected = dictation.catalog
    ? resolveDictationModel(dictation.catalog, dictation.prefs.modelId)
    : null;
  const translateDisabled =
    selected != null && !selected.supportsTranslate;

  // ⌘⇧D dictates — toggle mode presses start/stop; hold mode runs while the
  // chord is held. Window-level so it works wherever focus sits in the pane.
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  useEffect(() => {
    if (!hotkeys) return;
    const isHotkey = (event: KeyboardEvent) =>
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.code === DICTATION_HOTKEY_CODE;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !isHotkey(event) || event.repeat) return;
      const current = dictationRef.current;
      if (current.phase === "idle" && inBlockingUi(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (hold) current.press();
      else current.toggle();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!hold || event.code !== DICTATION_HOTKEY_CODE) return;
      dictationRef.current.release();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [hotkeys, hold]);

  const micTitle = hold
    ? "Hold to dictate (⌘⇧D)"
    : "Dictate (⌘⇧D)";

  return (
    <div ref={anchor} className="flex shrink-0 items-center gap-1">
      {dictation.phase === "idle" ? (
        <button
          type="button"
          title={micTitle}
          aria-label={micTitle}
          disabled={!enabled}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={
            hold
              ? (event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dictation.press();
                }
              : undefined
          }
          onPointerUp={hold ? () => dictation.release() : undefined}
          onPointerCancel={hold ? () => dictation.release() : undefined}
          onClick={hold ? undefined : dictation.toggle}
          className={TOOL_BUTTON}
        >
          <Mic className="size-3.5" strokeWidth={1.5} />
        </button>
      ) : (
        <div
          className="flex h-6.5 items-center gap-1 rounded-md bg-red-500/15 pl-1.5 pr-0.5 text-[11px] text-red-300"
          data-dictation-recording
        >
          {dictation.phase === "recording" ? (
            <>
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-red-400"
              />
              <span className="shrink-0 tabular-nums">
                {formatElapsed(elapsedMs)}
              </span>
              <button
                type="button"
                title="Stop dictation"
                aria-label="Stop dictation"
                onClick={dictation.stop}
                className="grid size-5.5 shrink-0 place-items-center rounded hover:bg-red-400/20"
              >
                <Square className="size-2.5 fill-current" strokeWidth={0} />
              </button>
            </>
          ) : (
            <>
              <Loader
                className="size-3 shrink-0 animate-spin"
                strokeWidth={2}
              />
              <span className="shrink-0">
                {dictation.phase === "finishing"
                  ? "Finishing…"
                  : "Starting…"}
              </span>
            </>
          )}
          {dictation.sessionActive ? (
            <button
              type="button"
              title="Cancel dictation"
              aria-label="Cancel dictation"
              onClick={dictation.cancel}
              className="grid size-5.5 shrink-0 place-items-center rounded hover:bg-red-400/20"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      )}
      <button
        type="button"
        title="Dictation settings"
        aria-label="Dictation settings"
        aria-haspopup="menu"
        aria-expanded={dictation.menuOpen}
        disabled={!enabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => dictation.setMenuOpen(!dictation.menuOpen)}
        className={TOOL_BUTTON}
      >
        <ChevronDown
          className={`size-3 ${dictation.menuOpen ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {dictation.menuOpen ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          width={264}
          onDismiss={() => dictation.setMenuOpen(false)}
          role="menu"
          aria-label="Dictation"
          data-dictation-menu
          className="p-1.5"
        >
          {dictation.micPermission === "denied" ||
          dictation.micPermission === "restricted" ? (
            <div className="mx-0.5 mb-1 flex items-center gap-2 rounded-lg bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
              <MicOff className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">Microphone access is off</span>
              <button
                type="button"
                onClick={dictation.openMicSettings}
                className="shrink-0 underline hover:text-red-200"
              >
                Open Settings
              </button>
            </div>
          ) : null}
          <p className={SECTION_LABEL}>Voice model</p>
          {dictation.catalog === null ? (
            <p className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-content/45">
              <span className="min-w-0 flex-1">
                {dictation.catalogFailed
                  ? "Couldn't load the model list"
                  : "Loading models…"}
              </span>
              {dictation.catalogFailed ? (
                <button
                  type="button"
                  onClick={dictation.refreshCatalog}
                  className="shrink-0 underline hover:text-content"
                >
                  Retry
                </button>
              ) : null}
            </p>
          ) : (
            dictation.catalog.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                selected={selected?.id === model.id}
                progress={dictation.progress[model.id]}
                dictation={dictation}
              />
            ))
          )}
          <p className={SECTION_LABEL}>Language</p>
          <div className="flex gap-1 px-0.5 pb-0.5">
            {DICTATION_LANGUAGES.map((language) => {
              const active = dictation.prefs.language === language.id;
              return (
                <button
                  key={language.id ?? "auto"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => dictation.selectLanguage(language.id)}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] ${
                    active
                      ? "bg-content/15 text-content"
                      : "text-content/55 hover:bg-content/10 hover:text-content"
                  }`}
                >
                  {language.label}
                </button>
              );
            })}
          </div>
          <p className={SECTION_LABEL}>Trigger · ⌘⇧D</p>
          <div className="flex gap-1 px-0.5 pb-0.5">
            {(
              [
                { id: "hold", label: "Hold to talk" },
                { id: "toggle", label: "Press to start" },
              ] as const
            ).map((mode) => {
              const active = dictation.prefs.mode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => dictation.setMode(mode.id)}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] ${
                    active
                      ? "bg-content/15 text-content"
                      : "text-content/55 hover:bg-content/10 hover:text-content"
                  }`}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          <div className="mt-1 border-t border-content/10 pt-1">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={dictation.prefs.translate}
              disabled={translateDisabled}
              title={
                translateDisabled
                  ? `${selected?.label ?? "This model"} cannot translate — pick a translate-capable model`
                  : "Translate speech to English"
              }
              onClick={() => dictation.setTranslate(!dictation.prefs.translate)}
              className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-content hover:bg-content/10 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Languages className="size-3.5 shrink-0 text-content/45" />
              <span className="min-w-0 flex-1">Translate to English</span>
              <span
                aria-hidden="true"
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  dictation.prefs.translate ? "bg-content/35" : "bg-content/15"
                }`}
              >
                <span
                  className={`absolute top-0.5 size-4 rounded-full bg-content shadow-sm transition-transform ${
                    dictation.prefs.translate
                      ? "translate-x-4.5"
                      : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
