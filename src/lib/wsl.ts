import { invoke } from "@tauri-apps/api/core";
import { invalidateHarnessAvailability } from "./harness/availability";
import { invalidateModelCatalogs } from "./models";
import { wslLocation, wslPath } from "./paths";

const generations = new Map<string, number>();
export function invalidateWslDiscovery(path: string) {
  invalidateHarnessAvailability(path);
  invalidateModelCatalogs(path);
}

/** Cancellation abandons this read-only open; it never retargets a session. */
export async function connectWslProject(
  path: string,
  signal?: AbortSignal,
  refresh = false,
): Promise<string> {
  signal?.throwIfAborted();
  const location = wslLocation(path);
  if (!location)
    throw new Error("Choose a folder inside the selected WSL distribution");
  const connected = await invoke<{
    distribution: string;
    path: string;
    generation?: number;
  }>("wsl_connect", refresh ? { ...location, refresh: true } : location);
  signal?.throwIfAborted();
  if (
    connected.distribution.toLowerCase() !== location.distribution.toLowerCase()
  )
    throw new Error(
      "WSL returned a different distribution; the project was not opened",
    );
  const host = connected.distribution.toLowerCase();
  if (
    refresh ||
    connected.generation == null ||
    generations.get(host) !== connected.generation
  ) {
    invalidateWslDiscovery(path);
    if (generations.size >= 4)
      generations.delete(generations.keys().next().value!);
    if (connected.generation != null)
      generations.set(host, connected.generation);
  }
  return wslPath(connected.distribution, connected.path);
}
