# Phase 1 recon — DxLib rendering layer in `irisu.exe` (v2.03)

Static findings from capstone-based analysis (scripts in `/scripts/phase1_*.py`,
re-run top-to-bottom to reproduce). Complements [`binary-analysis.md`](binary-analysis.md).
Notation: all VAs, imagebase `0x400000`. Everything below is verified against the
local exe; semantics marked *(inferred)* still need dynamic confirmation.

## DxLib API surface (52 imports via `data\dll\DXLIB.DLL`, stdcall `_dx_` names)

Draw: `DrawRotaGraph`(36) `DrawModiGraph`(40) `DrawTriangle`(32) `DrawString`(20)
`DrawBox`(24) `DerivationGraph`(20). **No `DrawGraph`/`DrawFormatString`** — all
sprites go through Rota/Modi variants, all text is pre-formatted in D.
State: `SetDrawBlendMode`(8) `SetDrawBright`(12) `SetDrawMode`(4) `SetFontSize`(4)
`ChangeFontType`(4). Load: `LoadGraph`(8) `LoadSoundMem`(12) `GetGraphSize`(12).
Sound: `PlaySoundMem`(12, **31 call sites**) `SetFrequencySoundMem`(8)
`SetLoopPosSoundMem`(8) `StopSoundMem`(4) `DeleteSoundMem`(8)
`SetCreateSoundDataType`(4). Input/misc: `GetMousePoint/Input/WheelRotVol`,
`CheckHitKey`, `GetRand`(13 sites), `SRand`, `GetNowCount`, `ScreenFlip`,
`ClearDrawScreen`, `ProcessMessage`, `WaitTimer`, `SetDXArchiveKeyString("shine")`.

## Call convention: everything goes through D wrappers + thunks

`_TEXT` ends with a 153-entry import-thunk block (`jmp dword ptr [IAT]`,
`0x4315bc..0x431a00`). One D wrapper per API. Key wrappers:

| VA | Role |
|---|---|
| `0x410064` | thin `LoadGraph` (bumps load counter `0x44284c`) |
| `0x40fabc` | **image loader**: hash-map cache (`0x43b3f0`-backed) → concat `"data\img\" ~ name ~ ".png"` → LoadGraph; stores handle in map |
| `0x40fbb8` | image loader variant (frees old handle via `0x40ff78` first) *(inferred: replace/reload)* |
| `0x40fc34` / `0x40fd80` | sound loaders (`"data\snd\"` prefix pair at `0x435f28/2c`, alt prefix `0x435f40/44`) |
| `0x40ff60` | error/abort helper (D `Error` path, errcode `0x26` on map-store failure) |

Path fragment strings: `.png` = `0x435ef8`, `data\img\` = `0x435f10`, sound
prefixes at `0x435f28`/`0x435f40`. Delete counter at `0x442850`.
Debug line `graph load:%d delete:%d` (`0x436238`) confirms load/delete accounting.

## Resource manager singleton

`0x4428a0` = manager instance ptr. Virtual call pattern
`mov eax,[0x4428a0]; mov edx,[eax]; call [edx+0x1c]` = slot `+0x1c` = `load(name)`
*(inferred)*. The preload function at `0x40f100..0x40f259` calls it 17× with
D-string args from the literal table `0x435880..0x435a80`:
`kirehasi%d(_on)` `album0%d(_on)` `title_back(_ex)` `title_irisu(_ex)`
`title_logo(_ex/_on)` `menu_start_on` `menu_story_on` `menu_ranking_on`
`ranking_num(_ex/_ex_v)` `ranking_score(_ex_v)` `ranking_chain` `ptcl`.

## Asset name → code xref (61 direct hits)

`reference/phase1-asset-xref.json` maps extracted basenames → their D-literal VA
→ every instruction referencing it. Highlights (usage sites in `_TEXT`):

- Field walls `field_b/l/r/t`: loaded at `0x4052b8..0x40536c` *(Field::init)*
- Backdrops `back1(_ex/_ex2/_ex3)` `back2` `back3` `ex_back` `neko_01` `fball`:
  `0x404652..0x405878` *(title/scene backgrounds)*
- Play HUD/props `pointer` `frame` `irisu` `flick` `ev6_a1` `ev6_a2`:
  `0x408892..0x40953a` + `0x40b144` *(ScenePlay region)*
- Menu/extra `menu_*(_ex/_on)` `extra(_omote)(_on)` `ranking_*(_ex)`:
  `0x403751..0x40f246`
- `ptcl`/`ptcl_ex`: `0x40d8a1`/`0x40d8e2` *(particle system)*

## Block sprite families (format-string loads)

| Format | VA | Loader site | Notes |
|---|---|---|---|
| `cir0%d` | `0x432158` | `0x4035dd` | circle blocks, 1-digit |
| `%s%02d` | `0x432210` | `0x403e25` | **generic family**: prefix ∈ {box,tri,cir…} + 2-digit |
| `ex_%s%02d_%02d` | `0x432228` | `0x403e5d` | ex variants (same fn as above) |
| `album%02d` | `0x434230` | `0x4092e5` | in-scene photo albums |

Central sprite getter around `0x403e25` has cache debug `cached:%d,%d,%d`
(`0x4336e0`) *(inferred: graph cache keyed by family+idx)*.

## Engine internals spotted via debug strings

- `over drawing queue. %d` (`0x436268`) — the engine uses a **draw queue** with a capacity assert *(inferred: z-ordered submission)*
- `score:%d chain:%d level:%d` (`0x433bf8`), `burst:chain %d num %d` (`0x434648`),
  `vanish:%d` (`0x434608`) — gameplay event logging strings
- `seed:%d`/`level:%d`/`score:%d` (`0x4362e8..0x436358`) — HUD/result formatting
- Replay writers: `irisu_%08d_%s_%d.rpy` / `metsu_%08d_%s_%d.rpy` (`0x434740/0x434760`)

## ScenePlay vtable `0x433580` (18 slots)

```
+00 0x433530  +04 0x41717c  +08 0x417194  +0c 0x4171a0  +10 0x4171a4
+14 0x4171fc  +18 0x406d68  +1c 0x407290  +20 0x407074  +24 0x4077c4
+28 0x407814  +2c 0x40781c  +30 0x406df0  +34 0x407be0  +38 0x407c08
+3c 0x407c10  +40 0x407c20  +44 0x407c30
```
Slot `+1c` (`0x407290`) walks an fhandle array at `+0xd4..+0xfc` freeing
non-`-1` entries via the delete wrapper, then tail-calls `0x407708` —
destructor/dispose *(inferred)*. Draw/update slots not yet pinned; next step.

## Next steps (in order)

1. Pin ScenePlay `update`/`draw` vtable slots (dynamic log or call-count heuristics), then fully disassemble `ScenePlay::Draw` with the xref table inlined.
2. Extract per-draw-call constants (x/y/blend/angle) — correlate `SetDrawBlendMode`(1 site) + `SetDrawBright`(1 site) wrappers with the draw queue.
3. Trace handle globals: asset load site → storing global → draw site (`phase1-asset-map.json` has the first half).
4. Build the sprite manifest (`asset → size, anchor, blend`) using `GetGraphSize` sites + extracted PNG dims.
5. Implement the renderer over the clone snapshot loop; validate vs the 18 metsu replays.
