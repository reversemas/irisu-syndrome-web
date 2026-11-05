#!/usr/bin/env python3
"""Full draw-queue flush fn + the 4 update/submit subsystem pairs."""
import sys
sys.path.insert(0, "/home/z/my-project/scripts")
from disx import dump, callers_of, func_end

# ---- full flush fn ----------------------------------------------------------
dump(0x41051c, 0x410730, "QUEUE FLUSH (complete)")

# ---- subsystem pair heads: find scene vtable calls inside -------------------
for label, pairs in {
    "PAIR A": (0x4074e0, 0x407528),
    "PAIR B": (0x404130, 0x404178),
    "PAIR C": (0x406cac, 0x406cf4),
    "PAIR D": (0x4031ec, 0x403234),
}.items():
    for fn in pairs:
        end = func_end(fn, 3000)
        print(f"\n##### {label} fn {fn:#x}..{end:#x} (size {end-fn:#x})")
        dump(fn, min(end, fn + 0x180), label=f"{label} head")
