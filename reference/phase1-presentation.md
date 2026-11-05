# Phase 1 addendum — gameplay presentation layer (sounds, sprites, effects)

Clean-room static analysis of `irisu.exe` v2.03 backing the web port's
presentation layer (`apps/web/static/sprites.mjs`, `sfx.mjs`, `app.js`).
All addresses are VAs.

## Sprite selection (loader 0x403dfc, called from the shape creators)

```text
normal mode:  sprintf("%s%02d",        shape, color)     -> box03, cir07, tri00 …
metsu mode:   sprintf("ex_%s%02d_%02d", shape, color, size_slot)
```

- `shape` strings: "box" (0x4321d8-area), "tri" (0x4321e0), "cir" (0x432200).
- `color` = Block color `[0xbc]` (GetRand(C) at spawn).
- `size_slot` = Block `[0xc0]` — **the weight-table slot** (0x405a63/0x405aa9),
  not the shape draw. ex_box frames 00–02 = square slots (30/48/64);
  ex_cir frames 00–05 = bubble slots (42/58/74/90/104/120). Sprite natural
  sizes match those exact sizes, so scale = size / sprite_w.
- The special orb renders with the `cir` family (cir sprites are 24×24 =
  `special_size` 24) and cycles color; projectiles are `sball` (weak, flat
  white 32×32) / `fball` (strong, flat gray 32×32), loaded in Field.fire
  (0x40556d / 0x4055d4).
- The DXA archive key string is "ptcl_ex" (`SetDXArchiveKeyString` 0x406a24).

## Block render state (tail update 0x403858; draw via pool slot 12 = 0x40396c)

Priority order (first match wins):

```text
rotten (c8==3)    alpha 164, anim 0, bright 255
special (c5)      anim 1, bright 200
e5 (settled)      anim 1, bright 128
scripted (c4==0)  anim 1, bright 164 (normal) / 196 (metsu)
grouped (d4) or popping ([0xf4]>0)   anim 2, bright 128   [physics only]
otherwise (fresh physics)            anim 0, bright 255
```

`bright` feeds `SetDrawBright(v,v,v)` in the draw-queue executor (0x4105bf).
anim 2 additionally spawns the pop effect object (vtable +0x44 → 0x407c30):
a clone of the block sprite (state 5, kind 6, bright 48) that expands/fades.
The chain getter (0x403eec) returns **min(group chain, 8)** (8 for special,
1 for ungrouped) — this clamps every chain-pitched sound.

## Wall sprites (metsu setup 0x405287..0x4053a7)

field_l/r/t/b objects copy the physics fixture positions/blend states and
load their sprite by name. Fixture centers (clone-validated): left wall
(field_x+thick/2, field_y+h/2), right wall (field_x+width+thick, same),
floor top edge at field_y+height+blank, top gate offscreen (field_top).
field_l/r are 20×380, field_t 460×10, field_b 460×60 (the visible bottom bar).
The plain-rect fallback path (draw queue type 2) covers colorless blocks.

## Backgrounds (Field ctor 0x404652 area + changer 0x405740..)

```text
normal: back1 -> back2 (music state >= 4) -> back3 (score > 40000)
metsu:  back1_ex -> back1_ex2/back1_ex3 (higher music states)
```

All backgrounds are 640×480 with ~50% transparency (art cutouts over the
dark canvas).

## Sound system

Sounds are played by inline D-string name through resource-manager virtual
+0x20 (lookup `snd\<name>` via the handle cache, then PlaySoundMem).

| Event (site) | Sound | Notes |
|---|---|---|
| rot penalty (0x40353a, Block.update) | buble02.wav | life -= P |
| bubble pop (0x40359f/0x4035ac) | buble03.wav | **freq 17050+5000·min(chain,8)** |
| burst fanfare (0x40ac5f/0x40accf) | config `se_c0` (cursor3.wav) chain 0 | per contact frame |
| burst fanfare, chain≥1 | config `se_c1` (puu89.wav) | same pitch formula |
| burst layer (0x40ad22) | config `se_v0` (decide10.wav) | tracked max ≥ 0 |
| burst layer (0x40ad49) | decide10.wav literal | tracked max == 0 |
| burst layer (0x40ad9c) | config `se_v1` (decide12.wav) | tracked max ≥ 0 |
| direct-hit tick (0x40a92f) | call07.wav | first hit |
| direct-hit crush (0x40a90d) | decide3.wav | hits ≥ 2, both deleted |
| level up (0x40afb9) | power14.wav | right after set_level dispatch |
| game over / finish area | decide10.wav + music states | result screen |

The burst fanfare runs once per physics frame **after the whole contact
traversal** (function 0x40a9e4..0x40ada8), keyed on four tracked maxima
initialized to -1 (chain via virtual +0x38 = min(chain,8); the other three
via +0x3c/+0x40/+0x44). Idle frames play nothing (maxima stay -1).

## Port implementation notes

- `sprites.mjs` pre-bakes brightness variants (multiply + destination-in)
  for the reversed SetDrawBright levels {128, 164, 196, 200, 255}.
- Additive art: `pointer.png` (palette PNG, 83% black) and the `ptcl*`
  particle family are DX_BLENDMODE_ADD art — black pixels must be drawn
  additively (the "_a" suffix sprites are the additive variants).
- `sfx.mjs` maps clone events → sounds: `bubble_popped`.value carries the
  exact group chain (clone simulator.cpp:2402); block-burst chains are
  approximated by the frame's burst count (the observation does not carry
  group chains for square bursts).
- Score popups slice `ranking_num_ex.png` into ten 27×33 digit cells
  (gaps at 27-pixel boundaries confirmed by column projection).
