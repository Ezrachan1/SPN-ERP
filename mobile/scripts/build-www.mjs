#!/usr/bin/env node
/**
 * Builds ./www for the SPN OS app from the deployable web app.
 *
 *  - takes app/public/index.html (the same file the Worker serves)
 *  - injects window.SPN_CONFIG (Worker URL, app version, mobile flag)
 *  - vendors the CDN libraries (Chart.js, SheetJS, jsPDF, autotable) and the
 *    Google Fonts into www/ so the app works with no network at all
 *  - appends mobile-shim.js (hardware back button, share-sheet downloads, ...)
 *
 * Usage:  node scripts/build-www.mjs            (reads spn-mobile.config.json)
 *         SPN_API_BASE=https://... node scripts/build-www.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'spn-mobile.config.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const apiBase = (process.env.SPN_API_BASE || cfg.apiBase || '').replace(/\/+$/, '');
const appVersion = process.env.SPN_APP_VERSION || cfg.appVersion || pkg.version;
const src = path.resolve(root, cfg.source || '../app/public/index.html');
const www = path.join(root, 'www');
const offlineOnly = process.argv.includes('--offline'); // skip all downloads (use what is vendored already)

if (!apiBase) { console.error('apiBase is empty: set it in spn-mobile.config.json or SPN_API_BASE'); process.exit(1); }
if (!fs.existsSync(src)) { console.error('Source web app not found: ' + src); process.exit(1); }

fs.mkdirSync(path.join(www, 'vendor'), { recursive: true });
fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });
let html = fs.readFileSync(src, 'utf8');

async function download(url, dest, binary = true) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
  if (offlineOnly) return false;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return true;
  } catch (e) {
    console.warn('  ! could not download ' + url + ': ' + e.message);
    return false;
  }
}

/* 1) vendor the script libraries referenced from CDNs */
const scriptTags = [...html.matchAll(/<script src="(https?:\/\/[^"]+)"><\/script>/g)];
for (const m of scriptTags) {
  const url = m[1];
  const name = url.split('/').filter(Boolean).slice(-2).join('-').replace(/[^A-Za-z0-9._-]+/g, '_');
  const dest = path.join(www, 'vendor', name);
  const ok = await download(url, dest);
  if (ok) { html = html.replace(m[0], `<script src="vendor/${name}"></script>`); console.log('  vendored ' + name); }
  else console.warn('  keeping CDN reference for ' + url + ' (needs network at runtime)');
}

/* 2) vendor the Google Fonts (CSS + woff2) */
const fontLink = html.match(/<link href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"[^>]*>/);
if (fontLink) {
  const cssDest = path.join(www, 'fonts', 'fonts.css');
  let css = null;
  if (fs.existsSync(cssDest)) css = fs.readFileSync(cssDest, 'utf8');
  else if (!offlineOnly) {
    try {
      const r = await fetch(fontLink[1].replace(/&amp;/g, '&'), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      css = await r.text();
      const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(x => x[1]))];
      for (const u of urls) {
        const fname = u.split('/').slice(-3).join('_').replace(/[^A-Za-z0-9._-]+/g, '_');
        const ok = await download(u, path.join(www, 'fonts', fname));
        if (ok) css = css.split(u).join(fname);
      }
      fs.writeFileSync(cssDest, css);
      console.log('  vendored Google Fonts (' + urls.length + ' files)');
    } catch (e) { console.warn('  ! fonts not vendored (' + e.message + '); system fonts will be used offline'); css = null; }
  }
  html = html.replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/g, '');
  html = html.replace(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com"[^>]*>\s*/g, '');
  html = html.replace(fontLink[0], css ? '<link rel="stylesheet" href="fonts/fonts.css">' : '');
}

/* 3) app config + shim */
const configTag = `<script>window.SPN_CONFIG=${JSON.stringify({ apiBase, mobile: true, appVersion, platform: 'android', appName: 'SPN OS' })};</script>`;
html = html.replace(/<head>/i, '<head>\n' + configTag);
html = html.replace(/<title>[^<]*<\/title>/, '<title>SPN OS</title>');
html = html.replace(/<meta name="viewport" content="[^"]*">/, '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">');
fs.copyFileSync(path.join(root, 'src', 'mobile-shim.js'), path.join(www, 'mobile-shim.js'));
html = html.replace(/<\/body>/i, '<script src="mobile-shim.js"></script>\n</body>');

fs.writeFileSync(path.join(www, 'index.html'), html);
console.log(`www/index.html built: ${(html.length / 1024).toFixed(0)} KB, API ${apiBase}, app v${appVersion}`);
