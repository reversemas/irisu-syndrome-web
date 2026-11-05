#!/usr/bin/env python3
"""Phase 1e: read D ClassInfo names for every vtable."""
import sys, struct
sys.path.insert(0, "/home/z/my-project/scripts")
from disx import pe, dump, func_end

VTS = [0x433044, 0x433584, 0x433864, 0x433c94, 0x434028, 0x434074, 0x434154,
       0x4342c4, 0x434588]

def rd_dstr(ptr, ln):
    if not ptr or ln is None or ln > 200 or ln == 0: return None
    b = pe.read(ptr, ln)
    return b.decode("latin1", errors="replace") if b else None

print("vtable      ClassInfo   init              name")
for vt in VTS:
    ci = pe.u32(vt - 4)
    if not ci:
        print(f"{vt:#x}   (no classinfo at -4)")
        continue
    # D1 ClassInfo: { void* init_ptr; int init_len; char* name_ptr; int name_len; ... }
    initp, initl, namep, namel = (pe.u32(ci+o) for o in (0, 4, 8, 12))
    name = rd_dstr(namep, namel)
    print(f"{vt:#x}  {ci:#x}  {initp:#x}/{initl:<4}  {name!r}")

# also walk backwards: any vtable we missed? scan wider with classinfo validation
print("\n--- wide scan 0x433000..0x435000 (validate via ClassInfo name ptr) ---")
va = 0x433000
found = []
while va < 0x435000:
    x = pe.u32(va)
    if x and 0x401000 <= x < 0x431a00:
        # potential vtable start; check classinfo at -4
        ci = pe.u32(va - 4)
        if ci and 0x433000 <= ci < 0x436000:
            namep, namel = pe.u32(ci+8), pe.u32(ci+12)
            nm = rd_dstr(namep, namel)
            if nm and all(32 <= ord(c) < 127 for c in nm):
                found.append((va, ci, nm))
    va += 4
for vt, ci, nm in found:
    print(f"VT {vt:#x} classinfo {ci:#x} name {nm!r}")
