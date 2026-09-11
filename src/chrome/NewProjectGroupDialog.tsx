import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../lib/layers";

type Props = {
  onCancel: () => void;
  onCreate: (name: string) => void;
};

/**
 * Names a pathless project group — a grouping that owns repositories and
 * tasks without anchoring to a folder.
 */
export function NewProjectGroupDialog({ onCancel, onCreate }: Props) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const submit = () => {
    const clean = name.trim();
    if (clean) onCreate(clean);
  };

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: LAYER.dialog }}>
      <div className="absolute inset-0 bg-black/30" onMouseDown={onCancel} />
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New project group"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="absolute left-1/2 top-[22%] flex w-[min(420px,calc(100vw-24px))] -translate-x-1/2 flex-col gap-3 rounded-lg border border-content/10 bg-content/5 p-4 shadow-xl backdrop-blur-xl"
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-[13px] font-medium leading-tight text-content">
            New project group
          </h2>
          <p className="text-[12px] leading-snug text-content/55">
            A group keeps repositories and tasks together without anchoring
            to a folder — add repositories after creating it.
          </p>
        </div>
        <input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Project name"
          aria-label="Project name"
          className="w-full rounded-md border border-content/10 bg-background-base/60 px-2 py-1.5 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-accent/60"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-md bg-accent/20 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
