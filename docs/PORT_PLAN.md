# Irisu Syndrome — Full Port Plan

Pixel-perfect browser port of Irisu Syndrome v2.03 (Normal + Metsu), hybrid
architecture, replay-validated. This plan is informed by a complete inventory of
the staged game folder (`reference/game/`).

## Inventory summary

The original game ships as:

| Path | Size | Contents |
|---|---|---|
| `irisu.exe` | 289 KB | The v2.03 game binary (DMD D1 PE32) — already reversed for rules. |
| `data/img.dxa` | 12.4 MB | **All art** (sprites, backgrounds, textures, the Irisu character, effects) — DxLib archive, encrypted. |
| `data/snd.dxa` | 1.8 MB | **All sound effects** — DxLib archive, encrypted. |
| `data/dat.dxa` | 51 KB | **Scripts/data** — DxLib archive, encrypted. |
| `data/bgm/*.mp3` | ~17 MB | 17 BGM tracks (loose, already deployed in the web frontend). |
| `data/dll/DxLib.dll` | 1.8 MB | The DxLib runtime — **the key to cracking `.dxa`**. |
| `data/dll/Box2D.dll` | 180 KB | The Box2D r58 physics binary (already probed via `reference/native-box2d/`). |
| `data/doc/irisu.ini` | 3 KB | The game config (field 94/20/420/370, Metsu table — matches what we reversed). |
| `data/doc/irisu.dat` | 785 KB | A BMP image (435×600, 24-bit) — likely a title/background image. Trivial to decode. |
| `photo.png` | 244 KB | The photo asset (secret/cursed content). |
| `*.txt` (9 files) | ~31 KB | The narrative/story files: "Ageha", "Suicidal Rabbit Diary" (16 KB), "Lately I've Been Taking Cough Medicine Without Restraint" (6.6 KB), etc. — the secret content text. |
| `replay/*.rpy` | — | 18 metsu + ~20 normal replays (parity targets, up to score 188561). |

## Phase 0 — Asset extraction (the gate)

**Goal:** produce `reference/extracted/` with every art/SFX/script asset as a
loose file plus a manifest mapping internal filenames to types.

**The `.dxa` cipher:** All three archives share the same 4-byte header
(`c8 de e0 19`) — the DxLib archive key. Nine decryption schemes were attempted
(`tools/dxa_extract.py`): simple 4-byte XOR, position-mixed XOR, MSVC-rand LCG
(table-cycled and per-byte), glibc LCG, full-block LCG. None produced readable
output. The encryption is non-trivial.

**The robust path:** reverse `DxLib.dll`'s archive functions directly. The DLL
is staged at `reference/game/data/dll/DxLib.dll`. The functions of interest
(from DxLib's public source layout):
- `DA_Open` / `DA_Close` — archive open/close
- `ArchiveDataDecode` / `ArchiveDataEncode` — the cipher
- `DA_SetKeyName` — key derivation

Approach: disassemble `DxLib.dll`, locate `ArchiveDataDecode`, extract the exact
key schedule + XOR loop, port it to `tools/dxa_extract.py`. This mirrors how
`reference/native-box2d/` already wraps and probes `Box2D.dll` for physics
parity.

Alternative (runtime): extend `reference/trace-proxy/` to intercept DxLib's
file-read calls under Wine, capturing each asset's decrypted bytes as the game
loads it. Slower but guaranteed-correct.

**Deliverable:** `tools/dxa_extract.py` fully working; `reference/extracted/`
populated; `reference/extracted/MANIFEST.md` listing every asset.

## Phase 1 — Gameplay scenes (pixel-perfect)

**Goal:** both modes fully playable with pixel-perfect visuals, validated
against the 18 metsu + N normal replays.

The clone engine already has the rule layer (Metsu level table, spawn cadence,
contact rules, scoring, life — all reversed and parity-tested). What's missing
is the **rendering layer**:

1. **Reverse `ScenePlay::Draw`** in `irisu.exe` — map every `DrawGraph`,
   `DrawBlendGraph`, `DrawFormatString` call to its asset + trigger condition +
   screen position. The exe is small (289 KB) and already disassembled.
2. **Port the rendering** onto the clone's snapshot loop:
   - Block sprites per shape × color (from `img.dxa` once extracted)
   - The field background, walls, top/bottom gates
   - The bubble glow/pop effects (Metsu)
   - Particle effects (burst, chain)
   - Score popups (rise + fade)
   - HUD: exact score position (left in Metsu, center in normal — the
     score-position fix is already shipped to `irisu-ml`), level indicator,
     vertical life gauge (Metsu), horizontal bottom gauge (normal)
3. **Wire SFX** (from `snd.dxa` once extracted) at the exact frame the original
   fires each `PlaySound` — reversed from the exe's audio call sites.
4. **Replay parity sweep** — run all 18 metsu replays + normal replays through
   the clone, compare final scores to the replay headers. 100% match = rule
   fidelity proven. (The biggest metsu replay scores 188561 over a long run —
   the stress test.)
5. **Visual parity sweep** — side-by-side frames against reference screenshots.

**Deliverable:** playable gameplay (both modes), pixel-perfect, replay-validated.

## Phase 2 — Front-end shell

Title screen, main menu, options, high-score entry, mode select. Ported
scene-by-scene from the exe's `SceneTitle` / `SceneMenu` / `SceneOption` /
`SceneResult` (the scene dispatcher was already identified during the Metsu
reverse — `ScenePlay` is one of several scenes sharing the singleton at
`0x4428d0`).

## Phase 3 — Cutscenes & narrative

The intro animation, scene transitions, the Irisu character beats, the ending
sequences. The 9 story `.txt` files (staged in `reference/game/`) wire in at
their correct trigger points, reversed from the exe's text-display call sites.

## Phase 4 — Secret / "syndrome" content

The hidden material, its unlock conditions, the cursed sequences, `photo.png`,
the special endings. Reversed from the exe's secret-scene branches (the scene
dispatcher at `0x4428d0` has branches beyond the normal/metsu split).

## Phase 5 — Fidelity polish

- Match DxLib blend modes exactly (additive, multiplicative, alpha blends).
- Particle and glitch/distortion effects.
- Audio timing precision (the SFX chain frequency `17050+5000*chain` was already
  reversed for Metsu).
- Final full replay-parity + visual-parity sweep across all scenes.

## Validation discipline

Every phase ships only when:
1. All staged replays still produce score-parity (no regressions).
2. Reference-screenshot comparison passes for the newly-ported scenes.
3. The existing native + web test suites stay green.
