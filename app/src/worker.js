/**
 * SPN ERP - Cloudflare Worker backend (production workspace).
 *
 * Serves the single-page app from ./public (assets binding) and a JSON API
 * backed by a D1 (SQLite) database:
 *
 *   GET  /api/health              liveness + whether the workspace is set up
 *   GET  /api/directory           public user list + organisation, for the login screen
 *   POST /api/setup               first run only: create the Super User + organisation
 *   POST /api/register            self-registration; account is Pending until approved,
 *                                 or Active immediately with a valid invitation token
 *   GET  /api/invite/:token       public: validate an invitation link
 *   POST /api/login               { userId, password } -> { token, mustChange }
 *   POST /api/logout              end the current session
 *   POST /api/password            change own password { current, next }
 *   POST /api/profile             change own name / phone / email / avatar
 *   POST /api/users/password      admin: set a temporary password { userId, password }
 *   POST /api/invites             admin: create an invitation { role } -> { token }
 *   GET  /api/invites             admin: list invitations
 *   DELETE /api/invites/:token    admin: revoke an invitation
 *   GET  /api/state               full workspace (users + all collections)
 *   PUT  /api/collections/:name   upsert one collection (granular sync)
 *   PUT  /api/users               admin: upsert user list; deletions only via
 *                                 an explicit { users, remove: [ids] } body, so a
 *                                 stale client can never wipe a fresh registration
 *   POST /api/reset               superuser: { mode: 'operational' | 'factory' }
 *   POST /api/ai                  proxy to the Anthropic Messages API (needs
 *                                 the ANTHROPIC_API_KEY secret)
 *   POST /api/files               store a downscaled image (R2 when SPN_FILES is
 *                                 bound, else the D1 files table) -> { id }
 *   GET  /api/files/:id           public: serve an image (random id is the key)
 *   DELETE /api/files/:id         remove an image
 *   GET  /api/releases            public: app builds, newest first
 *   GET  /api/releases/:id/download   public: download an APK (R2)
 *   POST /api/releases            superuser: upload an APK (raw body +
 *                                 X-Release-Version / X-Release-Notes / X-File-Name);
 *                                 keeps the newest KEEP_RELEASES builds, purges the rest
 *   DELETE /api/releases/:id      superuser: delete a build
 *
 * Cross-origin: the mobile app (Capacitor WebView) is allowed via CORS for the
 * origins in ALLOWED_ORIGINS plus the Capacitor defaults (https://localhost etc).
 *
 * Auth: per-user PBKDF2-SHA256 hashes with a versioned cost (v1$<iterations>$<hash>).
 * The default of 10k iterations stays inside the Workers free-plan CPU budget;
 * legacy 100k-iteration hashes verify once and are transparently rehashed.
 * Sessions are bearer tokens in the sessions table with a 7 day expiry.
 * Accounts are permanent until deleted by an admin or a factory reset.
 */
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

/* ---- CORS: the Android/iOS app (Capacitor WebView) calls this API from its own
   origin. Only the origins listed in ALLOWED_ORIGINS (comma separated) are accepted;
   browsers on the Worker's own origin never send a cross-origin request. ---- */
const DEFAULT_APP_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost', 'ionic://localhost'];
function allowedOrigin(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const all = list.length ? list.concat(DEFAULT_APP_ORIGINS) : DEFAULT_APP_ORIGINS;
  return all.includes(origin) ? origin : null;
}
function withCors(res, origin) {
  if (!origin) return res;
  const out = new Response(res.body, res);
  out.headers.set('Access-Control-Allow-Origin', origin);
  out.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  out.headers.append('Vary', 'Origin');
  return out;
}
function preflight(origin) {
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Release-Version, X-Release-Notes, X-File-Name, X-Base-Hash',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  } });
}

/* ---- Binary storage: R2 when the SPN_FILES bucket is bound, otherwise the D1
   files table (so a deployment without R2 keeps working). Images live under img/,
   app releases under apk/. ---- */
const KEEP_RELEASES = 5; /* current + 4 previous builds; anything older is purged */
const hasR2 = env => !!(env && env.SPN_FILES && typeof env.SPN_FILES.put === 'function');
const newId = () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().slice(0, 8);
async function purgeOldReleases(env) {
  const rows = (await env.SPN_DB.prepare('SELECT id, r2_key FROM releases ORDER BY created_at DESC').all()).results || [];
  const stale = rows.slice(KEEP_RELEASES);
  for (const r of stale) {
    if (r.r2_key && hasR2(env)) { try { await env.SPN_FILES.delete(r.r2_key); } catch (e) {} }
    await env.SPN_DB.prepare('DELETE FROM releases WHERE id = ?').bind(r.id).run();
  }
  return stale.length;
}
const releaseRow = r => ({ id: r.id, version: r.version, notes: r.notes || '', fileName: r.file_name, size: r.size, platform: r.platform || 'android', createdAt: r.created_at, createdBy: r.created_by, url: '/api/releases/' + r.id + '/download' });
/* same content hash as the SPA's syncHash(): lets a client say which version of a
   collection it is updating without shipping the whole text twice */
function syncHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36) + '.' + s.length;
}
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 10000;
const LEGACY_ITERATIONS = 100000;

const COLLECTIONS = [
  'departments', 'staff', 'consumables', 'seedlingStock', 'seedInventory', 'livestockInventory',
  'farmPlots', 'rainfallLog', 'reportAccess',
  'sowingRecords', 'cashSales', 'procurement', 'requisitions', 'leads', 'auditLog',
  'reportsAccessList', 'accessRequests', 'aiScans', 'activityStats', 'weatherLocation',
  'salesHistory', 'priceHistory', 'companyKraPin', 'leadsMonthlyTarget', 'org',
];
const OPERATIONAL = [
  'staff', 'consumables', 'seedlingStock', 'seedInventory', 'livestockInventory', 'farmPlots', 'rainfallLog',
  'sowingRecords', 'cashSales', 'procurement', 'requisitions', 'leads', 'auditLog',
  'accessRequests', 'aiScans', 'activityStats', 'salesHistory', 'priceHistory',
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.SPN_DB.batch([
    env.SPN_DB.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, json TEXT NOT NULL, pass_hash TEXT, pass_salt TEXT, must_change INTEGER DEFAULT 0, updated_at INTEGER)'),
    env.SPN_DB.prepare('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER)'),
    env.SPN_DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)'),
    env.SPN_DB.prepare('CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, role TEXT, created_by TEXT, created_at INTEGER, expires_at INTEGER, used_by TEXT)'),
    env.SPN_DB.prepare('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, owner TEXT, mime TEXT, data TEXT NOT NULL, size INTEGER, created_at INTEGER)'),
    env.SPN_DB.prepare('CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, version TEXT NOT NULL, notes TEXT, file_name TEXT, r2_key TEXT NOT NULL, size INTEGER, platform TEXT, created_at INTEGER, created_by TEXT)'),
  ]);
  /* migration: invites gained an email column for emailed invitations */
  try { await env.SPN_DB.prepare('ALTER TABLE invites ADD COLUMN email TEXT').run(); } catch (e) {}
  schemaReady = true;
}

/* ---- invitation emails (Cloudflare Email Sending binding) ----
   Active only when the SPN_EMAIL binding exists AND EMAIL_FROM is set to an
   address on a domain onboarded with: npx wrangler email sending enable <domain>.
   Otherwise invite creation still works and the UI falls back to a shareable link. */
const emailConfigured = env => !!(env.SPN_EMAIL && env.EMAIL_FROM);
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sendInviteEmail(env, origin, { to, role, token, orgName, inviterName }) {
  const link = origin + '/?invite=' + token;
  const subject = 'Invitation to join ' + orgName + ' on SPN Operations';
  const text = 'Hello,\n\n' + inviterName + ' has invited you to join ' + orgName + ' on the SPN Operations platform as ' + role + '.\n\n'
    + 'Open this link, fill in your details and set your password (one time only):\n' + link + '\n\n'
    + 'The invitation is valid for 7 days and can be used once. If you were not expecting it, you can ignore this email.';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;padding:26px 20px;color:#242B22;">'
    + '<h2 style="color:#26352A;margin:0 0 14px;">You are invited to join ' + escHtml(orgName) + '</h2>'
    + '<p style="line-height:1.65;margin:0 0 10px;"><b>' + escHtml(inviterName) + '</b> has invited you to join <b>' + escHtml(orgName) + '</b> on the SPN Operations platform as <b>' + escHtml(role) + '</b>.</p>'
    + '<p style="line-height:1.65;margin:0 0 10px;">Open the button below, fill in your details and set your password. You only do this once; afterwards you simply sign in on any device.</p>'
    + '<p style="margin:26px 0;"><a href="' + link + '" style="background:#315C3A;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Accept invitation</a></p>'
    + '<p style="color:#68705F;font-size:13px;line-height:1.6;margin:0 0 10px;">Or copy this link into your browser:<br><a href="' + link + '" style="color:#96712E;word-break:break-all;">' + link + '</a></p>'
    + '<p style="color:#98A08D;font-size:12px;line-height:1.6;margin:18px 0 0;">This invitation is valid for 7 days and can be used once. If you were not expecting it, you can safely ignore this email.</p>'
    + '</div>';
  await env.SPN_EMAIL.send({
    to,
    from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || orgName },
    subject, html, text,
  });
}

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function deriveHash(password, saltB64, iterations) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: b64(bits), salt: b64(salt) };
}
async function makePassword(password) {
  const { hash, salt } = await deriveHash(password, null, PBKDF2_ITERATIONS);
  return { hash: 'v1$' + PBKDF2_ITERATIONS + '$' + hash, salt };
}
async function verifyPassword(password, storedHash, saltB64) {
  let iterations = LEGACY_ITERATIONS, expected = storedHash, legacy = true;
  if (storedHash && storedHash.startsWith('v1$')) {
    const parts = storedHash.split('$');
    iterations = +parts[1] || PBKDF2_ITERATIONS;
    expected = parts[2];
    legacy = false;
  }
  const { hash } = await deriveHash(password, saltB64, iterations);
  return { ok: hash === expected, legacy };
}

async function userCount(env) {
  const row = await env.SPN_DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row ? row.n : 0;
}
async function requireSession(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const row = await env.SPN_DB.prepare(
    'SELECT s.token, s.user_id, s.expires_at, u.json AS user_json FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.SPN_DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return { token, userId: row.user_id, user: JSON.parse(row.user_json) };
}
const isAdmin = u => u && (u.role === 'Admin' || u.role === 'SuperUser');

async function createSession(env, userId) {
  const token = crypto.randomUUID() + '-' + crypto.randomUUID();
  await env.SPN_DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, Date.now() + SESSION_TTL_MS).run();
  await env.SPN_DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  return token;
}
async function putCollection(env, name, jsonText) {
  await env.SPN_DB.prepare(
    'INSERT INTO collections (name, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'
  ).bind(name, jsonText, Date.now()).run();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(req);
    }
    const origin = allowedOrigin(req, env);
    if (req.method === 'OPTIONS') return preflight(origin);
    const res = await handleApi(req, env, url);
    return withCors(res, origin);
  },
};

async function handleApi(req, env, url) {
  {
    const route = url.pathname.slice(5).replace(/\/+$/, '');
    try {
      await ensureSchema(env);

      if (route === 'health') {
        return json({ ok: true, mode: 'cloudflare', db: true, email: emailConfigured(env), setup: (await userCount(env)) > 0, time: Date.now() });
      }

      if (route === 'directory') {
        const rows = (await env.SPN_DB.prepare('SELECT json, pass_hash FROM users').all()).results || [];
        const users = rows.map(r => {
          const u = JSON.parse(r.json);
          return { id: u.id, name: u.name, role: u.role, designation: u.designation, status: u.status || 'Active', hasPassword: !!r.pass_hash };
        });
        const orgRow = await env.SPN_DB.prepare('SELECT json FROM collections WHERE name = ?').bind('org').first();
        const deptRow = await env.SPN_DB.prepare('SELECT json FROM collections WHERE name = ?').bind('departments').first();
        let departments = [];
        if (deptRow) { try { departments = JSON.parse(deptRow.json) || []; } catch (e) {} }
        return json({ setup: users.length > 0, users, org: orgRow ? JSON.parse(orgRow.json) : null, departments });
      }

      if (route === 'setup' && req.method === 'POST') {
        if ((await userCount(env)) > 0) return json({ error: 'Workspace is already set up' }, 403);
        const body = await req.json().catch(() => ({}));
        const user = body.user;
        const password = String(body.password || '');
        if (!user || !user.id || !user.name || password.length < 8) {
          return json({ error: 'A Super User profile and a password of at least 8 characters are required' }, 400);
        }
        user.role = 'SuperUser';
        user.status = 'Active';
        const { hash, salt } = await makePassword(password);
        await env.SPN_DB.prepare('INSERT INTO users (id, json, pass_hash, pass_salt, must_change, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
          .bind(user.id, JSON.stringify(user), hash, salt, Date.now()).run();
        if (body.org) await putCollection(env, 'org', JSON.stringify(body.org));
        const token = await createSession(env, user.id);
        return json({ ok: true, token, userId: user.id });
      }

      if (route === 'register' && req.method === 'POST') {
        if ((await userCount(env)) === 0) return json({ error: 'Workspace is not set up yet' }, 403);
        const body = await req.json().catch(() => ({}));
        const user = body.user;
        const password = String(body.password || '');
        if (!user || !user.id || !user.name || !user.role || password.length < 8) {
          return json({ error: 'Name, role and a password of at least 8 characters are required' }, 400);
        }
        if (user.role === 'SuperUser') return json({ error: 'The Super User account cannot be self-registered' }, 403);
        const rows = (await env.SPN_DB.prepare('SELECT json FROM users').all()).results || [];
        const dup = rows.some(r => { try { return JSON.parse(r.json).name.trim().toLowerCase() === user.name.trim().toLowerCase(); } catch (e) { return false; } });
        if (dup) return json({ error: 'An account with this name already exists. Sign in instead, or ask your administrator.' }, 409);
        let active = false;
        const inviteToken = String(body.invite || '');
        if (inviteToken) {
          const inv = await env.SPN_DB.prepare('SELECT token, role, expires_at, used_by FROM invites WHERE token = ?').bind(inviteToken).first();
          if (!inv || inv.used_by || inv.expires_at < Date.now()) {
            return json({ error: 'This invitation link is invalid, expired or already used' }, 400);
          }
          active = true;
          if (inv.role) user.role = inv.role;
          await env.SPN_DB.prepare('UPDATE invites SET used_by = ? WHERE token = ?').bind(user.id, inviteToken).run();
        }
        user.status = active ? 'Active' : 'Pending';
        const { hash, salt } = await makePassword(password);
        await env.SPN_DB.prepare('INSERT INTO users (id, json, pass_hash, pass_salt, must_change, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
          .bind(user.id, JSON.stringify(user), hash, salt, Date.now()).run();
        return json({ ok: true, status: user.status });
      }

      if (route.startsWith('invite/') && req.method === 'GET') {
        const token = route.slice('invite/'.length);
        const inv = await env.SPN_DB.prepare('SELECT role, email, expires_at, used_by FROM invites WHERE token = ?').bind(token).first();
        const valid = !!(inv && !inv.used_by && inv.expires_at >= Date.now());
        return json({ valid, role: valid ? inv.role : null, email: valid ? (inv.email || null) : null });
      }

      /* stored images (livestock photos): downscaled client-side, kept in D1.
         GET is unauthenticated so <img> tags can load them; ids are long random
         tokens, which is the access control for these non-sensitive farm photos. */
      if (route.startsWith('files/') && req.method === 'GET') {
        const id = route.slice('files/'.length);
        if (!/^[a-zA-Z0-9]+$/.test(id)) return json({ error: 'Not found' }, 404);
        if (hasR2(env)) {
          const obj = await env.SPN_FILES.get('img/' + id);
          if (obj) {
            return new Response(obj.body, { headers: { 'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'ETag': obj.httpEtag } });
          }
        }
        const row = await env.SPN_DB.prepare('SELECT mime, data FROM files WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Not found' }, 404);
        const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
        return new Response(bytes, { headers: { 'Content-Type': row.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
      }

      /* App releases (APK): the list and the download are public so the login page
         and any device can fetch the current build; uploads are admin-only below. */
      if (route === 'releases' && req.method === 'GET') {
        const rows = (await env.SPN_DB.prepare('SELECT * FROM releases ORDER BY created_at DESC').all()).results || [];
        return json({ releases: rows.map(releaseRow), storage: hasR2(env) ? 'r2' : 'none' });
      }
      if (/^releases\/[a-zA-Z0-9]+\/download$/.test(route) && req.method === 'GET') {
        const id = route.split('/')[1];
        const row = await env.SPN_DB.prepare('SELECT * FROM releases WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Release not found' }, 404);
        if (!hasR2(env)) return json({ error: 'File storage (R2) is not configured on this deployment' }, 503);
        const obj = await env.SPN_FILES.get(row.r2_key);
        if (!obj) return json({ error: 'Release file is missing from storage' }, 404);
        /* the download is always named after the app and version, whatever the uploaded file was called */
        const fname = 'SPN-OS-v' + String(row.version || '').replace(/^v/i, '').replace(/[^A-Za-z0-9._-]+/g, '_') + (row.platform === 'ios' ? '.ipa' : '.apk');
        return new Response(obj.body, { headers: {
          'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/vnd.android.package-archive',
          'Content-Disposition': 'attachment; filename="' + fname + '"; filename*=UTF-8\'\'' + encodeURIComponent(fname),
          'Content-Length': String(obj.size),
          'Cache-Control': 'public, max-age=300',
        } });
      }

      if (route === 'login' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const userId = String(body.userId || '');
        const password = String(body.password || '');
        const row = await env.SPN_DB.prepare('SELECT id, json, pass_hash, pass_salt, must_change FROM users WHERE id = ?').bind(userId).first();
        if (!row) return json({ error: 'Unknown account' }, 401);
        const profile = JSON.parse(row.json);
        if (!row.pass_hash) return json({ error: 'No password is set for this account yet. Ask your administrator to issue a temporary password.', code: 'no-password' }, 403);
        const v = await verifyPassword(password, row.pass_hash, row.pass_salt);
        if (!v.ok) return json({ error: 'Incorrect password' }, 401);
        if ((profile.status || 'Active') === 'Pending') {
          return json({ error: 'Your registration is awaiting approval by an administrator.', code: 'pending' }, 403);
        }
        if (v.legacy) {
          /* migrate old high-cost hashes to the versioned format */
          const np = await makePassword(password);
          await env.SPN_DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(np.hash, np.salt, row.id).run();
        }
        const token = await createSession(env, userId);
        return json({ token, userId, mustChange: !!row.must_change });
      }

      /* everything below requires a valid session */
      const session = await requireSession(req, env);

      if (route === 'logout' && req.method === 'POST') {
        if (session) await env.SPN_DB.prepare('DELETE FROM sessions WHERE token = ?').bind(session.token).run();
        return json({ ok: true });
      }
      if (!session) return json({ error: 'Unauthorized' }, 401);

      if (route === 'password' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const next = String(body.next || '');
        if (next.length < 8) return json({ error: 'New password must be at least 8 characters' }, 400);
        const row = await env.SPN_DB.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').bind(session.userId).first();
        if (row && row.pass_hash) {
          const v = await verifyPassword(String(body.current || ''), row.pass_hash, row.pass_salt);
          if (!v.ok) return json({ error: 'Current password is incorrect' }, 401);
        }
        const { hash, salt } = await makePassword(next);
        await env.SPN_DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, must_change = 0, updated_at = ? WHERE id = ?')
          .bind(hash, salt, Date.now(), session.userId).run();
        return json({ ok: true });
      }

      /* self-service profile: every signed-in user may change their own name, phone,
         email and avatar (preset key or an uploaded /api/files image); nothing else */
      if (route === 'profile' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const row = await env.SPN_DB.prepare('SELECT json FROM users WHERE id = ?').bind(session.userId).first();
        if (!row) return json({ error: 'Account not found' }, 404);
        const user = JSON.parse(row.json);
        const name = String(body.name || '').trim().slice(0, 80);
        if (!name) return json({ error: 'Name is required' }, 400);
        const email = String(body.email || '').trim().slice(0, 120);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email address' }, 400);
        const phone = String(body.phone || '').trim().slice(0, 30);
        let avatar = null;
        const av = body.avatar;
        if (av && typeof av === 'object') {
          if (av.type === 'preset' && /^[a-z0-9_-]{1,30}$/.test(String(av.key || ''))) avatar = { type: 'preset', key: String(av.key) };
          else if (av.type === 'photo' && /^\/api\/files\/[a-zA-Z0-9]+$/.test(String(av.src || ''))) avatar = { type: 'photo', src: String(av.src), fileId: String(av.src).split('/').pop() };
          else return json({ error: 'Invalid avatar' }, 400);
        }
        Object.assign(user, { name, email, phone, avatar });
        /* notification preferences: tone, vibration, pop-ups, phone notifications */
        if (body.prefs && typeof body.prefs === 'object') {
          const p = body.prefs;
          const tone = ['system', 'default', 'bell', 'drip', 'soft', 'alert', 'none'].includes(p.tone) ? p.tone : 'default';
          user.prefs = { tone, vibrate: p.vibrate !== false, popups: p.popups !== false, system: p.system !== false };
        }
        await env.SPN_DB.prepare('UPDATE users SET json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(user), Date.now(), session.userId).run();
        return json({ ok: true, user });
      }

      if (route === 'users/password' && req.method === 'POST') {
        if (!isAdmin(session.user)) return json({ error: 'Admin or Super User required' }, 403);
        const body = await req.json().catch(() => ({}));
        const userId = String(body.userId || '');
        const password = String(body.password || '');
        if (password.length < 8) return json({ error: 'Temporary password must be at least 8 characters' }, 400);
        const exists = await env.SPN_DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
        if (!exists) return json({ error: 'Unknown user' }, 404);
        const { hash, salt } = await makePassword(password);
        await env.SPN_DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, must_change = 1, updated_at = ? WHERE id = ?')
          .bind(hash, salt, Date.now(), userId).run();
        return json({ ok: true });
      }

      if (route === 'files' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const data = String(body.data || '');
        if (!data || data.length > 900000) return json({ error: 'Image missing or too large (max ~650 KB after downscaling)' }, 413);
        const mime = /^image\/(jpeg|png|webp)$/.test(String(body.mime || '')) ? body.mime : 'image/jpeg';
        const id = newId();
        if (hasR2(env)) {
          /* images go to R2 (cheap object storage, no D1 row-size pressure) */
          const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          await env.SPN_FILES.put('img/' + id, bytes, { httpMetadata: { contentType: mime }, customMetadata: { owner: session.userId, createdAt: String(Date.now()) } });
          return json({ ok: true, id, storage: 'r2' });
        }
        await env.SPN_DB.prepare('INSERT INTO files (id, owner, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, session.userId, mime, data, data.length, Date.now()).run();
        return json({ ok: true, id, storage: 'd1' });
      }
      if (route.startsWith('files/') && req.method === 'DELETE') {
        const id = route.slice('files/'.length);
        if (hasR2(env)) { try { await env.SPN_FILES.delete('img/' + id); } catch (e) {} }
        await env.SPN_DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      /* App release upload (Super User only): raw APK bytes in the body, metadata in
         headers. Older builds beyond KEEP_RELEASES are purged automatically. */
      if (route === 'releases' && req.method === 'POST') {
        if (session.user.role !== 'SuperUser') return json({ error: 'Super User required' }, 403);
        if (!hasR2(env)) return json({ error: 'File storage (R2) is not configured: bind the SPN_FILES bucket in wrangler.jsonc' }, 503);
        const version = String(req.headers.get('X-Release-Version') || '').trim().slice(0, 40);
        if (!version) return json({ error: 'X-Release-Version header is required' }, 400);
        let notes = ''; try { notes = decodeURIComponent(req.headers.get('X-Release-Notes') || ''); } catch (e) { notes = req.headers.get('X-Release-Notes') || ''; }
        const fileName = String(req.headers.get('X-File-Name') || ('SPN-OS-v' + version + '.apk')).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
        const platform = /\.ipa$/i.test(fileName) ? 'ios' : 'android';
        const declared = +(req.headers.get('Content-Length') || 0);
        const MAX_RELEASE = 100 * 1024 * 1024; /* Workers request body limit */
        if (declared > MAX_RELEASE) return json({ error: 'Release file too large (max 100 MB)' }, 413);
        const id = newId();
        const key = 'apk/' + id + '-' + fileName;
        const meta = {
          httpMetadata: { contentType: platform === 'ios' ? 'application/octet-stream' : 'application/vnd.android.package-archive' },
          customMetadata: { version, uploadedBy: session.userId, fileName },
        };
        let size = declared;
        if (declared > 0 && req.body && typeof FixedLengthStream === 'function') {
          /* stream straight into R2 so a large APK never sits in Worker memory */
          const { readable, writable } = new FixedLengthStream(declared);
          req.body.pipeTo(writable).catch(() => {});
          await env.SPN_FILES.put(key, readable, meta);
        } else {
          const bytes = await req.arrayBuffer();
          if (!bytes.byteLength) return json({ error: 'Empty upload' }, 400);
          if (bytes.byteLength > MAX_RELEASE) return json({ error: 'Release file too large (max 100 MB)' }, 413);
          size = bytes.byteLength;
          await env.SPN_FILES.put(key, bytes, meta);
        }
        try {
          await env.SPN_DB.prepare('INSERT INTO releases (id, version, notes, file_name, r2_key, size, platform, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, version, notes.slice(0, 2000), fileName, key, size, platform, Date.now(), session.userId).run();
        } catch (e) {
          try { await env.SPN_FILES.delete(key); } catch (e2) {} /* no orphaned objects */
          throw e;
        }
        const purged = await purgeOldReleases(env);
        const row = await env.SPN_DB.prepare('SELECT * FROM releases WHERE id = ?').bind(id).first();
        return json({ ok: true, release: releaseRow(row), purged });
      }
      if (/^releases\/[a-zA-Z0-9]+$/.test(route) && req.method === 'DELETE') {
        if (session.user.role !== 'SuperUser') return json({ error: 'Super User required' }, 403);
        const id = route.split('/')[1];
        const row = await env.SPN_DB.prepare('SELECT r2_key FROM releases WHERE id = ?').bind(id).first();
        if (row && row.r2_key && hasR2(env)) { try { await env.SPN_FILES.delete(row.r2_key); } catch (e) {} }
        await env.SPN_DB.prepare('DELETE FROM releases WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      if (route === 'activity' && req.method === 'POST') {
        /* server-merged per-user activity counter: increments never clobber other users */
        const body = await req.json().catch(() => ({}));
        const inc = Math.max(0, Math.min(1000, Math.round(+body.inc || 0)));
        const row = await env.SPN_DB.prepare('SELECT json FROM collections WHERE name = ?').bind('activityStats').first();
        let stats = {};
        if (row) { try { stats = JSON.parse(row.json) || {}; } catch (e) {} }
        stats[session.userId] = (stats[session.userId] || 0) + inc;
        await putCollection(env, 'activityStats', JSON.stringify(stats));
        return json({ ok: true, total: stats[session.userId] });
      }

      if (route === 'invites' && req.method === 'POST') {
        if (!isAdmin(session.user)) return json({ error: 'Admin or Super User required' }, 403);
        const body = await req.json().catch(() => ({}));
        const email = String(body.email || '').trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'That does not look like a valid email address' }, 400);
        const token = crypto.randomUUID().replace(/-/g, '');
        await env.SPN_DB.prepare('INSERT INTO invites (token, role, created_by, created_at, expires_at, email) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(token, String(body.role || ''), session.userId, Date.now(), Date.now() + INVITE_TTL_MS, email || null).run();
        let emailed = false, emailError = null;
        if (email && emailConfigured(env)) {
          try {
            const orgRow = await env.SPN_DB.prepare('SELECT json FROM collections WHERE name = ?').bind('org').first();
            const orgName = orgRow ? (JSON.parse(orgRow.json).name || 'SPN Operations') : 'SPN Operations';
            await sendInviteEmail(env, url.origin, { to: email, role: String(body.role || 'team member'), token, orgName, inviterName: session.user.name });
            emailed = true;
          } catch (e) {
            emailError = String((e && (e.code || e.message)) || e);
          }
        }
        return json({ ok: true, token, expiresAt: Date.now() + INVITE_TTL_MS, email: email || null, emailed, emailConfigured: emailConfigured(env), emailError });
      }
      if (route === 'invites' && req.method === 'GET') {
        if (!isAdmin(session.user)) return json({ error: 'Admin or Super User required' }, 403);
        const rows = (await env.SPN_DB.prepare('SELECT token, role, email, created_at, expires_at, used_by FROM invites ORDER BY created_at DESC LIMIT 50').all()).results || [];
        return json({ invites: rows });
      }
      if (route.startsWith('invites/') && req.method === 'DELETE') {
        if (!isAdmin(session.user)) return json({ error: 'Admin or Super User required' }, 403);
        await env.SPN_DB.prepare('DELETE FROM invites WHERE token = ?').bind(route.slice('invites/'.length)).run();
        return json({ ok: true });
      }

      if (route === 'state') {
        const userRows = (await env.SPN_DB.prepare('SELECT json FROM users').all()).results || [];
        const collRows = (await env.SPN_DB.prepare('SELECT name, json FROM collections').all()).results || [];
        const collections = {};
        collRows.forEach(r => { try { collections[r.name] = JSON.parse(r.json); } catch (e) {} });
        return json({ users: userRows.map(r => JSON.parse(r.json)), collections });
      }

      if (route.startsWith('collections/') && req.method === 'PUT') {
        const name = route.slice('collections/'.length);
        if (!COLLECTIONS.includes(name)) return json({ error: 'Unknown collection' }, 404);
        const text = await req.text();
        if (text.length > 4000000) return json({ error: 'Collection too large' }, 413);
        JSON.parse(text);
        /* optimistic concurrency: the client states which version it is updating;
           if the stored copy differs, hand it back (409) so the client merges by record */
        const base = req.headers.get('X-Base-Hash');
        if (base) {
          const row = await env.SPN_DB.prepare('SELECT json FROM collections WHERE name = ?').bind(name).first();
          if (row && row.json && syncHash(row.json) !== base) {
            return json({ error: 'Collection changed on the server', code: 'conflict', json: row.json, hash: syncHash(row.json) }, 409);
          }
        }
        await putCollection(env, name, text);
        return json({ ok: true, hash: syncHash(text) });
      }

      if (route === 'users' && req.method === 'PUT') {
        if (!isAdmin(session.user)) return json({ error: 'Admin or Super User required' }, 403);
        const body = await req.json().catch(() => null);
        const users = Array.isArray(body) ? body : (body && body.users);
        const remove = (!Array.isArray(body) && body && Array.isArray(body.remove)) ? body.remove.map(String) : [];
        if (!Array.isArray(users) || !users.length) return json({ error: 'A non-empty user list is required' }, 400);
        if (remove.includes(session.userId)) return json({ error: 'You cannot remove your own account' }, 400);
        if (users.some(u => !u || typeof u !== 'object' || !u.id)) return json({ error: 'Every user needs an id' }, 400);
        /* role integrity: only the Super User can grant, revoke or remove the SuperUser role */
        if (session.user.role !== 'SuperUser') {
          const ids = [...new Set(users.map(u => String(u.id)).concat(remove))];
          const rows = ids.length ? ((await env.SPN_DB.prepare(`SELECT id, json FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || []) : [];
          const roleOf = {}; rows.forEach(r => { try { roleOf[r.id] = JSON.parse(r.json).role; } catch (e) {} });
          const escalates = users.some(u => (u.role === 'SuperUser' && roleOf[u.id] !== 'SuperUser') || (roleOf[u.id] === 'SuperUser' && u.role !== 'SuperUser'));
          const removesSuper = remove.some(id => roleOf[id] === 'SuperUser');
          if (escalates || removesSuper) return json({ error: 'Only the Super User can grant, revoke or remove the Super User role' }, 403);
        }
        const now = Date.now();
        /* upsert only: rows registered after the client's snapshot are never deleted implicitly */
        const stmts = users.map(u => env.SPN_DB.prepare(
          'INSERT INTO users (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'
        ).bind(u.id, JSON.stringify(u), now));
        remove.forEach(id => {
          stmts.push(env.SPN_DB.prepare('DELETE FROM users WHERE id = ?').bind(id));
          stmts.push(env.SPN_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
        });
        await env.SPN_DB.batch(stmts);
        return json({ ok: true });
      }

      if (route === 'reset' && req.method === 'POST') {
        if (session.user.role !== 'SuperUser') return json({ error: 'Super User required' }, 403);
        const body = await req.json().catch(() => ({}));
        if (body.mode === 'factory') {
          await env.SPN_DB.batch([
            env.SPN_DB.prepare('DELETE FROM collections'),
            env.SPN_DB.prepare('DELETE FROM sessions'),
            env.SPN_DB.prepare('DELETE FROM invites'),
            env.SPN_DB.prepare('DELETE FROM files'),
            env.SPN_DB.prepare('DELETE FROM releases'),
            env.SPN_DB.prepare('DELETE FROM users'),
          ]);
          if (hasR2(env)) {
            /* best-effort purge of this workspace's images and app builds (only the
               prefixes this Worker writes; anything else in the bucket is untouched) */
            for (const prefix of ['img/', 'apk/']) {
              try {
                let cursor;
                do {
                  const page = await env.SPN_FILES.list({ prefix, cursor, limit: 1000 });
                  if (page.objects.length) await env.SPN_FILES.delete(page.objects.map(o => o.key));
                  cursor = page.truncated ? page.cursor : undefined;
                } while (cursor);
              } catch (e) {}
            }
          }
          return json({ ok: true, mode: 'factory' });
        }
        const placeholders = OPERATIONAL.map(() => '?').join(',');
        await env.SPN_DB.prepare(`DELETE FROM collections WHERE name IN (${placeholders})`).bind(...OPERATIONAL).run();
        return json({ ok: true, mode: 'operational' });
      }

      if (route === 'ai' && req.method === 'POST') {
        if (!env.ANTHROPIC_API_KEY) {
          return json({ error: 'AI not configured. Set it with: npx wrangler secret put ANTHROPIC_API_KEY' }, 501);
        }
        const body = await req.text();
        if (body.length > 15000000) return json({ error: 'Payload too large' }, 413);
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body,
        });
        return new Response(await upstream.text(), { status: upstream.status, headers: JSON_HEADERS });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error', detail: String((e && e.message) || e) }, 500);
    }
  }
}
