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
- **Farm plots**: fields with crop, variety, area, date of planting, a live
  crop-day counter, FAO-56 development stage, expected harvest and rainfall
  since planting; one click hands a plot to the irrigation calculator.
- **Rain gauge**: actual rainfall received (mm) logged per event, with weekly,
  monthly and year-to-date totals feeding the farm report.
- **Report viewers**: reports are visible by role, and admins can additionally
  grant individual users viewing rights per report (the Farm Plots report is
  assignment-only by default).
- **Responsive**: off-canvas sidebar with a hamburger toggle on mobile; on
  desktop the same toggle detaches or docks the sidebar (preference saved).

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
(replace `REPLACE_WITH_D1_DATABASE_ID`), then:

```bash
npx wrangler deploy
```

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
| POST   | /api/users/password     | Admin     | Issue a temporary password                    |
| GET    | /api/state              | Bearer    | Full workspace (users + collections)          |
| PUT    | /api/collections/:name  | Bearer    | Upsert one collection (granular sync)         |
| PUT    | /api/users              | Admin     | Replace user list (auth columns preserved)    |
| POST   | /api/reset              | SuperUser | `{mode:'operational'|'factory'}`              |
| POST   | /api/ai                 | Bearer    | Proxy to the Anthropic Messages API           |

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
rate limiting, collection-level (not row-level) write granularity with
last-write-wins, and no server-side field validation beyond JSON shape.
ID/CV uploads are flags only; store real documents encrypted. Weather uses
the free Open-Meteo API.
