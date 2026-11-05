#!/usr/bin/env python3
"""Phase 1f: REAL ScenePlay vtable + class hierarchy + update/submit disasm."""
import sys
sys.path.insert(0, "/home/z/my-project/scripts")
from disx import pe, dump, func_end

def dstr(p, l):
    if not p or not l or l > 200: return None
    b = pe.read(p, l)
    try: return b.decode("latin1")
    except: return None

def ci_info(ci):
    l, p = pe.u32(ci+0x10), pe.u32(ci+0x14)
    base = pe.u32(ci+0x28)
    return dstr(p, l), base

# ---- class hierarchy --------------------------------------------------------
print("=== class hierarchy ===")
CIS = [0x432340, 0x432660, 0x432df0, 0x432f40, 0x432ff0, 0x433530, 0x433810,
       0x433c40, 0x433d80, 0x434100, 0x434270, 0x4347d0, 0x434cd0, 0x435bc0,
       0x436010, 0x436440]
for ci in CIS:
    name, base = ci_info(ci)
    bname = ci_info(base)[0] if base and 0x432000 <= base < 0x437000 else None
    vt = pe.u32(ci+0x1c)
    print(f"  {name:32} CI {ci:#x}  vt {vt:#x}  base {bname}")

# ---- ScenePlay vtable slots -------------------------------------------------
VT = 0x434820  # stored vtable pointer (slot0 = ClassInfo)
print("\n=== ScenePlay vtable @ 0x434820 (dispatch base) ===")
slots = {}
for i in range(29):
    t = pe.u32(VT + 4*i)
    slots[4*i] = t
    print(f"  [{4*i:#04x}] m{i:<2} = {t:#x}")

# ---- disassemble key slots --------------------------------------------------
# update +0x24, submit +0x30, ctor/dispose +0x18, +0x1c
for off in (0x18, 0x1c, 0x24, 0x30):
    t = slots.get(off)
    if not t or not (0x401000 <= t < 0x431a00):
        print(f"\n[slot {off:#x}] = {t} (not code)")
        continue
    end = func_end(t, 8000)
    print(f"\n\n########## ScenePlay slot {off:#x} = {t:#x}..{end:#x} (size {end-t:#x})")
    dump(t, min(end, t + 0x200), f"ScenePlay slot {off:#x}")
