#!/usr/bin/env python3
"""Phase 1g: who is the engine @0x4428a4; ScenePlay instantiation; full region dump."""
import re, sys
sys.path.insert(0, "/home/z/my-project/scripts")
from disx import dump, callers_of, func_end, INSNS, pe, strs, fmt, IDX

# ---- writes/reads of 0x4428a4 and 0x4428a0 ---------------------------------
for g in (0x4428a4, 0x4428a0, 0x4428e4):
    print(f"=== refs to {g:#x} ===")
    for ins in INSNS:
        if f"0x{g:x}" in ins.op_str:
            print("  " + fmt(ins))

# ---- refs to ScenePlay ClassInfo 0x4347d0 (D new) ---------------------------
print("\n=== refs to ScenePlay ClassInfo 0x4347d0 ===")
for ins in INSNS:
    if "0x4347d0" in ins.op_str:
        i = IDX[ins.address]
        print("  ---")
        for w in INSNS[max(0,i-6):i+4]:
            print("  " + fmt(w))
