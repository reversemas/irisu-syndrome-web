#!/usr/bin/env python3
"""Phase 1d: queue submit API + enumerate all class vtables."""
import re, sys, struct
sys.path.insert(0, "/home/z/my-project/scripts")
from disx import dump, callers_of, func_end, INSNS, pe, strs, fmt, IDX

# ---- 1. submit API family ---------------------------------------------------
dump(0x410000, 0x41051c, "QUEUE SUBMIT API REGION")

# ---- 2. enumerate vtables in .data -----------------------------------------
print("\n\n===== VTABLE SCAN (0x433000..0x434800) =====")
va = 0x433000
vtables = []
while va < 0x434800:
    # a vtable = run of >=6 dwords all pointing into _TEXT (0x401000..0x431a00)
    run = []
    v = va
    while True:
        x = pe.u32(v)
        if x and 0x401000 <= x < 0x431a00:
            run.append(x); v += 4
        else:
            break
    if len(run) >= 6:
        vtables.append((va, run))
        va = v
    else:
        va += 4
for vtva, run in vtables:
    # skip if this is inside a previous run already consumed
    print(f"VT {vtva:#x}  slots={len(run)}  +18={run[6]:#x} +1c={run[7]:#x} +24={run[9]:#x} +30={run[12]:#x}" if len(run) >= 13 else f"VT {vtva:#x}  slots={len(run)}")

# ---- 3. callers of the rota submit 0x410278 --------------------------------
print("\n\n===== callers of 0x410278 (rota submit) =====")
cs = callers_of(0x410278)
print(f"{len(cs)} call sites")

# ---- 4. callers of other likely submits: check small fns 0x410000..0x41051c
for fn in (0x410278, 0x4102c4, 0x410300, 0x410340, 0x410380, 0x4103c0, 0x410400, 0x410440, 0x410480):
    try:
        cs = callers_of(fn)
        if cs:
            print(f"fn_{fn:x}: {len(cs)} callers")
    except Exception:
        pass
