#!/usr/bin/env python3
"""Phase 1b part 2: dump main loop + draw dispatcher + vtable of engine obj."""
import re, sys
from capstone import *
sys.path.insert(0, "/home/z/my-project/scripts")
from phase1_recon import PE, get_strings, build_thunk_map, EXE

pe = PE(EXE)
iats = pe.imports()
strs = get_strings(pe)
md = Cs(CS_ARCH_X86, CS_MODE_32)
thunks = build_thunk_map(pe, md)
thunk_api = {va: iats[iat].split("!")[-1].replace("_dx_", "").split("@")[0]
             for va, iat in thunks.items() if iat in iats}
iat_api = {iat: n.split("!")[-1].replace("_dx_", "").split("@")[0] for iat, n in iats.items()}

text = [s for s in pe.sections if s[0] == "_TEXT"][0]
nm, vma, vsize, roff, rsize = text
CODE = pe.data[roff:roff+rsize]
BASE = pe.imagebase + vma

def dump(start, end, label=""):
    print(f"\n===== {label} {start:#x}..{end:#x} =====")
    o = pe.va2off(start)
    for ins in md.disasm(pe.data[o:o+(end-start)], start):
        ann = ""
        if ins.mnemonic in ("call", "jmp"):
            m = re.match(r"^0x([0-9a-f]+)$", ins.op_str)
            if m:
                t = int(m.group(1), 16)
                if t in thunk_api: ann = f"   ; <{thunk_api[t]}>"
                else: ann = f"   ; fn_{t:x}"
            m = re.search(r"\[0x([0-9a-f]+)\]", ins.op_str)
            if m and "ptr" in ins.op_str:
                t = int(m.group(1), 16)
                if t in iat_api: ann = f"   ; <{iat_api[t]}>"
        for m in re.finditer(r"0x([0-9a-f]{6,8})\b", ins.op_str):
            v = int(m.group(1), 16)
            if v in strs: ann += f'   ; "{strs[v][:60]}"'
            elif 0x433000 <= v <= 0x437000 and pe.u32(v) and pe.u32(v) not in (0, 0xffffffff):
                pass  # vtable region hint
        print(f"{ins.address:08x}  {ins.mnemonic:8s} {ins.op_str}{ann}")

# main loop entire
dump(0x4065f0, 0x406730, "MAIN LOOP")
# the between-clear-and-flip call
dump(0x41051c, 0x4105cc, "DRAW DISPATCH (called between Clear+Flip)")
