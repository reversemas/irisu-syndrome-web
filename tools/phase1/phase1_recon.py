#!/usr/bin/env python3
"""Phase 1 recon: annotate irisu.exe disassembly with DxLib API names + strings.

Parses the PE by hand (no pefile), builds an IAT address -> DLL!name map,
disassembles given addresses with capstone, and annotates:
  - calls through the import table (DxLib draw/load APIs)
  - immediate operands that point at ASCII/SJIS strings
Outputs a markdown report.
"""
import struct, sys, re, json
from capstone import *

EXE = "/home/z/my-project/irisu-syndrome-web/reference/game/irisu.exe"

class PE:
    def __init__(self, path):
        self.data = open(path, "rb").read()
        d = self.data
        e_lfanew = struct.unpack_from("<I", d, 0x3C)[0]
        assert d[e_lfanew:e_lfanew+4] == b"PE\x00\x00"
        coff = e_lfanew + 4
        machine, nsec, _, _, _, optsize, _ = struct.unpack_from("<HHIIIHH", d, coff)
        opt = coff + 20
        self.imagebase = struct.unpack_from("<I", d, opt + 28)[0]
        ndd = struct.unpack_from("<I", d, opt + 92)[0]
        ddoff = opt + 96
        dd = [(struct.unpack_from("<I", d, ddoff + 8*i)[0],
               struct.unpack_from("<I", d, ddoff + 8*i + 4)[0]) for i in range(ndd)]
        self.import_dir = dd[1]   # (rva, size)
        self.sections = []
        so = coff + 20 + optsize
        for i in range(nsec):
            nm = d[so:so+8].rstrip(b"\x00").decode()
            vsize, vma, rsize, roff = struct.unpack_from("<IIII", d, so+8)
            self.sections.append((nm, vma, vsize, roff, rsize))
            so += 40

    def va2off(self, va):
        rva = va - self.imagebase
        for nm, vma, vsize, roff, rsize in self.sections:
            if vma <= rva < vma + max(vsize, rsize):
                o = roff + (rva - vma)
                if o < len(self.data):
                    return o
        return None

    def read(self, va, n):
        o = self.va2off(va)
        return None if o is None else self.data[o:o+n]

    def u32(self, va):
        b = self.read(va, 4)
        return struct.unpack("<I", b)[0] if b else None

    def imports(self):
        """map: iat_va -> 'DLL!name'"""
        iats = {}
        rva, size = self.import_dir
        if not rva: return iats
        va = self.imagebase + rva
        while True:
            o = self.va2off(va)
            if o is None: break
            oft, ts, fc, nRVA, fRVA = struct.unpack_from("<IIIII", self.data, o)
            if nRVA == 0: break
            no = self.va2off(self.imagebase + nRVA)
            end = self.data.index(b"\x00", no)
            dll = self.data[no:end].decode("latin1")
            # walk IAT
            tva = self.imagebase + fRVA
            i = 0
            while True:
                v = self.u32(tva + 4*i)
                if v in (0, None): break
                if v & 0x80000000:
                    name = f"ordinal_{v & 0xFFFF}"
                else:
                    so_ = self.va2off(self.imagebase + v)
                    end2 = self.data.index(b"\x00", so_ + 2)
                    name = self.data[so_+2:end2].decode("latin1")
                iats[tva + 4*i] = f"{dll}!{name}"
                i += 1
            va += 20
        return iats

def get_strings(pe, minlen=4):
    """VA -> string for printable ASCII runs inside data sections."""
    strs = {}
    for nm, vma, vsize, roff, rsize in pe.sections:
        if nm in ("_TEXT", ".rsrc", ".reloc", ".debug"): continue
        blob = pe.data[roff:roff+rsize]
        for m in re.finditer(rb"[\x20-\x7e]{%d,}" % minlen, blob):
            va = pe.imagebase + vma + m.start()
            strs[va] = m.group().decode("latin1")
    return strs

def disasm(pe, md, start, count=400, iats=None, strs=None, thunks=None):
    o = pe.va2off(start)
    code = pe.data[o:o+count*8]
    out = []
    for ins in md.disasm(code, start):
        line = f"{ins.address:08x}  {ins.mnemonic} {ins.op_str}"
        # annotate IAT calls
        if ins.mnemonic in ("call", "jmp"):
            m = re.search(r"0x([0-9a-f]+)", ins.op_str)
            if m and "ptr" in ins.op_str:
                addr = int(m.group(1), 16)
                if iats and addr in iats:
                    line += f"   ; -> {iats[addr]}"
            elif m and ins.mnemonic == "call":
                t = int(m.group(1), 16)
                line += f"   ; sub_{t:x}"
                if thunks and t in thunks:
                    nm = (iats or {}).get(thunks[t])
                    if nm:
                        line += f" -> {nm}"
        for m in re.finditer(r"0x([0-9a-f]{6,8})", ins.op_str):
            addr = int(m.group(1), 16)
            if strs and addr in strs:
                s = strs[addr][:60]
                line += f'   ; "{s}"'
            elif iats and addr in iats:
                line += f"   ; IAT {iats[addr]}"
        out.append(line)
        if len(out) >= count: break
        if ins.mnemonic == "ret" and count < 100000: pass
    return out

def build_thunk_map(pe, md):
    """va of 'jmp dword ptr [IAT]' -> IAT name (DMD import thunks)."""
    thunks = {}
    for nmn, vma, vsize, roff, rsize in pe.sections:
        if nmn != "_TEXT": continue
        for ins in md.disasm(pe.data[roff:roff+rsize], pe.imagebase + vma):
            if ins.mnemonic == "jmp":
                m = re.search(r"\[0x([0-9a-f]+)\]", ins.op_str)
                if m:
                    thunks[ins.address] = int(m.group(1), 16)
    return thunks

def summarize_calls(lines):
    """count DxLib API usage"""
    calls = {}
    for l in lines:
        m = re.search(r"; -> ([^!]+)!(\w+)", l)
        if m:
            calls[m.group(2)] = calls.get(m.group(2), 0) + 1
    return calls

def main():
    pe = PE(EXE)
    iats = pe.imports()
    strs = get_strings(pe)
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = False
    thunk_iats = build_thunk_map(pe, md)
    print(f"thunk jmps resolved: {len(thunk_iats)}")

    print(f"imagebase 0x{pe.imagebase:x}, imports: {len(iats)}")
    dlls = {}
    for v, n in iats.items():
        d = n.split("!")[0]
        dlls[d] = dlls.get(d, 0) + 1
    print("per-DLL import counts:", json.dumps(dlls, indent=1))

    # ScenePlay vtable @ 0x433580 — dump slots and disassemble each head
    VT = 0x433580
    print(f"\n=== ScenePlay vtable @ 0x{VT:x} ===")
    slots = []
    for i in range(18):
        t = pe.u32(VT + 4*i)
        slots.append(t)
        print(f"slot {i:2d} (+{4*i:#04x}): 0x{t:08x}" if t else f"slot {i}: ?")

    report = ["# Phase 1 recon — ScenePlay vtable DxLib usage", ""]
    for i, t in enumerate(slots):
        if not t or not (0x401000 <= t < 0x432000): continue
        lines = disasm(pe, md, t, 500, iats, strs, thunk_iats)
        calls = summarize_calls(lines)
        report.append(f"## slot {i} @ 0x{t:08x} (+{4*i:#x})")
        report.append(f"DxLib calls: {json.dumps(calls)}")
        report.append("```")
        report.extend(lines[:40])
        report.append("```")
        report.append("")
    open("/home/z/my-project/scripts/sceneplay_vtable_report.md", "w").write("\n".join(report))
    print("\nwrote sceneplay_vtable_report.md")

    # Full-text scan: LoadGraph / LoadDivGraph call sites + string args
    print("\n=== scan whole _TEXT for DxLib load/draw call sites ===")
    text_sec = [s for s in pe.sections if s[0] == "_TEXT"][0]
    nm, vma, vsize, roff, rsize = text_sec
    code = pe.data[roff:roff+rsize]
    interesting = ("LoadGraph", "LoadDivGraph", "DrawRotaGraph", "DrawModiGraph",
                   "DrawTriangle", "DrawString", "DrawBox", "DerivationGraph",
                   "SetDrawBlendMode", "SetDrawBright", "PlaySoundMem",
                   "LoadSoundMem", "GetGraphSize", "SetFontSize", "DrawCircle")
    # first pass: disassemble linearly, note call→IAT and preceding push imm
    sites = []
    insns = list(md.disasm(code, pe.imagebase + vma))
    print(f"total instructions in _TEXT: {len(insns)}")

    def resolve_call(ins):
        m = re.search(r"\[0x([0-9a-f]+)\]", ins.op_str)
        if m:  # direct IAT call
            return iats.get(int(m.group(1), 16), "")
        m = re.search(r"^0x([0-9a-f]+)$", ins.op_str)
        if m:  # call to import thunk
            return iats.get(thunk_iats.get(int(m.group(1), 16), 0), "")
        return ""

    for idx, ins in enumerate(insns):
        if ins.mnemonic != "call": continue
        full = resolve_call(ins)
        if "!" not in full: continue
        fname = full.split("!")[-1]
        if fname.startswith("_dx_"): fname = fname[4:]
        if fname in interesting:
            # look back for pushed immediates
            pushes = []
            for j in range(idx-1, max(0, idx-12), -1):
                p = insns[j]
                if p.mnemonic == "push" and "0x" in p.op_str:
                    v = int(p.op_str.replace("0x", ""), 16)
                    s = strs.get(v)
                    pushes.append(hex(v) + (f' ("{s}")' if s else ""))
                if p.mnemonic in ("call",): break
            sites.append((ins.address, fname, pushes))
    for addr, fname, pushes in sites:
        print(f"{addr:08x} {fname:20s} args: {', '.join(pushes[:4])}")
    print(f"\n{len(sites)} interesting call sites; full list in console")

if __name__ == "__main__":
    main()
