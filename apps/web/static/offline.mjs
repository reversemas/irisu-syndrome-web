// Reports whether everything needed to run with no network is stored on the device:
// the app shell (service worker cache), the emulator runtime and every music track.
export const RUNTIME_MIN_FILES = 7;

export async function offlineStatus(window, trackCount) {
  if (!window.caches) return {supported: false, ready: false, shell: 0, runtime: 0, music: 0};
  const names = await window.caches.keys();
  const largest = async (prefix) => {
    let best = 0;
    for (const name of names.filter(n => n.startsWith(prefix))) {
      best = Math.max(best, (await (await window.caches.open(name)).keys()).length);
    }
    return best;
  };
  const shell = await largest("irisu-shell-");
  const runtime = await largest("irisu-exact-runtime-");
  const music = await largest("irisu-music-");
  return {
    supported: true, shell, runtime, music,
    ready: shell > 0 && runtime >= RUNTIME_MIN_FILES && music >= trackCount,
  };
}
