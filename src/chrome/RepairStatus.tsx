import { useEffect, useState } from "react";
import {
  OPEN_REPAIR,
  REPAIR_CHANGE,
  repairRecords,
  updateRepair,
  type RepairRecord,
} from "../lib/repair";
export function RepairStatus({
  scope,
  cwd,
  session,
}: {
  scope?: string;
  cwd?: string;
  session?: string;
}) {
  const [version, setVersion] = useState(0);
  const [opened, setOpened] = useState("");
  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    window.addEventListener(REPAIR_CHANGE, refresh);
    return () => window.removeEventListener(REPAIR_CHANGE, refresh);
  }, []);
  void version;
  let rows: RepairRecord[];
  try {
    rows = repairRecords();
  } catch (error) {
    return <p role="alert">{String(error)}</p>;
  }
  const row = rows
    .filter(
      (row) =>
        row.state !== "released" &&
        (session
          ? row.session === session
          : row.scope === scope && row.cwd === cwd),
    )
    .slice(-1)[0];
  if (!row) return null;
  return (
    <div
      className="border-b border-content/10 px-2 py-1 text-[12px] text-content/65"
      role="status"
    >
      <span>
        Repair {row.id.slice(0, 8)} · {row.state} · {row.detail}
      </span>{" "}
      <button
        className="rounded px-1 underline hover:bg-content/10"
        onClick={() => {
          setOpened(row.id);
          window.dispatchEvent(
            new CustomEvent(OPEN_REPAIR, { detail: row.session }),
          );
        }}
      >
        Open repair conversation
      </button>
      {["completed", "uncertain", "blocked"].includes(row.state) &&
      opened === row.id ? (
        <button
          className="rounded px-1 underline hover:bg-content/10"
          onClick={() =>
            updateRepair(
              row.id,
              "released",
              "User inspected the conversation and explicitly allowed a new request.",
            )
          }
        >
          I checked this request; allow another repair
        </button>
      ) : null}
    </div>
  );
}
