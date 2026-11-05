#!/usr/bin/env python3
"""DxLib .dxa archive extractor for Irisu Syndrome v2.03.

Status: SCHEMES ATTEMPTED, cipher not yet recovered. The exact DxLib archive
cipher will be recovered by reversing DxLib.dll's archive functions
(DA_Open / ArchiveDataDecode) — see docs/PORT_PLAN.md phase 0.

Usage (once the cipher is implemented):
    python3 tools/dxa_extract.py reference/game/data/img.dxa --out reference/extracted/img/
    python3 tools/dxa_extract.py reference/game/data/snd.dxa --out reference/extracted/snd/
    python3 tools/dxa_extract.py reference/game/data/dat.dxa --out reference/extracted/dat/

For now, running it attempts the known simple schemes and reports which (if any)
produce readable output, as a diagnostic.

The .dxa format (observed):
- First 4 bytes: the key code (c8 de e0 19 — identical across all three Irisu
  archives, so the author used one key string when encoding).
- Remainder: encrypted (file directory + file data).
- irisu.dat (in data/doc/) is NOT a .dxa — it's a raw BMP (42 4d header).
"""
from __future__ import annotations
import argparse
import struct
import sys
from pathlib import Path

DXA_MAGIC_LE = 0x19E0DEC8  # c8 de e0 19 little-endian
DXA_MAGIC_BE = 0xC8DEE019

EXTENSIONS = [b".png", b".bmp", b".wav", b".ogg", b".mp3", b".jpg", b".tga",
              b".mid", b".txt", b".dat"]


def generate_keytable_msvc_lcg(key: int, length: int = 0x800) -> bytearray:
    """MSVC rand() LCG: state = state*0x343FD + 0x269EC3; byte = (state>>16)&0xFF."""
    table = bytearray(length)
    state = key
    for i in range(length):
        state = (state * 0x343FD + 0x269EC3) & 0xFFFFFFFF
        table[i] = (state >> 16) & 0xFF
    return table


def decrypt_xor_table(data: bytes, table: bytes) -> bytearray:
    out = bytearray(len(data))
    tlen = len(table)
    for i in range(len(data)):
        out[i] = data[i] ^ table[i % tlen]
    return out


def decrypt_xor_simple(data: bytes, key4: bytes) -> bytearray:
    out = bytearray(len(data))
    for i in range(len(data)):
        out[i] = data[i] ^ key4[i % 4]
    return out


def score(decrypted: bytes) -> tuple[float, list[str], int, bool]:
    sample = decrypted[:8192]
    printable = sum(1 for c in sample if 32 <= c <= 126 or c in (9, 10, 13))
    ratio = printable / len(sample)
    found = [e.decode() for e in EXTENSIONS if e in sample]
    file_count = struct.unpack("<I", decrypted[:4])[0] if len(decrypted) >= 4 else -1
    fc_plausible = 1 <= file_count <= 5000
    return ratio, found, file_count, fc_plausible


def diagnose(path: Path) -> None:
    raw = path.read_bytes()
    key4 = raw[:4]
    key_le = struct.unpack("<I", key4)[0]
    key_be = struct.unpack(">I", key4)[0]
    body = raw[4:]
    print(f"file: {path}")
    print(f"  size: {len(raw):,}  key4: {key4.hex()}  key_le: {key_le:#010x}")
    schemes: list[tuple[str, bytes]] = []
    schemes.append(("MSVC-LCG table0x800 (key LE)",
                    bytes(decrypt_xor_table(body, generate_keytable_msvc_lcg(key_le)))))
    schemes.append(("MSVC-LCG table0x800 (key BE)",
                    bytes(decrypt_xor_table(body, generate_keytable_msvc_lcg(key_be)))))
    schemes.append(("XOR simple 4-byte cycle", bytes(decrypt_xor_simple(body, key4))))
    print()
    any_hit = False
    for name, dec in schemes:
        ratio, exts, fc, fc_ok = score(dec)
        head = "".join(chr(c) if 32 <= c <= 126 else "." for c in dec[:32])
        hit = ratio > 0.6 or exts or fc_ok
        any_hit = any_hit or hit
        marker = " <<< HIT" if hit else ""
        print(f"  {name:38} printable={ratio:.0%} exts={exts} filecount={fc}{' ok' if fc_ok else ''}{marker}")
        print(f"    head: |{head}|")
    if not any_hit:
        print()
        print("  No scheme produced readable output.")
        print("  NEXT: reverse DxLib.dll's ArchiveDataDecode (see docs/PORT_PLAN.md phase 0).")
        print("        The DLL is at reference/game/data/dll/DxLib.dll.")
    print()


def extract(path: Path, out_dir: Path) -> None:
    """Full extraction — implemented once the cipher is recovered."""
    raw = path.read_bytes()
    key4 = raw[:4]
    body = raw[4:]
    # TODO(port-phase-0): replace the diagnostic below with the real DxLib
    # cipher recovered from DxLib.dll. The real cipher will populate:
    #   table = generate_keytable_dxlib(key_le)   # exact algorithm from DxLib.dll
    #   decrypted = decrypt_xor_table(body, table)
    #   directory = parse_directory(decrypted)    # DxLib archive file table
    #   for entry in directory:
    #       (out_dir / entry.name).write_bytes(decrypted[entry.offset:entry.offset+entry.size])
    print(f"extract: {path} -> {out_dir}")
    print("  (not yet implemented — cipher recovery pending DxLib.dll reverse)")
    diagnose(path)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="DxLib .dxa extractor (Irisu Syndrome v2.03)")
    p.add_argument("file", type=Path, help=".dxa archive path")
    p.add_argument("--out", type=Path, default=None, help="output directory (enables extraction)")
    p.add_argument("--diagnose", action="store_true", help="run scheme diagnostics only")
    args = p.parse_args(argv)
    if not args.file.exists():
        print(f"error: {args.file} not found", file=sys.stderr)
        return 2
    if args.out:
        extract(args.file, args.out)
    else:
        diagnose(args.file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
