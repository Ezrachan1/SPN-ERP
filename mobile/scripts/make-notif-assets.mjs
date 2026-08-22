#!/usr/bin/env node
/**
 * Notification assets for the Android project (idempotent, run after `cap sync`):
 *  - res/raw/spn_<tone>.wav             the notification tones (synthesised: no licensing, tiny)
 *  - res/drawable-<dpi>/ic_stat_spn.png  the monochrome status-bar icon (leaf)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
if (!fs.existsSync(res)) { console.log('android/ not generated yet (run: npx cap add android)'); process.exit(0); }

/* ---- tones ---- */
const RATE = 22050;
function note(buf, freq, start, dur, gain, type = 'sine') {
  const s0 = Math.floor(start * RATE), n = Math.floor(dur * RATE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.min(1, i / (0.012 * RATE)) * Math.exp(-3.5 * t / dur);
    let v = Math.sin(2 * Math.PI * freq * t);
    if (type === 'square') v = v >= 0 ? 1 : -1;
    const idx = s0 + i;
    if (idx < buf.length) buf[idx] += v * env * gain;
  }
}
const TONES = {
  spn_chime: b => { note(b, 784, 0, 0.25, 0.5); note(b, 1175, 0.18, 0.5, 0.45); },
  spn_bell: b => { note(b, 880, 0, 0.9, 0.55); note(b, 1760, 0, 0.5, 0.22); note(b, 2640, 0, 0.3, 0.08); },
  spn_drip: b => { note(b, 1200, 0, 0.12, 0.55); note(b, 800, 0.1, 0.16, 0.4); },
  spn_soft: b => { note(b, 440, 0, 0.5, 0.35); note(b, 660, 0.2, 0.5, 0.25); },
  spn_alert: b => { note(b, 1046, 0, 0.12, 0.22, 'square'); note(b, 1046, 0.18, 0.12, 0.22, 'square'); note(b, 1318, 0.36, 0.22, 0.22, 'square'); },
};
function wav(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) { const v = Math.max(-1, Math.min(1, samples[i])); pcm.writeInt16LE(Math.round(v * 32767), i * 2); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const raw = path.join(res, 'raw'); fs.mkdirSync(raw, { recursive: true });
for (const [name, fn] of Object.entries(TONES)) {
  const buf = new Float64Array(Math.floor(RATE * 1.3)); fn(buf);
  fs.writeFileSync(path.join(raw, name + '.wav'), wav(buf));
}
console.log('tones written: ' + Object.keys(TONES).join(', '));

/* ---- status-bar icon (white leaf on transparent) ---- */
let sharp; try { sharp = require('sharp'); } catch (e) { console.log('sharp not installed: skipping ic_stat_spn'); process.exit(0); }
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#fff" d="M4 20C8 6 14 4 20 4c0 8-4 14-12 14H4z"/><path d="M5 19c4-6 8-9 12-11" stroke="#3a6b43" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`);
const sizes = { 'drawable-mdpi': 24, 'drawable-hdpi': 36, 'drawable-xhdpi': 48, 'drawable-xxhdpi': 72, 'drawable-xxxhdpi': 96 };
for (const [dir, px] of Object.entries(sizes)) {
  const d = path.join(res, dir); fs.mkdirSync(d, { recursive: true });
  await sharp(svg).resize(px, px).png().toFile(path.join(d, 'ic_stat_spn.png'));
}
console.log('ic_stat_spn written for ' + Object.keys(sizes).length + ' densities');
