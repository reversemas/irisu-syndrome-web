#!/usr/bin/env python3
"""Phase 1c: ScenePlay slot disasm + constructor + queue submit fn."""
import re, sys
sys.path.insert(0, "/home/z/my-project/scripts")
from disx import dump, callers_of, func_end, INSNS, pe, strs, fmt

# ---- who references the ScenePlay vtable 0x433580? --------------------------
print("=== refs to ScenePlay vtable 0x433580 ===")
for ins in INSNS:
    if "0x433580" in ins.op_str:
        i = INSNS.index(ins)
        for w in INSNS[max(0,i-4):i+3]:
            print("  " + fmt(w))
        print("  ---")

# ---- queue submit fn: refs to "over drawing queue" 0x43624f & writes 0x442830
print("\n=== refs to 0x43624f / 0x442830 / 0x4427f0 ===")
for ins in INSNS:
    if "0x43624f" in ins.op_str or "0x442830" in ins.op_str or "0x4427f0" in ins.op_str:
        print("  " + fmt(ins))

# ---- ScenePlay slots ---------------------------------------------------------
for name, va in [("+0x18 isRunning?", 0x406d68),
                 ("+0x24 UPDATE", 0x4077c4),
                 ("+0x30 DRAW", 0x406df0),
                 ("+0x28", 0x407814),
                 ("+0x2c", 0x40781c)]:
    end = func_end(va, 6000)
    print(f"\n\n########## ScenePlay::{name} {va:#x}..{end:#x} (size {end-va:#x})")
    dump(va, min(end, va + 0x300), f"slot {name}")
