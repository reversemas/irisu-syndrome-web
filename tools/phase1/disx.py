#!/usr/bin/env python3
"""Shared disassembly helper for phase1 analysis."""
import re, sys, struct
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
# reverse: wrapper/thunk va -> api name for quick lookup
api_by_va = dict(thunk_api)

_text = [s for s in pe.sections if s[0] == "_TEXT"][0]
_nm, _vma, _vsize, _roff, _rsize = _text
INSNS = list(md.disasm(pe.data[_roff:_roff+_rsize], pe.imagebase + _vma))
IDX = {ins.address: i for i, ins in enumerate(INSNS)}


def fmt(ins):
    ann = ""
    if ins.mnemonic in ("call", "jmp"):
        m = re.match(r"^0x([0-9a-f]+)$", ins.op_str)
        if m:
            t = int(m.group(1), 16)
            ann = f"   ; <{thunk_api[t]}>" if t in thunk_api else f"   ; fn_{t:x}"
        else:
            m = re.search(r"\[0x([0-9a-f]+)\]", ins.op_str)
            if m and "ptr" in ins.op_str:
                t = int(m.group(1), 16)
                if t in iat_api: ann = f"   ; <{iat_api[t]}>"
    for m in re.finditer(r"0x([0-9a-f]{6,8})\b", ins.op_str):
        v = int(m.group(1), 16)
        if v in strs: ann += f'   ; "{strs[v][:56]}"'
    return f"{ins.address:08x}  {ins.mnemonic:8s} {ins.op_str}{ann}"


def dump(start, end, label=""):
    print(f"\n===== {label} {start:#x}..{end:#x} =====")
    o = pe.va2off(start)
    if o is None:
        print("  <bad range>")
        return
    for ins in md.disasm(pe.data[o:o+(end-start)], start):
        print(fmt(ins))


def callers_of(target):
    """VAs of direct call/jmp sites to target."""
    res = []
    for ins in INSNS:
        if ins.mnemonic in ("call", "jmp"):
            m = re.match(r"^0x([0-9a-f]+)$", ins.op_str)
            if m and int(m.group(1), 16) == target:
                res.append(ins.address)
    return res


def func_end(start, max_insn=4000):
    """Approximate end of function: first ret at depth 0 after prologue."""
    i = IDX.get(start)
    if i is None: return start + 0x100
    depth = 0
    for j in range(i, min(i+max_insn, len(INSNS))):
        ins = INSNS[j]
        if ins.mnemonic in ("ret",): return ins.address + 1
    return INSNS[min(i+max_insn, len(INSNS))-1].address


def dstr(va):
    """Read a D string literal: (len, ptr) pair at va."""
    n = pe.u32(va); p = pe.u32(va+4)
    if n is None or p is None or n > 256: return None
    b = pe.read(p, n)
    return b.decode("latin1", errors="replace") if b else None
