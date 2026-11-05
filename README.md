# irisu-syndrome-web

A pixel-perfect browser port of **Irisu Syndrome** (v2.03), both Normal and
Metsu (滅) modes, built on a hybrid architecture:

- **Normal mode** runs on the pinned exact v2.03 runtime (v86, bit-exact).
- **Metsu mode + all new ported scenes** run on the C++/WASM clone engine
  (reverse-engineered rules already implemented and parity-tested).

This repo is the **full port** — scene-by-scene, asset-faithful,
replay-validated. It is separate from `reversemas/irisu-ml` (which ships the
working hybrid build); this repo is where the complete 1:1 port takes shape.

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Asset extraction (`.dxa` archives → loose art/SFX/scripts) | **Next** — reverse `DxLib.dll`'s archive cipher |
| 1 | Gameplay scenes, both modes, pixel-perfect | Foundation in place (clone engine + Metsu rules); rendering layers pending asset extraction |
| 2 | Front-end shell (title, menu, options, high-score, mode select) | Pending |
| 3 | Cutscenes & narrative (intro, transitions, endings, Irisu beats) | Pending |
| 4 | Secret / "syndrome" content & unlock conditions | Pending |
| 5 | Fidelity polish (blend modes, particles, glitch effects, audio timing) | Pending |

See [`docs/PORT_PLAN.md`](docs/PORT_PLAN.md) for the concrete plan.

## What's in this repo

- `clone/` — the C++ clone engine (Metsu rules reversed & parity-tested, normal-mode rules, simulator, physics, config).
- `apps/web/` — the web frontend (Emscripten WASM build, the mode-switch UI, replay loader, vertical life gauge).
- `third_party/box2d_legacy/` — the Box2D r58 source matching the original's physics.
- `reference/game/` — the staged original game folder (`irisu.exe`, `DxLib.dll`, `Box2D.dll`, `.dxa` archives, `irisu.ini`, BGM, story `.txt` files, `photo.png`).
- `reference/replays/` — 18 real `metsu_*.rpy` + `irisu_*.rpy` replays captured from the original (score-parity targets, up to 188561).
- `reference/` (existing tooling) — `trace-proxy/`, `native-box2d/`, `rng-oracle/`, `probe/` — the native-DLL probing infrastructure used to reverse the rules; the same tooling is how we'll crack `.dxa`.
- `tools/dxa_extract.py` — the `.dxa` archive extractor (schemes attempted; awaiting the exact DxLib cipher from `DxLib.dll` reverse).
- `docs/` — mechanics, metsu rules, physics source, fidelity notes, and the port plan.

## Architecture decision

**Hybrid** — normal mode stays on the pinned exact v86 runtime (bit-exact parity
proven via seed-41 score regression); the clone engine handles Metsu and every
newly-ported scene. This keeps the proven bit-exact normal mode intact while the
port grows around it.

## Fidelity bar

**Pixel-perfect.** Every ported scene is validated two ways:
1. **Rule parity** — replaying a `metsu_*.rpy` / `irisu_*.rpy` produces the exact
   final score the replay header records (18 metsu + N normal replays staged as
   targets).
2. **Visual parity** — side-by-side against reference screenshots from the
   original at matching frames.

## Legal posture

`reference/game/` contains the original Irisu Syndrome v2.03 game files, staged
for extraction and reverse-engineering. This port is for personal use by the game
owner. If you fork this repo publicly, you assume responsibility for the
copyright posture of any committed original assets — consider `.gitignore`-ing
`reference/game/` and staging it out-of-band.
