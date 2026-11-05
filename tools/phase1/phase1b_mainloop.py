#!/usr/bin/env python3
"""Phase 1b: pin the main loop + ScenePlay update/draw slots.

Method:
 1. Find the main loop: the function containing ClearDrawScreen + ScreenFlip
    virtual calls (scene->update / scene->draw) between them.
 2. Find the draw-queue submit fn (xrefs to "over drawing queue. %d") and the
    flush fn (calls DrawRotaGraph family in a loop).
 3. Fully disassemble each ScenePlay vtable slot, summarize APIs touched.
"""
import re, json, sys
from capstone import *
sys.path.insert(0, "/home/z/my-project/scripts")
from phase1_recon import PE, get_strings, build_thunk_map, EXE

pe = PE(EXE)
iats = pe.imports()
strs = get_strings(pe)
md = Cs(CS_ARCH_X86, CS_MODE_32)
thunks = build_thunk_map(pe, md)

def api_of_import_name(n):
    n = n.split("!")[-1]
    if n.startswith("_dx_"): n = n[4:]
    return n.split("@")[0]

# thunk va -> api name
thunk_api = {va: api_of_import_name(iats[iat]) for va, iat in thunks.items() if iat in iats}
iat_api = {iat: api_of_import_name(n) for iat, n in iats.items()}

text = [s for s in pe.sections if s[0] == "_TEXT"][0]
nm, vma, vsize, roff, rsize = text
insns = list(md.disasm(pe.data[roff:roff+rsize], pe.imagebase + vma))
print(f"_TEXT: {len(insns)} insns @ {pe.imagebase+vma:#x}..{pe.imagebase+vma+vsize:#x}")

idx_by_addr = {ins.address: i for i, ins in enumerate(insns)}

def resolve_call(ins):
    m = re.search(r"\[0x([0-9a-f]+)\]", ins.op_str)
    if m and ("call" in ins.mnemonic or "jmp" in ins.mnemonic):
        return iat_api.get(int(m.group(1), 16), None)
    m = re.match(r"^0x([0-9a-f]+)$", ins.op_str)
    if m:
        return thunk_api.get(int(m.group(1), 16), None)
    return None

# ---- 1. map every api call site -------------------------------------------
api_sites = {}   # api -> [addrs]
for ins in insns:
    if ins.mnemonic not in ("call", "jmp"): continue
    a = resolve_call(ins)
    if a:
        api_sites.setdefault(a, []).append(ins.address)

for a in ("ScreenFlip", "ClearDrawScreen", "ProcessMessage", "DrawRotaGraph",
          "DrawModiGraph", "DrawTriangle", "SetDrawBlendMode", "GetMousePoint",
          "CheckHitKey", "DrawBox", "DrawString"):
    print(f"{a:18s} x{len(api_sites.get(a, [])):3d}: {[hex(x) for x in api_sites.get(a, [])[:8]]}")

# ---- 2. main loop candidates ----------------------------------------------
# ClearDrawScreen and ScreenFlip close together
cands = []
flips = api_sites.get("ScreenFlip", [])
clears = api_sites.get("ClearDrawScreen", [])
for f in flips:
    for c in clears:
        if 0 < f - c < 0x800:
            cands.append((c, f))
print("\nmain-loop candidates (ClearDrawScreen, ScreenFlip):", [(hex(c), hex(f)) for c, f in cands])

# ---- 3. "over drawing queue" xref ------------------------------------------
qstr = [va for va, s in strs.items() if "over drawing queue" in s]
print("\n'over drawing queue' string VAs:", [hex(v) for v in qstr])
for qv in qstr:
    for ins in insns:
        if f"0x{qv:x}" in ins.op_str or f"0x{qv:08x}" in ins.op_str.lower():
            i = idx_by_addr[ins.address]
            print(f"  xref @ {ins.address:#x}: {ins.mnemonic} {ins.op_str}")
            # show a window
            for w in insns[max(0,i-6):i+2]:
                print(f"    {w.address:08x}  {w.mnemonic} {w.op_str}")

# ---- 4. dump function windows around candidates ----------------------------
def dump_window(start_addr, back=0x100, fwd=0x400, label=""):
    print(f"\n===== {label} window @ {start_addr:#x} =====")
    i = idx_by_addr.get(start_addr)
    if i is None:
        # find nearest
        lo = max(0, back)
        for j, ins in enumerate(insns):
            if ins.address >= start_addr - back:
                i = j; break
    if i is None: return
    for w in insns[i:i+120]:
        ann = ""
        a = resolve_call(w)
        if a: ann = f"   ; <{a}>"
        for m in re.finditer(r"0x([0-9a-f]{6,8})", w.op_str):
            v = int(m.group(1), 16)
            if v in strs: ann += f'   ; "{strs[v][:48]}"'
        print(f"{w.address:08x}  {w.mnemonic:8s} {w.op_str}{ann}")

for c, f in cands[:2]:
    dump_window(c, back=0x30, fwd=0x400, label=f"mainloop clear@{c:#x}")

json.dump({k: [hex(x) for x in v] for k, v in api_sites.items()},
          open("/home/z/my-project/scripts/phase1b_api_sites.json", "w"), indent=1)
print("\nwrote phase1b_api_sites.json")
