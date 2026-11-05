#!/usr/bin/env python3
"""Irisu .dxa extractor v3 — FINAL. Handles dat's in-band headers + stale size fields."""
import struct, os

KEY = bytes.fromhex("8c86e3199adf97d2731ae1a4")
DXA = "/home/z/my-project/irisu-syndrome-web/reference/game/data"
OUT = "/home/z/my-project/irisu-syndrome-web/reference/extracted"

def dec(raw, off, size):
    return bytes(raw[off + i] ^ KEY[(off + i) % 12] for i in range(size))

def name_at(names_r, off):
    ln = struct.unpack("<H", names_r[off:off+2])[0]
    orig = names_r[off+4+ln*4:off+4+2*ln*4]
    return orig.rstrip(b"\x00").decode("cp932", "replace")

def extract(arch):
    raw = open(f"{DXA}/{arch}.dxa", "rb").read()
    head = dec(raw, 0, 24)
    ver = struct.unpack("<H", head[2:4])[0]
    hs, ds, nts, fts, dts = struct.unpack("<5I", head[4:24])
    names_r = dec(raw, nts, fts)
    fh = dec(raw, nts + fts, dts - fts)
    nrec = (len(fh) - 40) // 44
    recs = []
    for k in range(nrec):
        rec = fh[40 + 44*k : 84 + 44*k]
        nameoff = struct.unpack("<I", rec[4:8])[0]
        dataoff, datasize = struct.unpack("<2I", rec[36:44])
        recs.append((name_at(names_r, nameoff), dataoff, datasize))
    # sanity: dataoffs must be ascending
    offs = [r[1] for r in recs]
    assert all(offs[i] < offs[i+1] for i in range(len(offs)-1)), f"{arch} dataoffs not ascending"
    outdir = f"{OUT}/{arch}"
    os.makedirs(outdir, exist_ok=True)
    manifest, notes = [], []
    for k, (name, off, size) in enumerate(recs):
        end = recs[k+1][1] if k+1 < nrec else (nts - ds)
        block = dec(raw, ds + off, end - off)
        note = ""
        low = name.lower()
        if low.endswith(".txt") and len(block) > 9 and block[8] == 0xFF \
           and struct.unpack("<I", block[0:4])[0] <= len(block):
            note = f"in-band hdr: sizes({struct.unpack('<I', block[0:4])[0]}, {struct.unpack('<I', block[4:8])[0]})"
            text = block[9:]
            with open(f"{outdir}/{safe(name)}.raw", "wb") as f:
                f.write(block)
        if low.endswith(".png"): good = block[0:8] == b"\x89PNG\r\n\x1a\n"
        elif low.endswith(".wav"): good = block[0:4] == b"RIFF"
        elif low.endswith(".gif"): good = block[0:4] == b"GIF8"
        elif low.endswith((".jpg", ".jpeg")): good = block[0:3] == b"\xff\xd8\xff"
        else: good = None
        if good is False:
            note += " TYPE-BAD"
        with open(f"{outdir}/{safe(name)}", "wb") as f:
            f.write(block)
        manifest.append((f"{arch}/{name}", len(block)))
        if note: notes.append(f"  {name}: {note}")
    print(f"{arch}.dxa: {nrec} files → {outdir}/")
    for n in notes[:8]: print(n)
    return manifest

def safe(n): return n.replace("/", "_")

if __name__ == "__main__":
    allm = []
    for arch in ("snd", "dat", "img"):
        allm += extract(arch)
    with open(f"{OUT}/MANIFEST.txt", "w", encoding="utf-8") as f:
        for p, s in allm:
            f.write(f"{s:>12,}  {p}\n")
    print(f"\nTOTAL: {len(allm)} files")
