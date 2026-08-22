#!/usr/bin/env node
/**
 * Creates assets/icon*.png and assets/splash*.png for @capacitor/assets from the
 * SPN logo embedded in the web app (the largest inline PNG <img> in index.html).
 * Run via `npm run assets`, which then calls `capacitor-assets generate --android`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'spn-mobile.config.json'), 'utf8'));
const src = path.resolve(root, cfg.source || '../app/public/index.html');
const html = fs.readFileSync(src, 'utf8');

const pngs = [...html.matchAll(/<img[^>]*src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map(m => m[1]);
if (!pngs.length) { console.error('No inline PNG logo found in ' + src); process.exit(1); }
const logoB64 = pngs.sort((a, b) => b.length - a.length)[0];
const logo = Buffer.from(logoB64, 'base64');

let sharp;
try { sharp = require('sharp'); } catch (e) { console.error('sharp is not installed (it comes with @capacitor/assets): npm install'); process.exit(1); }

const assets = path.join(root, 'assets');
fs.mkdirSync(assets, { recursive: true });

async function compose(size, bg, logoSize, out, transparent = false) {
  const logoBuf = await sharp(logo).resize({ width: logoSize, height: logoSize, fit: 'inside' }).png().toBuffer();
  const meta = await sharp(logoBuf).metadata();
  const left = Math.round((size - meta.width) / 2), top = Math.round((size - meta.height) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : bg } })
    .composite([{ input: logoBuf, left, top }])
    .png()
    .toFile(path.join(assets, out));
  console.log('  ' + out);
}

const cream = { r: 245, g: 242, b: 232, alpha: 1 };
const forest = { r: 30, g: 43, b: 34, alpha: 1 };
await compose(1024, cream, 700, 'icon-only.png');
await compose(1024, cream, 560, 'icon-foreground.png', true);   /* adaptive icon: keep inside the safe zone */
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: cream } }).png().toFile(path.join(assets, 'icon-background.png'));
console.log('  icon-background.png');
await compose(2732, forest, 640, 'splash.png');
await compose(2732, forest, 640, 'splash-dark.png');
console.log('assets ready in ' + assets);
