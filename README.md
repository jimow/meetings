# 📋 Meeting Signs — Geofenced Meeting Sign-In Sheets

A self-hosted web app where an **admin/meeting owner** creates a meeting, configures
the fields to capture, and shares a **short link or QR code**. Attendees open it,
fill in the form, and sign in — but **only if they are physically inside a geofenced
radius**, enforced on the server. Built with Node.js + Express + the built-in
`node:sqlite` database (no native build steps, no external DB).

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

> Requires **Node.js ≥ 22.5** (for the built-in SQLite module).

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
server.js              Express app: security middleware, routing, static serving
src/
  config.js            Env + auto-generated persistent secrets
  db.js                node:sqlite schema (admins, sessions, meetings, signins, audit_log)
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
    signin.js          Public meeting info + geofenced sign-in submission
public/
  admin/index.html     Admin SPA shell
  signin/index.html    Public sign-in page (QR/link target)
  static/              styles.css, admin.js, signin.js, 404.html
data/                  SQLite DB + secrets.json (gitignored, auto-created)
```

---

## Deploying

1. Put the app behind HTTPS (a reverse proxy like nginx/Caddy, or a platform that
   terminates TLS). Geolocation in browsers **requires a secure context** — it
   won't work over plain `http://` except on `localhost`.
2. Set environment variables (see `.env.example`):
   - `NODE_ENV=production`
   - `BASE_URL=https://your-domain` (so QR codes/links point to the right place)
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
