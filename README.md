# 📋 Meeting Signs — County Government of Mandera

A self-hosted web platform where an **admin/meeting owner** creates a meeting, configures
the fields to capture, and shares a **short link or QR code**. Attendees open it,
fill in the form, and sign in — but **only if they are physically inside a geofenced
radius**, enforced on the server. Includes a **public website**, **PDF/Word/CSV exports**,
and **SMS + email notifications**.

Built with Node.js + Express. Runs on the built-in `node:sqlite` out of the box, or on
**Supabase (Postgres)** in production — selected with one environment variable.

**Includes:**
- Public marketing website (home / about / contact / privacy) branded for the **County Government of Mandera**
- Geofenced sign-in with layered security
- Configurable capture fields per meeting
- Branded PDF, Word and CSV attendance exports (logo, org name, venue, dates)
- **Resend** email + **Africa's Talking** SMS notifications on sign-in
- Pluggable backend: **SQLite** (default) or **Supabase**

---

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:3000/admin**.

1. The first visit prompts you to **create the owner admin account** (min 10-char password).
2. Click **+ New meeting**, set the title, fields, and geofence.
   - Use **📍 Use my current location** to drop the geofence center on where you are,
     or paste a latitude/longitude.
3. Open the meeting to get its **QR code** and **shareable link** (`/m/<slug>`).
4. Share the QR/link. Attendees sign in from their phones.
5. Watch sign-ins arrive live; **export to PDF, Word, or CSV** anytime.

### Branding your attendance sheets

Click **🏢 Branding** on the meetings page to set, once, for all your exports:

- **Logo** (PNG/JPEG, < 1 MB) — printed top-left of every document
- **Organization name**, **address**, and a **contact line** — the document header
- **Footer text** — printed with the page number on every page

Each meeting also has a **Venue** field and **Opens/Closes** dates. The generated
PDF and Word **Attendance / Sign-In Sheet** shows:

```
[logo]   Organization name
         Address · Contact

         Attendance / Sign-In Sheet
         Meeting:  <title>
         Venue:    <venue, falls back to location name>
         Date:     <meeting date / range>
         Total attendees: N · Within geofence: M · Generated: <timestamp>

         ┌────┬───────────┬──────────┬──────────────┬──────────┐
         │ #  │ Full name │ Email    │ Signed in at │ Location │
         └────┴───────────┴──────────┴──────────────┴──────────┘
                                       ... footer · Page 1 of N
```

The table columns are built automatically from the fields you configured for that
meeting, plus the sign-in time and geofence result.

The public website is at **/** ; staff/admin is at **/admin**.

> Requires **Node.js ≥ 18**. (On Node < 22, the bundled `ws` package supplies the
> global `WebSocket` the Supabase client needs — installed automatically.)

---

## Backend: Supabase (required)

All data lives in **Supabase (Postgres)**. There is no local database.

1. Create a Supabase project.
2. Open the SQL Editor and run [`supabase/schema.sql`](supabase/schema.sql).
3. Set these env vars (use the **service-role** key — server-side only, never in a browser):
   ```
   SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```
4. `npm install && npm start`. The app validates the connection on boot and exits
   with a clear message if it can't reach Supabase or the schema is missing.

Verify connectivity any time with:
```
npm run check:supabase
```

> The data layer lives in `src/store/` behind a single contract, so the rest of the
> app never talks to Supabase directly.

---

## Notifications (Resend + Africa's Talking)

When someone signs in, the platform can send confirmations. Each meeting has four
independent toggles (set in the meeting editor): **attendee email**, **attendee SMS**,
**owner email**, **owner SMS**. A channel only fires if (a) its toggle is on, (b) the
matching field exists on the meeting (email/phone), and (c) the server has the API keys.

- **Email — Resend:** set `RESEND_API_KEY` and `RESEND_FROM` (a verified-domain sender).
- **SMS — Africa's Talking:** set `AT_USERNAME` and `AT_API_KEY` (use `sandbox` for testing;
  the app auto-routes to the sandbox API). Optional `AT_SENDER_ID` for a registered sender.
- Phone numbers are normalized to Kenyan E.164 (`+2547XXXXXXXX`) automatically.
- The website **contact form** also emails `CONTACT_TO` via Resend.

All sends are **best-effort and non-blocking** — a failed SMS/email never blocks or
fails a sign-in; failures are logged.

---

## How the geofence works (and its limits)

- Each meeting stores a center `lat/lng`, a `radius` (meters), and a
  `max GPS accuracy` threshold.
- The attendee's browser captures GPS via the Geolocation API and sends
  `lat/lng/accuracy` to the server.
- **The server is the authority.** It computes the Haversine distance and decides
  allowed/denied. The browser never makes the call, and the exact center
  coordinates are **never sent to attendees** (only the radius), which limits
  trivial spoofing.
- Sign-ins with GPS accuracy worse than the threshold are **rejected**; suspicious
  ones (e.g. reported accuracy of exactly 0 — a spoofing hallmark, or accuracy
  larger than the fence) are **stored but flagged ⚑** for admin review.

**Honest limitation:** browser geolocation can be faked by a determined user with
developer tools or a mock-location app. No web app can fully prevent this. The
mitigations here (server-side checks, accuracy thresholds, hidden center,
flagging, device + IP logging) raise the bar substantially. For hard guarantees
you need a native app with OS location attestation or on-site hardware (NFC/beacon).

---

## Security features

| Area | What's implemented |
|---|---|
| **Geofencing** | Authoritative server-side Haversine check; center coords hidden from clients; accuracy threshold; spoof-signature flagging |
| **Admin auth** | bcrypt password hashing (cost 12), min-length enforcement, account lockout after repeated failures |
| **Sessions** | HMAC-signed httpOnly + SameSite=strict cookies, server-side session store with revocation, "active sessions" management UI, auto-expiry cleanup |
| **CSRF** | Double-submit token required on all state-changing admin requests |
| **Rate limiting** | Per-route limits on login, sign-in submission, and a global API backstop |
| **Headers** | Helmet with a strict Content-Security-Policy (no inline scripts), no `x-powered-by`, clickjacking protection (`frame-ancestors 'none'`) |
| **Input safety** | Strict validation of every field + meeting setting; payload size caps; JSON parse guards |
| **Abuse controls** | Optional passcode per meeting (bcrypt-hashed), duplicate prevention by email and/or device fingerprint, open/close windows, manual open/close toggle |
| **Data handling** | PDF / Word / CSV export; CSV hardened against spreadsheet formula injection; optional IP recording; security audit log table |

### Export formats

| Format | Endpoint | Notes |
|---|---|---|
| **PDF** | `/api/meetings/:id/export.pdf` | Branded, landscape, paginated. Generated with PDFKit (pure JS). Standard fonts are Latin-only — non-Latin text (e.g. CJK) is replaced with `?`; use Word for full Unicode. |
| **Word** | `/api/meetings/:id/export.docx` | Branded `.docx` with a repeating header/footer and a bordered table. Full Unicode support. |
| **CSV** | `/api/meetings/:id/export.csv` | Raw data for spreadsheets, with a UTF-8 BOM and formula-injection guard. |

All three require the owner to be logged in and use the meeting's configured fields
as columns plus sign-in time and geofence result.

---

## Users & roles

There are two roles:

| Role | Sees | Can |
|---|---|---|
| **admin** (the first account; legacy `owner` counts as admin) | **All** meetings from every host | Manage users, view/edit/export any meeting |
| **user** | **Only the meetings they created** | Create & manage their own meetings |

- The **first account ever registered becomes the admin**. Every account after that is a **user**.
- Admins manage accounts on the **👥 Users** page: add a user (name, email, temporary password, role), promote/demote, or delete (deleting a user removes their meetings too). The last admin cannot be removed/demoted.
- **Self-registration** is off by default (admins create accounts). Set `ALLOW_OPEN_REGISTRATION=true` to let staff register themselves from the login page — new self-registered accounts are always `user`.
- Ownership is enforced server-side: a user requesting another user's meeting (view, edit, export, sign-in list) gets `404`. Admins are allowed through.

## Sign-in sheet document — header & layout

Every exported PDF / Word attendance sheet uses the **host's branding** (set on the
🏢 **Branding** page) and contains, top to bottom:

1. **Logo** (top-left of every page)
2. **Organization name**, **address**, **contact line** — the letterhead
3. **Document title** — "Attendance / Sign-In Sheet"
4. **Meeting**, **Venue**, **Date**, and **Organizer / Host** (the meeting owner's name)
5. **Summary** — total attendees, within-geofence count, generated timestamp
6. **Attendee table** — the meeting's configured fields + sign-in time + location result
7. **Footer** — the host's footer text + "Page X of N", on every page

Each host sets their own logo and details, and new accounts are pre-seeded with the
County's default letterhead (configurable via `ORG_NAME` / `ORG_ADDRESS` / `ORG_CONTACT`
/ `ORG_FOOTER`).

## Admin-configurable per meeting

- **Title, description, location name, venue**
- **Fields to capture** — any number of: text, email, tel, number, textarea,
  select (with options), checkbox, date; each optionally required
- **Geofence** — on/off, center lat/lng, radius, max GPS accuracy
- **Window** — opens-at / closes-at timestamps + manual open/close
- **Passcode** — optional shared secret
- **Duplicate prevention** — unique email and/or one-per-device
- **Privacy** — toggle IP recording

---

## Project layout

```
server.js              Express app: security middleware, routing, website + API
src/
  config.js            Env + auto-generated persistent secrets
  store/
    index.js           Loads the Supabase store + .env
    supabase.js        Supabase (Postgres) data-store implementation
  ws-polyfill.js       Provides global WebSocket from `ws` on Node < 22
  notify.js            Resend (email) + Africa's Talking (SMS) senders + dispatch
  auth.js              Password hashing, signed sessions, CSRF, middleware
  geo.js               Haversine + authoritative geofence evaluation
  validate.js          Field-definition and submission validation
  util.js              IDs, slugs, constant-time compare, audit log
  docgen.js            Branded PDF (PDFKit) + Word (docx) attendance sheets
  imagesize.js         Dependency-free PNG/JPEG dimension reader (for logos)
  routes/
    auth.js            Register / login / logout / me / sessions
    branding.js        Org name/address/contact/footer + logo upload
    meetings.js        Admin CRUD, QR PNG, sign-in list, PDF/Word/CSV export
    signin.js          Public meeting info + geofenced sign-in + notifications
    contact.js         Public website contact form (stores + emails county)
supabase/
  schema.sql           Postgres schema to run in the Supabase SQL editor
public/
  site/                Public website: index/about/contact/privacy (Mandera)
  admin/index.html     Admin SPA shell
  signin/index.html    Public sign-in page (QR/link target)
  static/              styles.css, site.css, admin.js, signin.js, site*.js, 404.html
data/                  SQLite DB + secrets.json (gitignored, auto-created)
```

---

## Deploying

1. Put the app behind HTTPS (a reverse proxy like nginx/Caddy, or a platform that
   terminates TLS). Geolocation in browsers **requires a secure context** — it
   won't work over plain `http://` except on `localhost`.
2. Set environment variables (see `.env.example`):
   - `NODE_ENV=production`
   - `BASE_URL` — **optional.** Leave it unset and share links/QR codes are built from
     the domain each request arrives on (so a deployed instance uses its real domain,
     and local runs use `localhost`). Set it only to pin a fixed canonical origin,
     e.g. `https://signin.mandera.go.ke`. ⚠ Do **not** leave it set to a `localhost`
     value in production, or every shared link will point at localhost.
   - `FORCE_SECURE_COOKIES=true` if TLS is terminated upstream
3. `npm start` (or run under a process manager / systemd / pm2).

The app trusts one proxy hop (`trust proxy = 1`) so client IPs and the secure
flag are read from `X-Forwarded-*`. Adjust in `server.js` if your topology differs.

---

## Notes

- The SQLite module prints an `ExperimentalWarning` on startup — that's expected
  for Node's built-in SQLite and is harmless.
- All data lives in `data/meeting-signs.db`. Back it up to back up everything.
- To reset completely, stop the app and delete the `data/` folder.
