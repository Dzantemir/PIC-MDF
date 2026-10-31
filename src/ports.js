'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ports.js — serial port detection (the sdcc-mdf/avr-mdf approach).
//   Windows: [System.IO.Ports.SerialPort]::GetPortNames()
//   Linux:   /dev pattern scan (ttyUSB / ttyACM / ttyS)
//   macOS:   cu.* / tty.* patterns incl. CP210x + CH340
// ─────────────────────────────────────────────────────────────────────────────
const cp   = require('child_process');
const fs   = require('fs');
const path = require('path');
const H    = require('./helpers');

const PORTS_CACHE_MS = 2500;
let _portsCache = null;

function detectPorts() {
    if (_portsCache && (Date.now() - _portsCache.at) < PORTS_CACHE_MS) {
        return _portsCache.list.slice();
    }
    const list = _scanPorts();
    _portsCache = { at: Date.now(), list };
    return list.slice();
}

function _scanPorts() {
    try {
        if (H.IS_WIN) {
            const out = cp.execSync(
                'powershell.exe -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames() -join \',\'"',
                { timeout: 5000, windowsHide: true }
            ).toString().trim();
            return out ? out.split(',').map(s => s.trim()).filter(Boolean) : [];
        }
        const devDir = '/dev';
        if (!fs.existsSync(devDir)) return [];
        const patterns = [
            /^ttyUSB\d+/, /^ttyACM\d+/, /^ttyS\d+/,
            /^tty\.usbserial/, /^tty\.usbmodem/,
            /^cu\.usbserial/, /^cu\.usbmodem/,
            /^cu\.SLAB_USBtoUART/, /^tty\.SLAB_USBtoUART/,
            /^cu\.wchusbserial/, /^tty\.wchusbserial/,
        ];
        return fs.readdirSync(devDir)
            .filter(n => patterns.some(p => p.test(n)))
            .map(n => path.join(devDir, n))
            .sort();
    } catch {
        return [];
    }
}

function list() { return Promise.resolve(detectPorts().map(id => ({ id }))); }

module.exports = { list, detectPorts };
