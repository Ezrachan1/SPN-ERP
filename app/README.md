# SPN ERP · Savannah Propagation Nursery Operations Platform

A full-stack ERP for a seedling nursery: POS with downloadable receipts,
leads with GPS and route planning, sowing compliance register, growth
pipeline, seedling stock, livestock feed planning, procurement, consumables,
AI photo scouting, weather and field intelligence, HR, requisitions,
letterheaded reports, role-based access and a full audit log.

## Architecture

- `public/index.html` - the entire UI as a single-page app (no build step).
  Botanical Enterprise design system: Inter for UI, Alegreya for brand and
  display, JetBrains Mono for numbers and codes.
- `src/worker.js` - Cloudflare Worker. Serves the SPA via the assets binding
  and a JSON API backed by a **D1 (SQLite) database**: users, collections and
  sessions tables, with granular per-collection sync.
- **Real authentication**: per-user passwords stored as salted PBKDF2-SHA256
  hashes (versioned cost, tuned for the Workers free-plan CPU budget), 7 day
  bearer-token sessions that persist across tabs and browser restarts,
  forced password change after an admin-issued temporary password.
- **Self-registration with approval**: first-time users pick their role on
  the login page, set their details and their password once; the Super User
  or an Admin approves them before first sign-in. Accounts are permanent
  until deleted or the database is factory reset.
- **Invitations**: admins invite team members by email from Users & Access.
  With email sending configured the app emails the invitation itself; the
  invitee opens the link, fills in their details and sets their password
  once, and their account is active immediately with the invited role.
  Without email sending, the same flow produces a shareable link and a
  prefilled draft in the admin's own email app. Outstanding invitations are
  listed with their status and can be revoked.
- **First-run setup**: the first visit to a fresh deployment walks you
  through creating the System Super User and the organisation profile, then
  offers a clean start or a demo dataset.
- **Seedling stock that moves**: a POS sale picks the nursery batch it comes
  from and draws it down (over-selling is blocked); batches can be marked sold
  out / transplanted. Dashboard, pipeline, Seedling Stock, the POS list and the
  production/stock reports all show what is actually left. Sales carry the VAT
  amount for standard-rated lines; receipt and PR numbers continue from the
  highest existing number.
- **Seeds inventory**: seed lots received (crop, variety, supplier, lot and
  KEPHIS numbers, class, quantity in seeds/g/kg, germination, expiry, cost,
  store), a movement log, expiry/low-stock attention on the dashboard and a
  report. Sowing picks a lot and draws the quantity down automatically.
- **Access requests** cover operational modules only; Users & Access,
  Departments and the Audit Log are assigned by the Admin in the access matrix
  and can neither be requested nor granted through the approvals queue.
- **Notifications** (bell): low consumables, seed lots expired/expiring/low,
  batches ready for sale, harvests due, overdue and due-today lead visits,
  requisitions awaiting the roles that can approve them, pending purchase
  requests, AI scans to review, pending registrations and access requests
  (admins), offline/session state, and on the phone "SPN OS update available".
  Each item opens the exact record; the badge refreshes on every save. New
  items also pop up as cards (with a tone and vibration) and, in the SPN OS
  app, land in the phone's notification bar; dated items are scheduled as
  phone reminders. Everyone picks tone / vibration / pop-ups / phone
  notifications under My Profile → Notifications (saved in their profile).
- **Installable web app (PWA)**: `manifest.webmanifest`, icons and `sw.js`
  (network-first shell with offline fallback, cache-first libraries/fonts, the
  API is never cached). Browsers offer "Install SPN OS on this device" (login
  page and My Profile → Notifications); it then opens standalone and works
  offline like the APK. Browser notifications (new items when the tab is in
  the background, reminders while the site is open) are delivered through the
  service worker when installed. Phone-app and browser notification settings
  are separate (each has its own tone and permission).
- **Place type-ahead** on every location box (weather area search, Compare
  Years/Areas, POS customer location, lead location, workspace region): Open-Meteo
  geocoding suggestions with keyboard support; picking a place fills the
  companion GPS box when it is empty. Any input with `data-place` gets it too.
- **Password fields** everywhere (login, registration, setup, change password,
  admin temporary password) have a show/hide toggle.
- **Live dashboard**: every module change and every two minutes the app quietly
  pulls colleagues' changes (a sale on a rep's phone shows on the MD's
  dashboard); dates are local calendar dates, never UTC.
- **Farm plots**: fields with crop, variety, area, date of planting, a live
  crop-day counter, FAO-56 development stage, expected harvest and rainfall
  since planting; one click hands a plot to the irrigation calculator.
- **Rain gauge**: actual rainfall received (mm) logged per event, with weekly,
  monthly and year-to-date totals feeding the farm report.
- **Report viewers**: reports are visible by role, and admins can additionally
  grant individual users viewing rights per report (the Farm Plots report is
  assignment-only by default).
- **Offline-first**: every save lands in the device store first and syncs per
  collection; if the API is unreachable the app switches to an Offline mode
  (topbar chip), keeps working, and on reconnect 3-way merges and pushes the
  local changes (your touched records win, colleagues' changes survive), uploads
  photos taken offline, then pulls the latest workspace. Offline work survives
  closing the browser/app; the last weather forecast is cached.
- **SPN OS mobile app**: `../mobile` wraps this same file in a Capacitor Android
  app (UI shipped in the APK, API on this Worker). The Super User uploads builds
  in Users & Access; they go to R2, the newest 5 are kept, and the login page
  shows a download link to everyone. Images (livestock photos) also go to R2.
- **Responsive**: off-canvas sidebar with a hamburger toggle on mobile; on
  desktop the same toggle detaches or docks the sidebar (preference saved).
  The shell is exactly one viewport tall: only the sidebar list and the page
  body scroll, in-page tab switches and background refreshes keep your scroll
  position, and a real module change starts at the top.

The same `index.html` also runs standalone (opened from disk or any static
host): without the API it falls back to browser localStorage and a clearly
labeled shared demo password (`spn2026`).

## Deploy to Cloudflare

Requires a free Cloudflare account and Node.js.

```bash
cd app
npm install
npx wrangler login
npx wrangler d1 create spn-erp
```

Copy the `database_id` that the last command prints into `wrangler.jsonc`
(replace `REPLACE_WITH_D1_DATABASE_ID`) and deploy:

```bash
npx wrangler deploy
```

**R2 (optional, for photos and SPN OS APK builds)**: R2 has to be enabled once
on the Cloudflare account (Dashboard → R2 Object Storage → Enable; it asks for
a payment method even for the free 10 GB tier). Until it is enabled, keep the
`r2_buckets` block in `wrangler.jsonc` commented out, otherwise the deploy
fails with API error 10042; the Worker runs without it (images are stored in
D1, APK uploads report "storage not configured"). When ready:

```bash
npx wrangler r2 bucket create spn-erp-files
```

then uncomment the `r2_buckets` block and deploy again.

Wrangler prints your live URL. The first visit shows the **workspace setup
screen**: create the Super User account, then either start clean or load the
demo dataset. Team members then register themselves from the login page
(you approve them in Users & Access), arrive through an invitation link, or
are created by an admin with a temporary password.

To enable the AI features (photo scans, AI spray advisory, CV extraction,
commodity pricing, route rest stops), give the Worker an Anthropic API key:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Without the key, AI photo features show a clear unavailable state and the
spray advisory falls back to a rule-based version computed from the weather
data, so the module keeps working.

### Emailed invitations (optional)

To let the app send invitation emails itself (Cloudflare Email Sending),
you need a domain on your Cloudflare account:

```bash
npx wrangler email sending enable yourdomain.com
```

Then set `EMAIL_FROM` in `wrangler.jsonc` to an address on that domain
(e.g. `invites@yourdomain.com`), optionally `EMAIL_FROM_NAME`, and
redeploy. The invite dialog switches from "create a link" to "send email
invitation" automatically. Until then, invitations fall back to a copyable
link plus a prefilled draft in your own email app.

## Local development

```bash
cd app
npm install
npx wrangler dev
```

This runs the Worker with a local D1 database at http://localhost:8787, so
the full production flow (setup, per-user login, database persistence)
works locally too.

## API

| Method | Path                    | Auth      | Purpose                                       |
| ------ | ----------------------- | --------- | --------------------------------------------- |
| GET    | /api/health             | none      | Liveness + whether the workspace is set up    |
| GET    | /api/directory          | none      | Public user list + organisation for login     |
| POST   | /api/setup              | none*     | First run only: create Super User + org       |
| POST   | /api/register           | none      | Self-registration (Pending until approved; an invitation token activates immediately) |
| GET    | /api/invite/:token      | none      | Validate an invitation link                   |
| POST   | /api/invites            | Admin     | Create an invitation `{role}` -> `{token}`    |
| GET    | /api/invites            | Admin     | List invitations                              |
| DELETE | /api/invites/:token     | Admin     | Revoke an invitation                          |
| POST   | /api/login              | none      | `{userId, password}` -> `{token, mustChange}` |
| POST   | /api/logout             | Bearer    | End the current session                       |
| POST   | /api/password           | Bearer    | Change own password                           |
| POST   | /api/profile            | Bearer    | Change own name, phone, email, avatar         |
| POST   | /api/users/password     | Admin     | Issue a temporary password                    |
| GET    | /api/state              | Bearer    | Full workspace (users + collections)          |
| PUT    | /api/collections/:name  | Bearer    | Upsert one collection (granular sync)         |
| PUT    | /api/users              | Admin     | Replace user list (auth columns preserved)    |
| POST   | /api/reset              | SuperUser | `{mode:'operational'|'factory'}`              |
| POST   | /api/ai                 | Bearer    | Proxy to the Anthropic Messages API           |
| POST   | /api/files              | Bearer    | Store a downscaled image (R2, or D1 fallback) |
| GET    | /api/files/:id          | none**    | Serve a stored image                          |
| DELETE | /api/files/:id          | Bearer    | Remove a stored image                         |
| POST   | /api/activity           | Bearer    | Server-merged per-user activity increment     |
| GET    | /api/releases           | none      | App builds, newest first                      |
| GET    | /api/releases/:id/download | none   | Download an APK (R2, attachment)              |
| POST   | /api/releases           | SuperUser | Upload an APK (raw body + X-Release-Version / X-Release-Notes / X-File-Name); keeps 5, purges older |
| DELETE | /api/releases/:id       | SuperUser | Delete a build                                |

**Image GETs are unauthenticated so `<img>` tags can load them; the ids are long
random tokens, which is the access control for these non-sensitive farm photos.

Cross-origin: the SPN OS mobile app calls the API from its WebView origin; the
Worker answers CORS for `https://localhost` / `capacitor://localhost` plus any
origins listed in the `ALLOWED_ORIGINS` var.

*`/api/setup` refuses once any user exists.

## Data reset (Super User)

Users & Access → Danger zone:

- **Clear all operational data**: wipes sowing, sales, leads, procurement,
  requisitions, staff, stock, scans, modelled history and the audit log for
  a fresh production-ready environment. Accounts, departments, organisation
  settings, the KRA PIN and the weather area are kept.
- **Factory reset**: wipes the whole database including accounts and returns
  the deployment to the first-run setup screen.

## Notes and limits

Deliberate simplifications that a larger rollout should revisit: no login
rate limiting, collection-level storage (writes carry the hash of the version
the device last synced; on a mismatch the Worker answers 409 and the client
merges per record before retrying, so concurrent sales/leads/sowing records
are not lost), and no server-side field validation beyond JSON shape.
ID/CV uploads are flags only; store real documents encrypted. Weather uses
the free Open-Meteo API.
