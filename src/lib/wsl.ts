import { invoke } from "@tauri-apps/api/core";
import { wslLocation, wslPath } from "./paths";

/** Cancellation abandons this read-only open; it never retargets a session. */
export async function connectWslProject(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const location = wslLocation(path);
  if (!location)
    throw new Error("Choose a folder inside the selected WSL distribution");
  const connected = await invoke<{ distribution: string; path: string }>(
    "wsl_connect",
    location,
  );
  signal?.throwIfAborted();
  if (
    connected.distribution.toLowerCase() !== location.distribution.toLowerCase()
  )
    throw new Error(
      "WSL returned a different distribution; the project was not opened",
    );
  return wslPath(connected.distribution, connected.path);
}
