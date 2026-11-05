# Playable web app

This asset-free browser client renders the real headless simulator at 50 Hz.
Its open-bottom U-shaped well follows the measured v2.03 mode-0 geometry.

- Left click or `W`: weak shot
- Right click or `S`: strong shot
- Shift + click: both shots
- Mouse wheel down or hold Space: fast-forward (wheel up or releasing Space stops)
- Enter: pause/resume
- In replay mode, Left/Right: jump backward/forward five seconds without changing play state
- Replay speed: 1x, 2x, 4x, or 8x
- `R`: restart with a new random seed
- **metsu mode** (header button): switch between normal and Metsu; the button
  starts a fresh run in the other mode. Metsu adds rising bubbles, chain pops,
  the vertical life gauge, and faster difficulty scaling; see `docs/metsu.md`.
- **play replay**: open an original v2.03 `.rpy` file (normal or Metsu; the
  app switches modes automatically to match the file)
- **save replay**: download the completed run from the game-over dialog

Touch taps fire weak shots; desktop players can right-click or press `S` for a
strong shot.

## Soundtrack

Put audio files (`.mp3` or `.m4a` work on every browser, including iPhone Safari) in
`apps/web/static/music/`. The build lists them in `music.json`; the page plays a random
track once gameplay starts, picks another random one (never the same twice in a row)
when it ends, pauses with the game, and starts a fresh random track on each new run.
Browsers need a tap before audio can start, so music begins on the first shot.

After the first load the page downloads the files into CacheStorage in the background and
the service worker serves them (with byte-range support, which Safari requires), so music
works offline. Without any files the game is simply silent.

## Offline

`make-precache.mjs` stamps the file list and a content hash into `sw.js` at build time. Each
deploy therefore installs a new service worker that downloads the whole new app into its own
cache in the background and takes over after the app is closed and reopened; older caches are
only deleted once the new one exists. Everything is served cache-first, so a weak or hanging
connection cannot block startup. The emulator runtime and the music are stored in their own
caches (by `exact-worker.js` and `music.mjs`) and the worker serves them from there. The page
shows "Ready for offline play" once everything is stored, and says so if the system later
clears it.

## Build the static exact app

Build the existing 32-bit exact worker and provide its MSVC9 r58 host, then run:

```bash
IRISU_EXACT_WORKER=/path/to/irisu-exact-worker \
IRISU_EXACT_HOST=/path/to/libirisu_box2d_msvc_exact_multiworld.so \
  apps/web/build-static.sh
```

Runtime preparation performs a linker-only restage of that build's pinned
worker object and `libirisu_core.a` against the guest toolchain. If those files
do not share the worker's standard CMake build directory, set
`IRISU_EXACT_WORKER_OBJECT` and `IRISU_EXACT_CORE_ARCHIVE` explicitly.

This writes the GitHub Pages artifact to `apps/web/dist`. The static site boots
the exact i386 worker under v86 inside a Web Worker and requires no application
server or cross-origin isolation. Dependencies are pinned and cached in
`build-web/downloads`; generated guest binaries remain outside source control.
The client overlaps emulator and guest-engine downloads, uses v86 fast boot,
reuses parity-verified loader and C runtime libraries already in the guest
image, and shows
the current startup phase until the first exact state is available.
The workspace's standard exact-worker paths are used when the two environment
variables are omitted. The build reproducibly compiles the pinned v86
CORE-MATH patch; `IRISU_V86_WASM` may point at a prebuilt artifact with the
required hash. It also builds the pinned project-owned Linux guest; a prebuilt
copy with the required hash may be supplied as `IRISU_GUEST_BZIMAGE`. See
`EXACT_RUNTIME.md` for provenance and licensing.

Serve the completed directory with any ordinary static file host for local
testing, for example:

```bash
python3 -m http.server 8000 --directory apps/web/dist
```

Open <http://127.0.0.1:8000>. Gameplay and physics remain entirely in the
browser; this process only serves immutable files.

Saved replays use the original v2.03 52-byte header and per-20 ms input-word
format. The exact actions accepted by the simulator are recorded, including
release and idle ticks, and terminal metadata comes from the first recorded
finish. Replay playback applies the original two-frame startup edge rule.
The transport can pause, jump five seconds, scrub without interrupting playback,
and play at 1x, 2x, 4x, or 8x; long backward seeks are rebuilt from
the seed and immutable input stream when their exact observations have left the
bounded in-memory cache.

GitHub Pages downloads the hash-pinned runtime from the
[`web-exact-runtime-virtio-v1-20260824`](https://github.com/Gabriel-Kahen/irisu-ml/releases/tag/web-exact-runtime-virtio-v1-20260824)
release with `fetch-exact-runtime.sh`, verifies both the archive and its embedded
runtime manifest, and passes the prepared directory through
`IRISU_EXACT_RUNTIME_DIR`.
