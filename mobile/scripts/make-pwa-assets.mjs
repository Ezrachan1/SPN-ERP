#!/usr/bin/env node
/**
 * PWA icons for the web app (app/public/icons) from the SPN logo embedded in
 * index.html. Uses sharp from this folder's node_modules. Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(root, '..', 'app', 'public', 'index.html');
const out = path.resolve(root, '..', 'app', 'public', 'icons');
const html = fs.readFileSync(src, 'utf8');
const pngs = [...html.matchAll(/<img[^>]*src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map(m => m[1]);
if (!pngs.length) { console.error('No inline PNG logo found'); process.exit(1); }
const logo = Buffer.from(pngs.sort((a, b) => b.length - a.length)[0], 'base64');
const sharp = require('sharp');
fs.mkdirSync(out, { recursive: true });
const cream = { r: 245, g: 242, b: 232, alpha: 1 };
async function icon(size, logoSize, file) {
  const l = await sharp(logo).resize({ width: logoSize, height: logoSize, fit: 'inside' }).png().toBuffer();
  const m = await sharp(l).metadata();
  await sharp({ create: { width: size, height: size, channels: 4, background: cream } })
    .composite([{ input: l, left: Math.round((size - m.width) / 2), top: Math.round((size - m.height) / 2) }])
    .png().toFile(path.join(out, file));
  console.log('  ' + file);
}
await icon(192, 150, 'icon-192.png');
await icon(512, 400, 'icon-512.png');
await icon(512, 300, 'icon-maskable-512.png'); /* maskable: keep the logo in the safe zone */
console.log('PWA icons written to ' + out);
