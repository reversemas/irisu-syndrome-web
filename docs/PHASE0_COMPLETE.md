# Phase 0 COMPLETE — .dxa archive format cracked, all 306 assets extracted

**Date:** 2025-11-05 · **Status:** ✅ all three archives fully decrypted & extracted

## Results

| Archive | Files | Content |
|---|---|---|
| `snd.dxa` | 41 | ALL sound effects (WAV 22kHz): bells, bubbles, cursors, decides, gun, crash, swing… |
| `dat.dxa` | 34 | Game scripts (`script*.txt` — SJIS animation scripting), story texts, `filelist.txt`, `musics.txt`, `irisu.rng` |
| `img.dxa` | 231 | ALL art (PNG/JPG/GIF): block sprites (`box00-09`, `tri00-09`, `cir00-09`), field walls, HUD digits, title screens, menus, event images, `irisu.png` 435×600, particles (`ptcl*`), photos, rakugaki |

Every extracted file is **type-verified**: PNG signatures + IHDR dims sane, WAV
RIFF sizes == record sizes, JPG/GIF magic. Output in `reference/extracted/`
(gitignored — regenerate with `python3 tools/dxa_extract.py --all`, takes seconds).

## The format (DxLib 2008, archive ver 3 — reverse-engineered from DxLib.dll)

The shipped `DxLib.dll` (2008-04-06) predates the modern format documented in
today's DxLib source: ver ≤ 3, 32-bit fields, whole-file encryption, 12-byte key.

### Cipher

- **Key:** 12 bytes = the key string cycled to 12 length, then per-byte mangled:
  `pos: 0:~x 1:ROL4 2:^0x8a 3:~ROL4 4:~x 5:^0xac 6:~x 7:~ROL3 8:ROL3 9:^0x7f 10:ROL4^0xd6 11:^0xcc`
- **KeyConv:** `data[i] ^= key12[(absolute_file_offset + i) % 12]` — applied to
  the *entire* file including the 24-byte header ( Position = file offset).
- **Irisu's key (recovered & cross-verified):** `8c 86 e3 19 9a df 97 d2 73 1a e1 a4`
  (key string starts `"shinesh…"`, recovered from plaintext crib "DX"+ver and
  verified via PNG/WAV structures — see `tools/dxa_extract.py` docstring).

### Layout

```
DARC_HEAD (24B): "DX" u16 ver=3 | u32 HeadSize | u32 DataStart | u32 NameTableStart
                 | u32 FileTableStart(rel to NameTable) | u32 DirTableStart(rel)
[file data region: DataStart .. NameTableStart]
Name table:  entry = u16 len(bytes/4), u16 parity, upper-name(len*4), orig-name(len*4)
File heads:  record = 44B @ fh[40 + 44k]:
             u32 hash? | u32 NameOffset | u32 dos-attrs (0x80 NORMAL / 0x20 ARCHIVE)
             | u64 FILETIME ×3 (create/write/access) | u32 DataOffset(rel DataStart) | u32 DataSize
Dir table:   {u32, u32 parent, u32 fileCount, u32 nameEntryCount} (16B, single root)
```

### Gotchas discovered

- `DataSize` for some `dat.dxa` texts is **stale** (the author edited texts after
  packing); trust `DataOffset` boundaries instead.
- TXT blocks may carry a 9-byte in-band header `{u32 loose-size, u32 text-bytes, u8 0xff}`
  before the SJIS text (per-file format flag). Raw blocks are preserved as
  `<name>.raw` alongside.
- First 4 bytes of every archive are identical (`c8 de e0 19`) because the
  encrypted header plaintext ("DX"+ver) is identical — not a magic constant.

## How the key was recovered (for the record)

1. Plaintext crib: header starts `"DX" + u16 version` → `key[0..3]` directly;
   version 3 validated by both archives' `NameTableStart` landing perfectly.
2. `DataStart = 0x18` (24 ≡ 0 mod 12) → first file decodes key-aligned.
3. img.dxa first file = PNG: signature + IHDR len + `"IHDR"` verified K[0..3],
   K[8..11]; bytes 6-7 gave K[6..7] = `97 d2` (matching the header ct repeats).
4. snd.dxa first file = WAV: `"RIFF"/"WAVE"/"fmt "` + PCM/mono fields pinned
   K[4..5] = `9a df` and verified everything else.
5. Full self-consistency: both headers' `HeadSize` == exact bytes after
   `NameTableStart`; WAV chain offsets == record `DataOffset`s.

## Next: Phase 1 — gameplay scenes

With assets in hand, port the rendering layer: sprites per block shape×color
(`box/tri/cir00-09`), field walls (`field_t/b/l/r`), HUD (`num_score`, `num_chain`),
life gauge, bubble effects, score popups — mapped against `ScenePlay::Draw` in
`irisu.exe`, validated frame-by-frame against the 18 staged metsu replays.
