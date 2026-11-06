// Native soundtrack: plays a random track from ./music.json (generated at build
// time from static/music/), picks another random one when a track ends, and
// downloads the files into CacheStorage in the background for offline play.
export const MUSIC_CACHE_PREFIX = "irisu-music-";
export const MUTE_KEY = "irisu:muted";

export function pickNext(tracks, previous, random = Math.random) {
  if (!tracks.length) return null;
  const choices = tracks.length > 1 ? tracks.filter(track => track !== previous) : tracks;
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}

async function defaultLoadTracks(window) {
  const response = await window.fetch("./music.json", {cache: "no-cache"});
  if (!response.ok) return {version: "none", tracks: []};
  const data = await response.json();
  return {version: String(data.version || "none"), tracks: Array.isArray(data.tracks) ? data.tracks : []};
}

// Best-effort background download so tracks keep working offline. The service
// worker serves them from CacheStorage (cache-first) once they are stored.
export async function cacheTracks(window, version, tracks) {
  if (!window.caches || !/^https?:$/.test(window.location.protocol)) return;
  const name = MUSIC_CACHE_PREFIX + version;
  const cache = await window.caches.open(name);
  for (const stale of await window.caches.keys()) {
    if (stale.startsWith(MUSIC_CACHE_PREFIX) && stale !== name) await window.caches.delete(stale);
  }
  for (const track of tracks) {
    try {
      if (await cache.match(track)) continue;
      const response = await window.fetch(track);
      if (response.ok && response.status === 200) await cache.put(track, response);
    } catch (_) {
      return; // offline or storage full; try again next launch
    }
    // Yield between files so downloads never compete with gameplay.
    if (window.setTimeout) await new Promise(resolve => window.setTimeout(resolve, 750));
  }
}

export function createSoundtrack(document, window, {
  random = Math.random,
  createAudio = () => new window.Audio(),
  loadTracks = () => defaultLoadTracks(window),
  cache = cacheTracks,
  delayCache = 8000,
} = {}) {
  const audio = createAudio();
  audio.preload = "auto";
  let tracks = [];
  let snapshot = null;
  let currentTrack = null;
  let startRequested = false;
  let wantPlay = false;
  let consecutiveErrors = 0;
  let muted = false;
  // A one-shot takeover track (result-music jingle). While it plays the
  // random soundtrack stays paused; a persisting jingle keeps the stage
  // silent after it ends, a passing one hands control back when it ends.
  let exclusive = null;
  try { muted = window.localStorage?.getItem(MUTE_KEY) === "1"; } catch (_) { /* storage unavailable */ }

  function load(track) {
    currentTrack = track;
    audio.src = track;
  }

  function play() {
    const result = audio.play();
    if (result && typeof result.catch === "function") result.catch(() => {});
  }

  function apply() {
    if (exclusive) return;  // the jingle owns the audio stage
    if (!tracks.length) return;
    if (!wantPlay || muted) {
      if (!audio.paused) audio.pause();
      return;
    }
    if (!startRequested) return; // browsers need a gesture before audio can start
    if (!currentTrack) load(pickNext(tracks, null, random));
    if (audio.paused) play();
  }

  function playNext() {
    if (!tracks.length) return;
    load(pickNext(tracks, currentTrack, random));
    if (wantPlay && !muted && startRequested) play();
  }

  audio.addEventListener("ended", () => { consecutiveErrors = 0; playNext(); });
  audio.addEventListener("playing", () => { consecutiveErrors = 0; });
  audio.addEventListener("error", () => {
    // Skip an unreadable file, but stop once every track has failed in a row.
    if (++consecutiveErrors <= tracks.length) playNext();
  });

  function start() {
    startRequested = true;
    apply();
  }

  function setMuted(value) {
    muted = Boolean(value);
    try { window.localStorage?.setItem(MUTE_KEY, muted ? "1" : "0"); } catch (_) { /* storage unavailable */ }
    if (!muted) startRequested = true; // unmuting is itself a user gesture
    if (exclusive) exclusive.element.muted = muted;
    apply();
    return muted;
  }

  function stopExclusive() {
    if (!exclusive) return;
    const element = exclusive.element;
    exclusive = null;
    try { element.pause(); } catch (_) { /* already gone */ }
  }

  // Swap the soundtrack for a single named track (lose fanfare, milestone
  // jingle). `persist` keeps the result screen silent after it finishes;
  // otherwise the random soundtrack resumes where it left off.
  function playExclusive(src, {persist = false} = {}) {
    const element = createAudio();
    element.preload = "auto";
    if (!audio.paused) audio.pause();
    stopExclusive();
    exclusive = {element, persist: Boolean(persist)};
    element.muted = muted;
    element.src = src;
    element.addEventListener("ended", () => {
      if (!exclusive || exclusive.element !== element) return;
      const resume = !exclusive.persist;
      exclusive = null;
      if (resume) apply();
    });
    const result = element.play();
    if (result && typeof result.catch === "function") result.catch(() => {});
  }

  function update(next = snapshot) {
    const newRun = Boolean(next && snapshot &&
      (next.seed !== snapshot.seed || next.mode !== snapshot.mode));
    snapshot = next;
    wantPlay = Boolean(next?.running && !next.observation?.terminated);
    if (newRun && tracks.length) {
      stopExclusive();
      audio.pause();
      load(pickNext(tracks, currentTrack, random));
    }
    apply();
  }

  const ready = Promise.resolve().then(loadTracks).then(async ({version, tracks: list}) => {
    tracks = list;
    apply();
    if (delayCache) await new Promise(resolve => window.setTimeout(resolve, delayCache));
    return cache(window, version, list);
  }).catch(() => {});

  return {update, start, ready, audio, setMuted, toggleMute: () => setMuted(!muted), isMuted: () => muted,
    trackCount: () => tracks.length, playExclusive, stopExclusive};
}
