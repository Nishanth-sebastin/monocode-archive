import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { pathKey, wslLocation } from "../lib/paths";
import { connectWslProject } from "../lib/wsl";
import { Popover } from "./Popover";

export function WslBadge({ cwd }: { cwd: string }) {
  const location = wslLocation(cwd);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open || !location) return;
    let cancelled = false;
    setConnected(null);
    setBusy(false);
    setError("");
    void invoke<boolean>("wsl_connected", {
      distribution: location.distribution,
    })
      .then((value) => {
        if (!cancelled) setConnected(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
      request.current?.abort();
    };
  }, [open, cwd]);
  if (!location) return null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-no-drag
        title={`WSL · ${location.distribution}`}
        aria-label={`WSL · ${location.distribution} environment`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="my-auto max-w-28 shrink-0 truncate rounded bg-content/5 px-1.5 py-0.5 text-[10px] text-content outline-none hover:bg-content/10 focus-visible:ring-1 focus-visible:ring-content/30"
      >
        WSL · {location.distribution}
      </button>
      {open && (
        <Popover
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          anchor={anchor}
          side="bottom"
          width={280}
          role="dialog"
          aria-label="WSL environment"
          className="space-y-2 p-3 text-[12px]"
          onDismiss={() => {
            setOpen(false);
            anchor.current?.focus();
          }}
        >
          <p className="font-medium text-content">
            WSL · {location.distribution}
          </p>
          <p className="break-all text-content/60">{location.path}</p>
          <p className="text-content/60">
            {connected == null
              ? "Checking connection…"
              : connected
                ? "Connected · Linux files, Git and agents"
                : "Disconnected"}
          </p>
          <p className="text-content/75">
            Browser links open on Windows. Localhost access depends on WSL
            networking; MonoCode does not forward ports. Open Linux editors from
            the terminal.
          </p>
          {error && (
            <p role="alert" className="break-words text-content/80">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            className="rounded-md bg-content/8 px-2 py-1 text-content/75 hover:bg-content/12 disabled:opacity-40"
            onClick={() => {
              const controller = new AbortController();
              request.current = controller;
              setBusy(true);
              setError("");
              void connectWslProject(cwd, controller.signal)
                .then((canonical) => {
                  if (pathKey(canonical) !== pathKey(cwd))
                    throw new Error(
                      "This folder resolves to a different path. Choose it again from Open project.",
                    );
                  setConnected(true);
                })
                .catch((reason) => {
                  if (!controller.signal.aborted) setError(String(reason));
                })
                .finally(() => {
                  if (!controller.signal.aborted) setBusy(false);
                });
            }}
          >
            {busy
              ? "Connecting…"
              : connected
                ? "Check connection"
                : "Reconnect"}
          </button>
        </Popover>
      )}
    </>
  );
}
