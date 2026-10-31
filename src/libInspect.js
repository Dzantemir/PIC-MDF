'use strict';

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PREBUILT LIBRARY INSPECTOR  (pure Node — no `vscode` dependency)  ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// Shared by pic-mdf, avr-mdf and sdcc-mdf (the component editor's "Prebuilt
// libraries" section).  Answers, for one file, the questions that decide
// whether it can be linked into the project's firmware:
//
//   * is it a GNU `ar` archive (libfoo.a / libfoo.lib), a bare ELF object
//     (.o), or an SDCC ASxxxx relocatable (.rel — plain text)?
//   * does an archive carry a symbol index (GNU ld wants one)?
//   * does it target the project's CPU?
//       - ELF members: e_machine is compared with the machines the active
//         compiler produces (AVR = 83, dsPIC/PIC24 = 118, 8-bit PIC = 204,
//         MIPS = 8, ARM = 40);
//       - SDCC .rel members: the `O -m<port>` option line, when present.
//   * how big is it (text / data / bss), and which symbols stay undefined?
//
// The parser never executes or loads anything and is bounds-checked: a
// truncated or hostile file yields an error entry, not an exception.
//
//   inspectFile(file, expect) → info
//     expect = {
//        machines: number[]   // acceptable ELF e_machine values (omit = do not check)
//        label:    string     // human name of the target, e.g. "AVR"
//        sdccPorts: string[]  // acceptable SDCC ports (lower-case), e.g. ['stm8']
//     }
//     info = { format, fileSize, objects, hasIndex, arch, totals{text,data,bss},
//              definedCount, undefinedExternal[], members[], warnings[{level,text}],
//              verdict:'ok'|'warn'|'error', usable:boolean }

const fs = require('fs');

const AR_MAGIC      = '!<arch>\n';
const AR_THIN_MAGIC = '!<thin>\n';
const MAX_FILE      = 256 * 1024 * 1024;

const EM_NAMES = {
    0: 'none', 3: 'x86', 8: 'MIPS', 20: 'PowerPC', 40: 'ARM', 62: 'x86-64', 83: 'AVR',
    94: 'Xtensa', 105: 'MSP430', 118: 'dsPIC/PIC24', 183: 'AArch64', 204: 'PIC (8-bit)', 243: 'RISC-V',
};
const SHT = { NULL: 0, PROGBITS: 1, SYMTAB: 2, STRTAB: 3, NOBITS: 8 };
const SHF = { WRITE: 1, ALLOC: 2, EXEC: 4 };

// ─── ar container ───────────────────────────────────────────────────────────
function parseAr(buf) {
    const out = { kind: 'invalid', members: [], hasIndex: false, bsdIndex: false, errors: [] };
    if (!Buffer.isBuffer(buf) || buf.length < 8) { out.errors.push('File is too small to be an archive.'); return out; }
    const magic = buf.toString('latin1', 0, 8);
    if (magic === AR_THIN_MAGIC) { out.kind = 'thin'; return out; }
    if (magic !== AR_MAGIC) return out;
    out.kind = 'gnu';

    let off = 8;
    let longNames = null;
    while (off + 60 <= buf.length) {
        const hdr = buf.toString('latin1', off, off + 60);
        if (hdr.substr(58, 2) !== '`\n') { out.errors.push(`Corrupt archive member header at offset ${off}.`); break; }
        const rawName = hdr.substr(0, 16);
        const size = parseInt(hdr.substr(48, 10).trim(), 10);
        let dataOff = off + 60;
        if (!Number.isFinite(size) || size < 0 || dataOff + size > buf.length) {
            out.errors.push(`Archive is truncated (member at offset ${off} claims ${hdr.substr(48, 10).trim()} bytes).`);
            break;
        }
        let dataSize = size;
        let name = rawName.trimEnd();
        if (name === '/' || name === '/SYM64/') {
            out.hasIndex = true;
        } else if (name === '//') {
            longNames = buf.slice(dataOff, dataOff + size);
        } else if (name === '__.SYMDEF' || name === '__.SYMDEF SORTED' || name === '__.SYMDEF_64') {
            out.bsdIndex = true;
        } else {
            const longRef = /^\/(\d+)$/.exec(name);
            const bsdExt  = /^#1\/(\d+)$/.exec(name);
            if (longRef) {
                const nOff = parseInt(longRef[1], 10);
                if (longNames && nOff < longNames.length) {
                    let end = longNames.indexOf(0x0a, nOff);
                    if (end < 0) end = longNames.length;
                    name = longNames.toString('latin1', nOff, end).replace(/\/$/, '');
                } else name = rawName.trim();
            } else if (bsdExt) {
                const n = parseInt(bsdExt[1], 10);
                if (n <= size) {
                    name = buf.toString('latin1', dataOff, dataOff + n).replace(/\0+$/, '');
                    dataOff += n; dataSize = size - n;
                }
            } else name = name.replace(/\/$/, '');
            out.members.push({ name, offset: dataOff, size: dataSize });
        }
        off += 60 + size;
        if (off % 2) off++;
    }
    return out;
}

// ─── ELF32 little-endian relocatable ────────────────────────────────────────
function _cstr(b, off, limit) {
    if (off < 0 || off >= limit) return '';
    let e = off;
    while (e < limit && b[e] !== 0) e++;
    return b.toString('latin1', off, e);
}
function parseElf(b) {
    const r = { ok: false };
    if (!b || b.length < 52 || b.readUInt32BE(0) !== 0x7f454c46) { r.reason = 'not an ELF object'; return r; }
    // The machine id sits at the same offset for every class/endianness we may meet —
    // read it first so a foreign-CPU library is still reported with its name.
    const le = b[5] === 1;
    r.machine = le ? b.readUInt16LE(18) : b.readUInt16BE(18);
    if (b[4] !== 1) { r.reason = b[4] === 2 ? 'ELF64 object' : 'unknown ELF class'; r.foreign = true; return r; }
    if (!le) { r.reason = 'big-endian ELF object'; r.foreign = true; return r; }
    r.type = b.readUInt16LE(16);
    const shoff = b.readUInt32LE(32);
    const shentsize = b.readUInt16LE(46);
    const shnum = b.readUInt16LE(48);
    const shstrndx = b.readUInt16LE(50);
    r.sections = []; r.defined = []; r.undefinedSyms = [];
    if (shoff === 0 || shnum === 0 || shentsize < 40 || shoff + shnum * shentsize > b.length) {
        r.ok = true; r.noSections = true; return r;
    }
    const raw = [];
    for (let i = 0; i < shnum; i++) {
        const o = shoff + i * shentsize;
        raw.push({
            nameOff: b.readUInt32LE(o), type: b.readUInt32LE(o + 4), flags: b.readUInt32LE(o + 8),
            offset: b.readUInt32LE(o + 16), size: b.readUInt32LE(o + 20),
            link: b.readUInt32LE(o + 24), entsize: b.readUInt32LE(o + 36),
        });
    }
    let strOff = 0, strEnd = 0;
    if (shstrndx < raw.length && raw[shstrndx].type === SHT.STRTAB) {
        strOff = raw[shstrndx].offset; strEnd = Math.min(b.length, strOff + raw[shstrndx].size);
    }
    raw.forEach(s => { s.name = strEnd ? _cstr(b, strOff + s.nameOff, strEnd) : ''; });
    r.sections = raw.map(s => ({ name: s.name, type: s.type, flags: s.flags, size: s.size }));
    for (const s of raw) {
        if (s.type !== SHT.SYMTAB || s.entsize < 16 || s.link >= raw.length) continue;
        const str = raw[s.link];
        const sEnd = Math.min(b.length, str.offset + str.size);
        const n = Math.floor(Math.min(s.size, Math.max(0, b.length - s.offset)) / 16);
        for (let k = 1; k < n; k++) {
            const o = s.offset + k * 16;
            const nameIdx = b.readUInt32LE(o);
            const info = b[o + 12];
            const shndx = b.readUInt16LE(o + 14);
            const bind = info >> 4, stype = info & 15;
            if (nameIdx === 0 || stype === 3 || stype === 4) continue;
            if (bind !== 1 && bind !== 2) continue;
            const name = _cstr(b, str.offset + nameIdx, sEnd);
            if (!name) continue;
            if (shndx === 0) r.undefinedSyms.push({ name, weak: bind === 2 });
            else r.defined.push(name);
        }
    }
    r.ok = true;
    return r;
}
function _elfTotals(sections) {
    const t = { text: 0, data: 0, bss: 0, lto: false };
    for (const s of sections) {
        if (/^\.gnu\.lto_/.test(s.name)) t.lto = true;
        if (!(s.flags & SHF.ALLOC)) continue;
        if ((s.flags & SHF.EXEC) || !(s.flags & SHF.WRITE)) t.text += s.size;
        else if (s.type !== SHT.NOBITS) t.data += s.size;
        else t.bss += s.size;
    }
    return t;
}

// ─── SDCC ASxxxx relocatable (.rel — text) ──────────────────────────────────
// XH2 / XL3 …            radix / endianness / address-size marker
// H 4 areas 12 global symbols
// M module_name
// O -mstm8 --model-large   (command-line options of the compile; optional)
// S _foo Def0000 / S _bar Ref0000
// A _CODE size 1A flags 0 addr 0
function looksLikeRel(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
    const head = buf.toString('latin1', 0, Math.min(buf.length, 4096));
    const nl = head.search(/\r?\n/);
    if (nl < 0) return false;
    // the first line is the radix/endian marker (XH2, XL3 …); a module/header line must follow
    return /^X[A-Z]{1,3}\d?\s*$/.test(head.slice(0, nl)) && /\n[MHA] /.test(head);
}
function parseRel(buf) {
    const r = { ok: true, modules: [], ports: new Set(), defined: [], undefinedSyms: [], size: 0, codeSize: 0, options: [] };
    const text = buf.toString('latin1');
    const lines = text.split(/\r?\n/);
    if (!lines.length || !/^X[A-Z]/.test(lines[0])) { r.ok = false; r.reason = 'not an ASxxxx .rel file'; return r; }
    const radix = ({ H: 16, D: 10, Q: 8 })[lines[0][1]] || 16;
    const defd = new Set(), refd = new Set();
    for (const ln of lines) {
        const c = ln[0];
        if (c === 'M' && ln[1] === ' ') r.modules.push(ln.slice(2).trim());
        else if (c === 'O' && ln[1] === ' ') {
            r.options.push(ln.slice(2).trim());
            for (const m of ln.matchAll(/(?:^|\s)-m([A-Za-z0-9_+-]+)/g)) r.ports.add(m[1].toLowerCase());
        } else if (c === 'S' && ln[1] === ' ') {
            const m = /^S\s+(\S+)\s+(Def|Ref)([0-9A-Fa-f]*)/.exec(ln);
            if (m) { if (m[2] === 'Def') defd.add(m[1]); else refd.add(m[1]); }
        } else if (c === 'A' && ln[1] === ' ') {
            const m = /^A\s+(\S+)\s+size\s+([0-9A-Fa-f]+)/.exec(ln);
            if (m) {
                const n = parseInt(m[2], radix);
                if (Number.isFinite(n)) {
                    r.size += n;
                    if (/^_?(CODE|HOME|GSINIT|GSFINAL|CABS|XINIT|CONST|RODATA|INITIALIZER)/i.test(m[1])) r.codeSize += n;
                }
            }
        }
    }
    r.defined = [...defd];
    r.undefinedSyms = [...refd].filter(s => !defd.has(s)).map(name => ({ name, weak: false }));
    return r;
}

// ─── judge ──────────────────────────────────────────────────────────────────
function _fmt(n) { return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`; }
function _empty(format) {
    return {
        format, fileSize: 0, objects: 0, hasIndex: false, arch: '',
        totals: { text: 0, data: 0, bss: 0 }, definedCount: 0, undefinedExternal: [], members: [],
        warnings: [], verdict: 'ok', usable: true,
    };
}
function _finish(res) {
    const hasErr = res.warnings.some(w => w.level === 'error');
    const hasWarn = res.warnings.some(w => w.level === 'warn');
    res.verdict = hasErr ? 'error' : hasWarn ? 'warn' : 'ok';
    res.usable = !hasErr;
    return res;
}

function _judgeMachines(res, W, machines, expect) {
    const ids = [...machines.keys()];
    res.arch = ids.map(id => EM_NAMES[id] || `machine ${id}`).join(', ');
    if (!expect || !Array.isArray(expect.machines) || !expect.machines.length) return;
    const label = expect.label || 'the project MCU';
    const wrong = ids.filter(id => !expect.machines.includes(id));
    if (!wrong.length) return;
    const known = wrong.filter(id => EM_NAMES[id] && id !== 0);
    if (known.length) {
        W('error', `Built for the wrong CPU: ${known.map(id => EM_NAMES[id]).join(', ')} — this project targets ${label} (expected machine ${expect.machines.map(id => EM_NAMES[id] || id).join(' / ')}).`);
    }
    const unknown = wrong.filter(id => !known.includes(id));
    if (unknown.length) {
        W('warn', `Unrecognised ELF machine ${unknown.join(', ')} — could not verify that this library targets ${label}.`);
    }
}

function inspectBuffer(buf, expect, nameHint) {
    expect = expect || {};
    const ext = String(nameHint || '').toLowerCase();
    // ── ar archive ──
    const magic = buf.length >= 8 ? buf.toString('latin1', 0, 8) : '';
    if (magic === AR_MAGIC || magic === AR_THIN_MAGIC) return _inspectArchive(buf, expect);
    // ── bare ELF object ──
    if (buf.length >= 4 && buf.readUInt32BE(0) === 0x7f454c46) {
        const res = _empty('elf');
        const W = (level, text) => res.warnings.push({ level, text });
        const elf = parseElf(buf);
        const machines = new Map();
        if (elf.machine !== undefined) machines.set(elf.machine, 1);
        if (elf.ok) {
            res.objects = 1;
            const t = _elfTotals(elf.sections); res.totals = { text: t.text, data: t.data, bss: t.bss };
            res.definedCount = elf.defined.length;
            res.undefinedExternal = elf.undefinedSyms.map(s => s.name).sort();
            if (elf.type !== 1) W('warn', 'The object is not relocatable (ET_REL) and cannot be linked.');
        } else W('warn', `${elf.reason} — details cannot be read.`);
        _judgeMachines(res, W, machines, expect);
        return _finish(res);
    }
    // ── SDCC .rel ──
    if (looksLikeRel(buf)) return _inspectRel(buf, expect);
    const res = _empty('invalid');
    res.warnings.push({
        level: 'error',
        text: ext.endsWith('.rel') ? 'Not an ASxxxx .rel object (the first line should be "XH2" / "XL2" …).'
            : 'Not a recognised library: expected a GNU ar archive ("!<arch>"), an ELF object or an SDCC .rel file.',
    });
    return _finish(res);
}

function _inspectArchive(buf, expect) {
    const res = _empty('ar');
    const W = (level, text) => res.warnings.push({ level, text });
    const ar = parseAr(buf);
    res.hasIndex = ar.hasIndex;
    for (const e of ar.errors) W('error', e);
    if (ar.kind === 'thin') {
        res.format = 'thin';
        W('error', 'This is a "thin" archive (it only references other files). Create a normal one with `ar rcs`.');
        return _finish(res);
    }
    if (ar.bsdIndex) W('error', 'This archive was made by a BSD/macOS archiver (__.SYMDEF index). Re-create it with the compiler\'s own `ar`.');
    if (ar.members.length === 0 && !ar.errors.length) W('error', 'The archive contains no object files.');

    const machines = new Map();
    const ports = new Set();
    const definedAll = new Set(), undefAll = new Set();
    let nonObj = 0, notRel = 0, lto = 0, elfObjs = 0, relObjs = 0, noPort = 0;
    const nonObjNames = [];
    for (const m of ar.members) {
        const slice = buf.slice(m.offset, m.offset + m.size);
        let handled = false;
        if (slice.length >= 4 && slice.readUInt32BE(0) === 0x7f454c46) {
            const elf = parseElf(slice);
            if (elf.machine !== undefined) machines.set(elf.machine, (machines.get(elf.machine) || 0) + 1);
            if (elf.ok) {
                elfObjs++; res.objects++;
                if (elf.type !== 1) notRel++;
                const t = _elfTotals(elf.sections);
                if (t.lto) lto++;
                res.totals.text += t.text; res.totals.data += t.data; res.totals.bss += t.bss;
                elf.defined.forEach(s => definedAll.add(s));
                elf.undefinedSyms.forEach(s => undefAll.add(s.name));
                res.members.push({ name: m.name, size: m.size, text: t.text, data: t.data, bss: t.bss, machine: elf.machine });
            } else {
                nonObj++; if (nonObjNames.length < 3) nonObjNames.push(m.name);
            }
            handled = true;
        } else if (looksLikeRel(slice)) {
            const rel = parseRel(slice);
            if (rel.ok) {
                relObjs++; res.objects++;
                rel.ports.forEach(p => ports.add(p));
                if (!rel.ports.size) noPort++;
                res.totals.text += rel.codeSize; res.totals.data += Math.max(0, rel.size - rel.codeSize);
                rel.defined.forEach(s => definedAll.add(s));
                rel.undefinedSyms.forEach(s => undefAll.add(s.name));
                res.members.push({ name: m.name, size: m.size, text: rel.codeSize, data: Math.max(0, rel.size - rel.codeSize), bss: 0, port: [...rel.ports].join(',') });
                handled = true;
            }
        }
        if (!handled) { nonObj++; if (nonObjNames.length < 3) nonObjNames.push(m.name); }
    }
    res.definedCount = definedAll.size;
    res.undefinedExternal = [...undefAll].filter(s => !definedAll.has(s)).sort();
    if (ar.members.length && !ar.hasIndex && !ar.bsdIndex && elfObjs) {
        W('error', 'The archive has no symbol index — GNU ld fails with "archive has no index; run ranlib". Run `ranlib` (or `ar -s`) on it first.');
    }
    if (elfObjs) _judgeMachines(res, W, machines, expect);
    if (relObjs) {
        res.arch = [res.arch, ports.size ? `SDCC ${[...ports].join('/')}` : ''].filter(Boolean).join(', ');
        if (Array.isArray(expect.sdccPorts) && expect.sdccPorts.length) {
            const bad = [...ports].filter(p => !expect.sdccPorts.includes(p));
            if (bad.length) W('error', `Built for SDCC port "${bad.join('", "')}" — this project targets ${expect.label || expect.sdccPorts.join('/')}.`);
            else if (noPort && !ports.size) W('info', 'The objects carry no architecture marker (no "O -m<port>" line) — the port could not be verified.');
        }
    }
    if (elfObjs && relObjs) W('warn', 'The archive mixes ELF and SDCC .rel objects.');
    if (nonObj) W('warn', `${nonObj} archive member(s) are not recognised object files (${nonObjNames.join(', ')}${nonObj > nonObjNames.length ? ', …' : ''}).`);
    if (notRel) W('warn', `${notRel} member(s) are not relocatable objects (ET_REL) and cannot be linked.`);
    if (lto) W('warn', `${lto} object(s) contain GCC LTO bytecode — they link only with the same compiler version and -flto at the final link. Rebuild the library without -flto.`);
    return _finish(res);
}

function _inspectRel(buf, expect) {
    const res = _empty('rel');
    const W = (level, text) => res.warnings.push({ level, text });
    const rel = parseRel(buf);
    if (!rel.ok) { W('error', rel.reason); return _finish(res); }
    res.objects = 1;
    res.totals = { text: rel.codeSize, data: Math.max(0, rel.size - rel.codeSize), bss: 0 };
    res.definedCount = rel.defined.length;
    res.undefinedExternal = rel.undefinedSyms.map(s => s.name).sort();
    res.arch = rel.ports.size ? `SDCC ${[...rel.ports].join('/')}` : '';
    res.members.push({ name: rel.modules[0] || '', size: buf.length, text: rel.codeSize, data: res.totals.data, bss: 0, port: [...rel.ports].join(',') });
    if (Array.isArray(expect.sdccPorts) && expect.sdccPorts.length) {
        if (rel.ports.size) {
            const bad = [...rel.ports].filter(p => !expect.sdccPorts.includes(p));
            if (bad.length) W('error', `Built for SDCC port "${bad.join('", "')}" — this project targets ${expect.label || expect.sdccPorts.join('/')}.`);
        } else W('info', 'No architecture marker (no "O -m<port>" line) — the port could not be verified.');
    }
    return _finish(res);
}

function inspectFile(file, expect) {
    let buf;
    try {
        const st = fs.statSync(file);
        if (!st.isFile()) throw new Error('not a regular file');
        if (st.size > MAX_FILE) throw new Error(`file is too large (${_fmt(st.size)})`);
        buf = fs.readFileSync(file);
    } catch (e) {
        const res = _empty('invalid');
        res.warnings.push({ level: 'error', text: `Cannot read the file: ${e.message}` });
        return _finish(res);
    }
    const res = inspectBuffer(buf, expect, file);
    res.fileSize = buf.length;
    return res;
}

module.exports = { parseAr, parseElf, parseRel, inspectBuffer, inspectFile, EM_NAMES };
