'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { yauzl, crc32 } = require('./vendor/zip-reader');

const LIMITS = { downloadBytes: 1024 ** 3, fileBytes: 1024 ** 3,
    totalBytes: 4 * 1024 ** 3, entries: 200000, timeoutMs: 180000 };

function operationSignal(signal, timeoutMs) {
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    const timer = setTimeout(abort, timeoutMs);
    return { signal: ctl.signal, dispose() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); } };
}
function assertActive(signal) { if (signal.aborted) throw new Error('Pack operation cancelled or timed out'); }

// Download into a private temporary file; never leave a half-written destination.
// HTTPS-only, including redirects. pipeline handles source AND destination errors.
async function download(url, dest, onProgress, options = {}) {
    const limits = { ...LIMITS, ...options.limits };
    const op = operationSignal(options.signal, limits.timeoutMs);
    let temp;
    try {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        temp = await fs.promises.mkdtemp(path.join(path.dirname(dest), '.download-'));
        const partial = path.join(temp, 'payload');
        let current = new URL(url), response;
        for (let redirects = 0; ; redirects++) {
            assertActive(op.signal);
            if (current.protocol !== 'https:') throw new Error('Only HTTPS pack downloads are allowed');
            response = await new Promise((resolve, reject) => {
                const req = https.get(current, { headers: { 'User-Agent': 'pic-mdf' }, signal: op.signal }, resolve);
                req.once('error', reject);
                req.setTimeout(120000, () => req.destroy(new Error('Download inactivity timeout')));
            });
            const status = response.statusCode;
            if ([301,302,303,307,308].includes(status) && response.headers.location) {
                const location = response.headers.location;
                response.destroy();
                const next = new URL(location, current);
                if (redirects >= 5) throw new Error('Too many download redirects');
                current = next;
                continue;
            }
            if (status !== 200) { response.destroy(); throw new Error('HTTP ' + status); }
            break;
        }
        const total = Number(response.headers['content-length'] || 0);
        if (!Number.isSafeInteger(total) || total < 0 || total > limits.downloadBytes) {
            response.destroy(); throw new Error('Invalid or oversized download');
        }
        let received = 0;
        const counter = new Transform({ transform(chunk, encoding, done) {
            received += chunk.length;
            if (received > limits.downloadBytes) return done(new Error('Download size limit exceeded'));
            try { if (onProgress) onProgress(received, total); done(null, chunk); } catch (e) { done(e); }
        } });
        await pipeline(response, counter, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: op.signal });
        if (total && received !== total) throw new Error('Incomplete download');
        assertActive(op.signal);
        await fs.promises.rename(partial, dest);
        return { bytes: received, total };
    } finally {
        op.dispose();
        if (temp) await fs.promises.rm(temp, { recursive: true, force: true });
    }
}

// Yauzl reads ZIP entries lazily. Nothing from the archive is executed, and
// archive permissions/symlinks are not applied. Enforce portable filenames too.
function safeEntry(name, root) {
    if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/')) throw new Error('Unsafe ZIP path: ' + name);
    const parts = name.replace(/\/$/, '').split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
        throw new Error('Unsafe ZIP path: ' + name);
    }
    const result = path.resolve(root, ...parts);
    const relative = path.relative(root, result);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('ZIP path escapes destination');
    return result;
}
function nextEntry(zip) {
    return new Promise((resolve, reject) => {
        const clean = () => { zip.removeListener('entry', entry); zip.removeListener('end', end); zip.removeListener('error', error); };
        const entry = value => { clean(); resolve(value); };
        const end = () => { clean(); resolve(null); };
        const error = e => { clean(); reject(e); };
        zip.once('entry', entry); zip.once('end', end); zip.once('error', error);
        zip.readEntry();
    });
}
async function extract(atpackPath, destDir, options = {}) {
    const limits = { ...LIMITS, ...options.limits };
    const op = operationSignal(options.signal, limits.timeoutMs);
    let stage, zip, activeStream, archiveError, backup;
    const onAbort = () => { if (activeStream) activeStream.destroy(new Error('Pack extraction cancelled or timed out')); };
    op.signal.addEventListener('abort', onAbort);
    try {
        assertActive(op.signal);
        await fs.promises.mkdir(path.dirname(destDir), { recursive: true });
        stage = await fs.promises.mkdtemp(path.join(path.dirname(destDir), '.extract-'));
        zip = await new Promise((resolve, reject) => yauzl.open(atpackPath,
            { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
            (e, z) => e ? reject(e) : resolve(z)));
        zip.on('error', e => { archiveError = e; if (activeStream) activeStream.destroy(e); });
        let entries = 0, totalBytes = 0;
        const seen = new Set();
        for (;;) {
            assertActive(op.signal);
            if (archiveError) throw archiveError;
            const entry = await nextEntry(zip);
            if (!entry) break;
            if (++entries > limits.entries) throw new Error('ZIP entry count limit exceeded');
            const target = safeEntry(entry.fileName, stage);
            // Be conservative about case collisions even when unpacking on Linux.
            const key = path.relative(stage, target).toLowerCase();
            if (seen.has(key)) throw new Error('Duplicate ZIP path: ' + entry.fileName);
            seen.add(key);
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (mode && mode !== 0x8000 && mode !== 0x4000) throw new Error('ZIP links/special files are not supported');
            if (entry.isEncrypted()) throw new Error('Encrypted ZIP entries are not supported');
            totalBytes += entry.uncompressedSize;
            if (entry.uncompressedSize > limits.fileBytes || totalBytes > limits.totalBytes) throw new Error('ZIP extraction size limit exceeded');
            if (entry.fileName.endsWith('/')) {
                if (entry.uncompressedSize || entry.crc32 !== 0) throw new Error('Invalid ZIP directory entry');
                await fs.promises.mkdir(target, { recursive: true });
                continue;
            }
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            activeStream = await new Promise((resolve, reject) => zip.openReadStream(entry, (e, stream) => e ? reject(e) : resolve(stream)));
            let bytes = 0, crc = 0;
            const counter = new Transform({ transform(chunk, encoding, done) {
                bytes += chunk.length;
                if (bytes > entry.uncompressedSize || bytes > limits.fileBytes) return done(new Error('ZIP entry size mismatch'));
                crc = crc32.unsigned(chunk, crc);
                done(null, chunk);
            } });
            await pipeline(activeStream, counter, fs.createWriteStream(target, { flags: 'wx', mode: 0o644 }), { signal: op.signal });
            activeStream = null;
            if (bytes !== entry.uncompressedSize || crc !== entry.crc32) throw new Error('ZIP entry integrity check failed: ' + entry.fileName);
        }
        if (!entries) throw new Error('Empty pack archive');
        if (archiveError) throw archiveError;
        assertActive(op.signal);
        zip.close(); zip = null;
        // Publish only a fully verified archive. Preserve an existing version on failure.
        try {
            await fs.promises.lstat(destDir);
            backup = await fs.promises.mkdtemp(path.join(path.dirname(destDir), '.backup-'));
            await fs.promises.rename(destDir, path.join(backup, 'previous'));
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        try { await fs.promises.rename(stage, destDir); stage = null; }
        catch (e) { if (backup) await fs.promises.rename(path.join(backup, 'previous'), destDir); throw e; }
        if (backup) { await fs.promises.rm(backup, { recursive: true, force: true }); backup = null; }
        return true;
    } finally {
        op.dispose(); op.signal.removeEventListener('abort', onAbort);
        if (zip) zip.close();
        if (stage) await fs.promises.rm(stage, { recursive: true, force: true });
        // Never delete a backup if rollback failed: preserve recoverable data.
    }
}
module.exports = { download, extract };
