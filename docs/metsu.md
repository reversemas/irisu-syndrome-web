# Metsu (nonzero) mode — recovered rules and implementation

This document records the clean-room static analysis of the Metsu mode of
Irisu Syndrome v2.03 (`irisu.exe`, DMD D1, PE32 i386) and how the clone
implements it. Normal mode remains the replay-exact mode-0 profile; Metsu is
the separate nonzero-mode profile selected by the replay header's mode field
(offset `0x10`: 0 = normal, 1 = Metsu).

## Architecture findings

- `ScenePlay.ScenePlay` (ClassInfo 0x4347d0) is the v2.03 gameplay scene used
  by BOTH modes. `ScenePlay_org.ScenePlay_org` (0x434cd0) is the legacy v1
  scene; it always writes `irisu_*.rpy` replays and is out of scope.
- The mode lives on the manager singleton at `0x4428d0`, virtual `+0x48()`.
  It selects the config defaults (selector 0x4124c0 → normal table 0x412560 or
  the Metsu table 0x413648), the level setter (0x415600 → 0x415624 normal or
  **0x415800 Metsu**), the replay filename prefix (`irisu_%08d_%s_%d.rpy` /
  `metsu_%08d_%s_%d.rpy`), the ending audio, and several mode branches.
- The shipped `data/doc/irisu.ini` equals the Metsu default table at 0x413648.
- Field/Block/ScenePlay code is shared; Metsu behavior emerges from the config
  values plus the branches below. Replays still carry the 52-byte header and
  identical input records.

## Config profile (Metsu table 0x413648 == irisu.ini)

```text
field x=94 y=20 width=420 height=370 blank=30 thick=16
extra top=-140 top_w=450 top_h=300 bottom_h=400
squares: density 1 / friction 1 / restitution 0; sizes 30/48/64 odds 10/40/20
bubbles (ex_block): density 25 / friction 1 / restitution 0
  sizes 42/58/74/90/104/120 odds 20/40/50/50/25/15
  y1=500 y2=0 x_adj=50 speed=-0.05 (display units per update, rising)
projectile: size 24 density 8 friction 1 restitution 0 life_span 1200
special: size 24 density 50 friction 0.1 restitution 0.6
statge_level_norma = 6        gauge x=34 y=100 w=20 h=350
game_life max=10000 init=1000 plus_unit=120
block_life_span 10000  block_death_delay 120  world_step 0.02
```

## Level setter 0x415800 (per level L, 1..99)

```text
D = 0                                  # no passive life drain
V = 1.0 (L%24==0) | 0.6 (L%6==0) | 0.1 + 0.03*(L%6)   # float32 store
exV = ex_block_speed = -0.05
I = 120 - 10*(L%8)                     # square spawn interval
exI = 200 - trunc(sin(L*2π/12)*50)     # bubble spawn interval, period 12
P = 600 + 50*trunc(L/25)               # rot penalty
C = 5 + trunc(L/25)                    # inclusive max color ID (10 colors at 100)
reward = game_life_plus_unit = 120
S = pow(L,0.7) * (trunc(L/25)+4)       # x87 pow, binary64 store
T = 100 fixed (NO GetRand(100) draw; squares are always boxes)
```

Level progression: `candidate = qualifying_count/6 + 1`; level 100 (count 594)
is terminal exactly like normal mode.

## Reset differences

The Metsu reset skips the ten rotten physics blocks entirely; only the ten
scripted falling squares at Y=60 are prefilled. The shape-cutoff GetRand(100)
is not consumed (T is fixed at 100). The special threshold draw
`40 + GetRand(12)` is unchanged.

## Spawning (Field.update 0x40550c / Field.spawn 0x4059dc)

Per update: squares spawn at `tick % I == 0` from Y=-50; bubbles spawn at
`tick % exI == 0` (Metsu only). Both spawns draw the size ticket over the
SQUARE table total (the executable indexes the selected flat table with the
block_odds ticket), so the shipped bubble table only ever rolls its first
three sizes: **42, 58, 74**. Draw order per piece: size ticket, X, (bubbles
additionally GetRand(ex_block_y2)=GetRand(0)), rotation GetRand(1000)*2π/1000,
color GetRand(C), and the GetRand(100) shape draw (always box for squares,
always circle for bubbles; the draw is still consumed).

Metsu square X spans `field_x + 30 + GetRand(field_width - 40)`; bubble X spans
`field_x + x_adj + GetRand(field_width - thick - 2*x_adj)`; bubbles spawn at
Y=500 below the field and rise through the bottom fixture.

## Contact rules (Metsu additions to the shared dispatcher 0x40a9e4)

- Top gate: a scripted bubble touching the bottom latches e4 and
  short-circuits.
- Grouping member rules (0x40a35c):
  - bubble + bubble: an unscheduled bubble touching a bubble inside its
    activation window (`0 < pop_countdown <= 112`) joins its group and gets
    its own 120-update pop countdown — the chain;
  - bubble + grouped square of the same color: the bubble joins the group,
    gets the 120-update pop countdown, and turns physics-owned (it stops
    rising and falls) — the activation;
  - bubble + ungrouped square: silent group membership;
  - rotten + bubble pairs are rejected.
- Activation (0x40a7d8 bubble path): a scripted bubble turns physics-owned on
  a fresh projectile (the white/gray shot) or a scripted falling square.
- Burst (0x40a510): bubbles are burst triggers like the bottom; the bursting
  target gains `group.num * 120` life (rotten targets gain none).
- Direct hits (0x40a89c): bubbles do not consume the projectile, so shots
  keep pushing and rolling them.
- Rot (0x40a66c): bubbles latch the rot timer only once physics-owned for
  five updates, and the timer never progresses for bubbles.

## Actor update (Block.update 0x4033d0)

Bubbles skip rot progression and keep the Obj default lifetime of -1 (never
expiring). The pop countdown decrements after the physics-frame counter; at
zero the executable plays the pop sound at `17050 + 5000*chain` Hz, spawns the
effect, and latches d4, which makes the popped bubble burst-eligible. Scoring
uses the normal burst formula with the Metsu S scale:

```text
delta = trunc((0.5*group.burst_count + 0.5) * group.chain * S * max(1, slot-4))
```

Metsu slots are 0..5, so the slot factor is always one. Life is lost through
the rot penalty `P` (squares rotting past block_death_delay) and gained only
through bursts; there is no passive drain. Game over fires when life is
nonpositive at scene entry.

## Implementation map

- `clone/core/metsu_rules.cpp` — the level table, score delta.
- `clone/core/config.cpp` — `metsu_default_config()` and validation.
- `clone/core/simulator.cpp` — the mode branches (reset prefill, spawn tables
  and X formulas, bubble cadence, contact rules, pop countdown, scoring, life
  drain).
- `clone/bindings/c_api.cpp` — `irisu_create_mode(1)` and
  `irisu_step_ex(..., suppress_fresh_edges)`.
- `apps/web/static/irisu-wasm.{js,wasm}` — the portable Emscripten module
  (rebuild with `apps/web/build-wasm.sh`).
- `apps/web/static/metsu-runtime.mjs` — the browser runtime driving the wasm
  module with the same snapshot interface as the exact v86 worker.
- `apps/web/static/app.js` — the NORMAL ⇄ METSU header button, the vertical
  life gauge (INI geometry 34,100,20,350), bubble rendering with the pulsing
  activation glow, and `metsu_*.rpy` replay save/load (mode byte 1).

Replay parity for mode 1 is implemented at the rule level (exact RNG draw
order, exact spawn tables and cadence, the shared contact predicates) but,
unlike normal mode, no original Metsu replay oracle has been validated
against the exact 32-bit physics host yet; the portable backend drives the
browser version.
