#!/usr/bin/env node
/**
 * Idempotent tweaks to the generated android/ project (re-run after `cap sync`):
 *  - permissions the web app needs: camera (livestock photos), location (farm plots,
 *    acreage, leads GPS)
 *  - keeps the app label "SPN OS"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifest)) { console.log('android/ not generated yet (run: npx cap add android)'); process.exit(0); }
let xml = fs.readFileSync(manifest, 'utf8');
const perms = [
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.VIBRATE" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
];
let changed = false;
for (const p of perms) {
  const key = p.match(/android:name="([^"]+)"/)[1];
  if (!xml.includes(key)) { xml = xml.replace('</manifest>', '    ' + p + '\n</manifest>'); changed = true; }
}
if (changed) { fs.writeFileSync(manifest, xml); console.log('AndroidManifest.xml: permissions added'); }
else console.log('AndroidManifest.xml: already patched');

/* version from package.json -> versionName/versionCode, and APKs named SPN-OS-<version>-<type>.apk */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [maj, min, pat] = String(pkg.version || '1.0.0').split('.').map(n => parseInt(n, 10) || 0);
const versionCode = maj * 10000 + min * 100 + pat;
const gradle = path.join(root, 'android', 'app', 'build.gradle');
if (fs.existsSync(gradle)) {
  let g = fs.readFileSync(gradle, 'utf8');
  const g2 = g.replace(/versionCode \d+/, 'versionCode ' + versionCode).replace(/versionName "[^"]*"/, 'versionName "' + pkg.version + '"');
  let g3 = g2;
  if (!g3.includes('outputFileName')) {
    g3 = g3.replace(/\n    buildTypes \{/, `\n    // SPN OS: APKs are named after the app and version, e.g. SPN-OS-1.0.0-debug.apk
    applicationVariants.all { variant ->
        variant.outputs.all { output ->
            outputFileName = "SPN-OS-" + variant.versionName + "-" + variant.buildType.name + ".apk"
        }
    }
    buildTypes {`);
  }
  if (g3 !== g) { fs.writeFileSync(gradle, g3); console.log('build.gradle: version ' + pkg.version + ' (' + versionCode + '), APK naming set'); }
  else console.log('build.gradle: already at version ' + pkg.version);
}

const strings = path.join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
if (fs.existsSync(strings)) {
  let s = fs.readFileSync(strings, 'utf8');
  const s2 = s.replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">SPN OS</string>')
              .replace(/<string name="title_activity_main">[^<]*<\/string>/, '<string name="title_activity_main">SPN OS</string>');
  if (s2 !== s) { fs.writeFileSync(strings, s2); console.log('strings.xml: app name set to SPN OS'); }
}
