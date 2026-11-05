# Phase 1 recon — irisu.exe v2.03 engine internals (v3)

Static findings from capstone-based analysis (scripts `/scripts/phase1*.py`,
`disx.py` shared helper). Complements `binary-analysis.md`. All VAs, imagebase
`0x400000`. Semantics marked *(inferred)* need dynamic confirmation.

**v3 is a major rewrite**: the scene driver, draw queue protocol, class map and
pool system are now fully decoded. The v2 claim "ScenePlay vtable = 0x433580"
was wrong (that is `Number.Number`); the real one is **0x434820**.

## D runtime basics (needed to read everything else)

- D vtables: `[obj+0]` → dispatch table whose slot `+0x00` is the ClassInfo
  pointer; methods start at `+0x04`. Calls: `mov edx,[obj]; call [edx+0xNN]`.
- ClassInfo layout (verified): `+0x00` vptr, `+0x04` monitor, `+0x08` init
  {len,ptr}, `+0x10` name {len,ptr}, `+0x18` vtbl {len,ptr}, `+0x20`
  interfaces {len,ptr}, `+0x28` base ClassInfo, `+0x2c` default ctor,
  `+0x30` invariant. D strings everywhere are `{len, ptr}` (len first).
- `0x4160e0` = class **invariant walker** (D contracts compiled in → the
  binary is a debug build; also explains `Log.txt` debug switch).
- `0x418ec8` = `new ClassInfo`, `0x416268` = arg/INI array parser,
  `0x419494` = D array reserve, `0x418964` = format, `0x418f9c` = array fill.
- **DxLib return convention: 0 = success, -1 = error.** This flips the meaning
  of every `test eax` after a DxLib call (v2 got the main loop's pump wrong).

## Class map (16 classes, from ClassInfo names)

```
object.Object (root)
├── Obj.Obj                 CI 0x433810  vt 0x433860  21 slots   pooled sprite base
│   ├── Block.Block         CI 0x432340  vt 0x432390  30 slots   gameplay blocks (Box2D)
│   └── Clickable.Clickable CI 0x432660  vt 0x4326b0  24 slots   menu buttons
│   └── Number.Number       CI 0x433530  vt 0x433580  22 slots   HUD digit renderer
├── Scene.Scene             CI 0x433d80  vt 0x433dd0  10 slots   base scene (abstract)
│   ├── ScenePlay           CI 0x4347d0  vt 0x434820  28 slots   GAMEPLAY (this port's target)
│   ├── ScenePlay_org       CI 0x434cd0  vt 0x434d20  20 slots   legacy gameplay (unused?)
│   ├── SceneTitle          CI 0x435bc0  vt 0x435c10  25 slots   title/menu/ranking
│   ├── SceneEvent          CI 0x434100  vt 0x434150  21 slots   story events
│   └── ScenePhoto          CI 0x434270  vt 0x4342c0  11 slots   photo gallery
└── Field.Field             CI 0x432df0  vt 0x432e40  15 slots   static playfield walls
Game.Game 0x432ff0 (9) · Game.GcWatcher 0x432f40 · SaveData.SaveData 0x433c40 (27)
tx.Cache.Cache 0x436010 (14) · tx.Input.Input 0x436440 (30)
```

### Scene vtable protocol (dispatch base = vt ptr incl. ClassInfo slot)

| slot | meaning |
|---|---|
| `+0x18` | **pump** `0x4087a8` (shared by all scenes): `ProcessMessage()==0` (success) → run `+0x1c` and propagate its return; the main loop exits when it returns 0 |
| `+0x1c` | **per-frame update** (ScenePlay: state dispatcher `0x4093bc` on `[this+0x30]`) |
| `+0x20` | init (called by creator with D-array arg) |
| `+0x24` | **dispose** (ScenePlay `0x4098ac`: cascade children, `_b2d_dispose`) |
| `+0x28` | init2 (SceneEvent takes int arg) |
| `+0x2c` | ScenePlay: pause/quit handler → game step |
| `+0x30` | ScenePlay `0x409d90`: progress check (skip when replay `[this+0xc]`), see chapter table |

Scene instance fields (ScenePlay): `+0x08` next scene (non-zero = switch),
`+0x0c` replay-playback flag, `+0x30` state, `+0x38` rng seed (from GetNowCount),
children `+0x10` Field(walls, direct new), `+0x18`/`+0x1c` Number HUD,
`+0x20`/`+0x28`/`+0x2c` pooled Obj "fields" (spawner/preview/timer).

### Obj vtable protocol (pools call these)

| slot | meaning |
|---|---|
| `+0x18` init (0x4075e8) · `+0x1c` dispose (0x407708) · `+0x20` init2 (0x40772c, sprite-family arg) |
| `+0x24` **update** (0x4077c4): `+0x2c` physics, `+0x58` life-- → 0 → `+0x1c` expire, fade `+0x40 += +0x44` |
| `+0x30` **submit** (0x4078dc): generic sprite draw (rota/box/modi/tri/string by mode) |
| `+0x54` active flag (0=active — pool loop skips 1) · `+0x55` hidden |

Obj physics (0x40781c), `[0x436a58]` substeps/frame:
`vy(+0x14)+=ay(+0x1c); vx(+0x18)+=ax(+0x20); y(+0xc)+=vy; x(+0x10)+=vx;
rot(+0x24)+=rotV(+0x28)+rotA(+0x2c); if(+0x6c) ay+=(clock()-C1)*K1;
if(+0x70) wobble(+0x30)=sin(age*K2)/(+0x70)+C3`.

## Main loop (Game.Game::+0x1c = 0x4065f0) — exact frame order

```
loop:
  1. tx.Input([0x4428a4])->poll(+0x60)          input state, replay rec/play
  2. fn_40f470                                   window restore (if iconized)
  3. scene([game+8])->pump(+0x18)                ProcessMessage + scene->update(+0x1c)
       └─ update returns 0 → game exits
  4. if (scene->next(+8)) { scene->dispose(+0x24); scene = scene->next; }
  5. game->framePace(+0x20 = 0x406730)           60fps WaitTimer (skipped in FF)
  6. poolA.update / poolB.update / poolC.update / poolD.update   (Obj +0x24)
  7. if (!fastForward || ++frame % 20 == 0):
       poolA..D.submit (Obj +0x30) → ClearDrawScreen → flushQueue(0x41051c) → ScreenFlip
  8. frame counters ++ (0x442664 total, 0x44266c render), D-array/GC tail
```

Fast-forward: `tx.Input::+0x48` (bool) or `+0x58` (int) non-zero → render only
every 20th frame (replay verification runs 20×). Mouse wheel adds ±30 to a
cooldown (`+0x44`) — *(inferred: FF speed control)*. Engine init at `0x4069a8`:
`ChangeWindowMode(1)`, `Log.txt` presence → DxLib log on, `SetDrawMode(1)`,
archive key `shine`, `SetDrawScreen(-2)`, `SetWaitVSyncFlag(0)`,
`SetAlwaysRunFlag(1)`, `SetWindowUserCloseEnableFlag(0)` (X disabled →
`GetWindowUserCloseFlag(1)` polled in ScenePlay::+0x2c → back to title).

## Object pools (four, round-robin recycling)

| pool | len/ptr | cursor | cap | class | factory |
|---|---|---|---|---|---|
| A | 0x442690/94 | 0x442698 | 100 | Obj.Obj | 0x4073d0 |
| B | 0x442650/54 | 0x442658 | 5 | Clickable | 0x403f54 |
| C | 0x442678/7c | 0x442680 | 10 | Number | 0x406b9c |
| D | 0x442620/24 | 0x442628 | 200 | Block | 0x403010(0xc8) in ScenePlay::init |

Update/submit pairs: A `0x4074e0/0x407528`, B `0x404130/0x404178`,
C `0x406cac/0x406cf4`, D `0x4031ec/0x403234`. Factory = find inactive
(flag `+0x54` != 0) member round-robin, reactivate; grow if none (cap check
`[pool CI slot]`), new instances start inactive. Pool D grows at ScenePlay init
(cap 200).

## Draw queue (the renderer contract) — FULLY SPEC'd

Init `fn_410004` (called once, before `DxLib_Init`): 7-8 layer arrays, capacity
100, each entry **56 bytes (14 dwords)**.

Globals: layer arrays (D {ptr,len}) `0x4427f0 + 8*i`, counts `0x442830 + 4*i`,
flush resets counts. Submit core `0x410120` (grow +200 on overflow, prints
`over drawing queue. %d`).

**Entry layout** (rota case; modi uses `+0x30` as trans):

| off | field |
|---|---|
| `+0x00` | type: 0 rota, 1 box, 2 string, 3 modi, 4 triangle |
| `+0x04` | blendMode (DX_BLENDMODE_*) |
| `+0x08` | blendParam (0-255) |
| `+0x0c` | bright (grayscale, R=G=B) |
| `+0x10` | x / x1 |
| `+0x14` | y / y1 |
| `+0x18` | f64 ExtRate (rota) / x2 (box) / fontSize (string) |
| `+0x1c` | f64 Angle (rota) / y2 / string ptr |
| `+0x20` | x3 (modi: f64 again) / color (box,string) |
| `+0x24` | y3 / fillFlag (box) |
| `+0x28` | GrHandle (rota) / x4 / color (tri) |
| `+0x2c` | Trans (rota) / y4 / fill (tri) |
| `+0x30` | RevX (rota) / GrHandle (modi) |
| `+0x34` | (unused rota) / Trans (modi) |

Flush `0x41051c` (between ClearDrawScreen and ScreenFlip):
`SetDrawBright(e3,e3,e3); SetDrawBlendMode(e1,e2);` then per type:
- **rota** → `DrawRotaGraph(x, y, ExtRate(f64), Angle(f64), gr, trans, revX)` —
  import `@36` = 7 params, doubles as dword pairs
- **box** → `DrawBox(x1,y1,x2,y2,color,fill)`
- **string** → `SetFontSize(e6) if >0; DrawString(x, y, ptr, color, ?)`
- **modi** → `DrawModiGraph(x1,y1,x2,y2,x3,y3,x4,y4,gr,trans)`
- **tri** → `DrawTriangle(x1,y1,x2,y2,x3,y3,color,fill)`

Submit API: `0x410278` rota (used by Obj::submit 0x40799c, Number::submit
0x407007), `0x4102f8` box, **`0x410390` modi — the workhorse (11 callers:
Block, Obj, ScenePlay×4, ScenePlay_org×2, SceneTitle×2, tx.Input)**,
`0x410410` tri, `0x41049c` string. Screen: **640×480** (0x280/0x1e0 constants).

## Box2D binding (b2d.dll import set — the full physics API)

`_b2d_init(gravity..)`, `_b2d_step(dt)`, `_b2d_dispose`,
`_b2d_create_circle/box/triangle`, `_b2d_destroy_body`, `_b2d_set_position`,
`_b2d_set_v`, `_b2d_set_user_data`, `_b2d_get_contact`, `_b2d_get_x/y/r/v`.

- ScenePlay::init: `_b2d_init([0x4344c0..d0])`, `[0x4428e4]` = pause flag from
  command line, score globals reset (`[0x4428c0]=0, [0x4428c4]=0, [0x4428c8]=1`).
- `_b2d_step` sites: ScenePlay **m25 `0x40a9e4`** (`dt = world_dt * [0x436a58]`
  substeps) and ScenePlay_org `0x40bedd`.
- Block odds/size tuned via INI: `data\doc\` + `Irisu.ini`-style
  `block_odds[10]`, `block_size`, `ex_block_odds`, `ex_block_size`
  (loader `0x41207c`, args `0x436ab0..0x436afc`).

## Chapter / story progression (ScenePlay m12 `0x409d90`)

Switch on `SaveData::+0x28()` chapter (0..0x13) via jumptable `0x434588`:
chapters ≥6 gate on **score `[0x4428c0]` > {500, 1000, 2000, 3500, 5500, 8000,
20000, 50000, 100000}** AND `SaveData::+0x48()` flag → next chapter. Chapter 4:
`SaveData::+0x50() > 20000` → set flag. Score > 40000 → ch9. **Score > 100000
in ch8 → `fn_415fb8`** (the famous "corruption" event — port target, Phase 4).
Non-replay only (`[this+0xc] == 0`).

## SaveData / tx singletons

Created `0x412228`: `0x4428a0` = tx.Cache (image loader, vt+0x1c = load by
name), `0x4428a4` = tx.Input, `0x4428d0` = SaveData. Scene creation:
`Game::+0x18` (`0x406598`): save chapter==7 → `new SceneEvent`(+0x28 with 2),
else `new SceneTitle`. Scenes set `scene->next` themselves (e.g. X-click →
`ScenePlay::+0x2c` → new SceneTitle). Bootstrap `0x40680c`: `new Game.Game` →
`+0x18` initScene → `+0x1c` main loop → SaveData::+0x68 save.

## Asset xref correction

v2's "ScenePlay region 0x408892..0x40953a" spans **SceneEvent + ScenePhoto +
ScenePlay::init**; the HUD asset loads (`pointer/frame/irisu/flick`) live in
ScenePlay::init / children init. Block-family loaders unchanged. `Number.Number`
(0x433580) = HUD digits: update 0x4077c4 (base Obj), submit 0x406df0 draws a
`sqrt(N)+1` column grid of fhandles `[this+0xd4 + idx*4]` (10 handles, cell
`[this+0xfc]`, per-column slot map `[this+0xc4]`, count `[this+0xc0]`).

## ScenePlay method map (dispatch base 0x434820)

| slot | fn | notes |
|---|---|---|
| +0x18 | 0x4087a8 | pump (all scenes) |
| +0x1c | 0x4093bc | update: state dispatch on `[this+0x30]` (0→+0x2c, 1→ret, else 0x4093e4) |
| +0x20 | 0x40941c | init: b2d world, children, seed `[this+0x38]`, replay wiring, walls Field |
| +0x24 | 0x4098ac | dispose (children, `_b2d_dispose`) |
| +0x28 | 0x4098fc | checks `[this+0xc8]==3` |
| +0x2c | 0x40992c | pause/quit/step: `[0x4428e4]<=0` → m26; X-click → SceneTitle |
| +0x30 | 0x409d90 | chapter progress table (above) |
| +0x34..+0x70 | 0x40a018..0x40af48 | gameplay step (m26 0x40adc4 calls m25 0x40a9e4 physics) — to disassemble |

## What's left in Phase 1

1. Disassemble ScenePlay `+0x34..+0x70` (m13..m27) — game step, spawn rules,
   scoring, draw submits with constants (4 modi sites in 0x4099cf..0x409d90).
2. Block.Block 30 slots — body creation, sprite pick (`cir0%d`/`%s%02d`
   families), contact handling (`_b2d_get_contact`).
3. Field.Field 15 slots — walls + b2d static bodies.
4. Sprite manifest: pair every submit site's handle source with PNG sizes.
5. Score/chain/level globals audit (`0x4428c0/c4/c8/cc`, `0x4428e0`).
6. Implement the clone: queue + flush (this spec), pools, Obj/Block/Field
   physics via our own Box2D or the metsu runtime's, then the 18-replay parity.

## Reproducing

`tools/phase1/*.py` (capstone + a hand-rolled PE parser, `disx.py` is the
shared helper; run in order b→g). Raw console dumps of the key functions are
in the commit history of this file's generation session; the scripts are
idempotent against `reference/game/irisu.exe`.
