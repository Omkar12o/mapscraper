# Lead Finder

A lead-generation panel built on top of [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper).

Enter a niche/keyword (e.g. "NGO", "IT company", "coaching institute") and an Indian state, and get **all** matching businesses in that state as a clean list:

1. Business Name
2. Phone Number
3. Address
4. City / District
5. State

Nothing else — no reviews, ratings, websites, emails, or images.

## Architecture

| Service | Tech | Port |
|---|---|---|
| Scraper | `gosom/google-maps-scraper` (web / REST API mode) | 8080 |
| Backend | Node + Express + SQLite | 5000 |
| Frontend | React + Vite + TypeScript | 5173 |

The frontend **never calls the scraper directly** — it talks to the Node/Express backend, which:
- fans out one scraper job per city/district of the selected state (`"{niche} in {city}, {state}"`),
- polls each job until done,
- cleans & de-duplicates results,
- normalizes phone numbers to `+91XXXXXXXXXX`,
- drops rows without a phone and rows outside the selected state,
- stores every search + results in SQLite (history).

## Prerequisites

- Docker + Docker Compose
- (Optional, for local dev without Docker) Node.js 20+

## One-command start

```bash
cd lead-finder
docker compose up --build
```

Then open: **http://localhost:5173**

- Scraper API: http://localhost:8080
- Backend API: http://localhost:5000

Stop with:

```bash
docker compose down
```

## Run without Docker (local dev)

You still need the **scraper on port 8080** — without it the UI loads but every search fails.

```bash
# 1. Start the scraper (pick one)
docker run -p 8080:8080 gosom/google-maps-scraper -web -data-folder /gmapsdata
#    ...or use the local binary:
#    google-maps-scraper.exe -web -addr :8080 -data-folder webdata

# 2. Backend (port 5000)
cd backend
npm install
node server.js

# 3. Frontend (port 5173, proxies /api to :5000)
cd frontend
npm install
npm run dev
```

Then open **http://localhost:5173**.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to load states. Is the backend running on port 5000?` | Backend is not running | Start `backend` with `node server.js` |
| Search starts then all cities fail (`fetch failed`) | Scraper on `:8080` is not running | Start the scraper container/binary (see above) |
| `A search is already running` (409) | Only one search at a time is allowed | Stop the running search, or use **Clear stuck jobs** on the History page |
| Address already in use on `:5000` / `:8080` / `:5173` | Old process still running | Kill the old process, then start again |

## How search works

1. You enter a niche and pick an Indian state (all states + UTs included).
2. Optionally enter a city/district or a max-results cap.
3. The backend creates one scraper job **per city** of the state (`"{niche} in {city}, {state}"`) and runs them as a batch.
4. Live progress is shown: `queued / running / done`, `X of Y cities completed`, and a running lead count.
5. When finished, results are cleaned, de-duplicated (by phone, then by name+address), filtered to the selected state, and displayed.

## Data cleaning

- Rows without a phone number are dropped.
- Phones are normalized to `+91XXXXXXXXXX` (spaces/dashes removed).
- Duplicates removed by phone number, then by name+address.
- State is detected from the address; results outside the selected state are dropped.

## UI

- Big search bar on top (niche + state dropdown + optional city).
- Result count ("1,240 NGOs found in Maharashtra").
- Results table with: search/filter, sort by any column, pagination, total count.
- Each row: name, phone with a **Call** link (`tel:`) and a **Copy** button.
- Export: **CSV** and **Excel (.xlsx)** (Name, Phone, Address, City, State).
- **History** page: lists previous searches (niche, state, date, count) with re-download and retry for failed runs.

## WhatsApp Sender (optional)

The **WhatsApp Sender** page bulk-messages your saved leads over WhatsApp Web using
[Baileys](https://github.com/WhiskeySockets/Baileys). It is off until you link a device.

1. Open **WhatsApp Sender** in the sidebar and click **Connect**.
2. Scan the QR code with your phone: **WhatsApp → Linked devices → Link a device**.
   The credentials are saved in `backend/data/wa-session/`, so you only scan once.
3. Pick a state (and optionally a city), write a message template, then preview
   the recipients and start the campaign.
4. Before your first campaign, use the **Test message** card to send one real
   message to your own number. Test sends do not count toward the daily cap or
   campaign history.

**Template variables:** `{name}`, `{city}`, `{state}`, `{phone}`.

**Safety controls** (built in, do not remove):

| Control | Default | Notes |
|---|---|---|
| Delay between messages | 45 s | Adds 0–15 s random jitter; minimum 5 s |
| Daily cap (all campaigns) | 100 | Counted across every campaign for today |
| Max recipients per campaign | 50 | Set to `0` to use all eligible contacts |
| Duplicate protection | on | Skips numbers already sent/pending |
| Do-not-contact list | on | Skipped by every campaign |

> **Ban risk:** This uses the unofficial WhatsApp Web protocol, not the official
> Business API. WhatsApp may ban a number that sends bulk or unsolicited messages.
> Only contact people who opted in, use a dedicated number, keep delays at 30–60 s
> or more, and stay under ~100 messages/day. The app shows the same warning in the UI.

Only one campaign runs at a time. If WhatsApp disconnects mid-campaign the job is
paused automatically; reconnect and press **Resume**. A campaign also pauses when
the server restarts.

## Mail Sender (optional, SMTP)

The **Mail Sender** page emails the addresses found by **Mail Finder** through your
own SMTP account (Gmail/Workspace, Brevo, Resend, SendGrid, Mailgun, Amazon SES, …).
It is disabled until you configure SMTP.

### Configure SMTP in the app (recommended)

1. Open **http://localhost:5173 → Mail Sender**.
2. Click **Configure SMTP** and fill in host, port, username, password and From address.
   The From field accepts `you@gmail.com`, `Your Name <you@gmail.com>`, or just a
   name like `Your Name` (paired with the username email). It can also be left blank
   when the username is an email address.
3. Click **Save settings**, then **Send test email** to confirm the login.
4. No restart is needed — the settings take effect immediately.

- **Gmail:** use an [App Password](https://myaccount.google.com/apppasswords)
  (`smtp.gmail.com`, port `587`, implicit TLS off).
- **Brevo / Resend / SendGrid / Mailgun / SES:** use their SMTP host and API key
  as the password.
- Add an **Unsubscribe URL** to include a one-click `List-Unsubscribe` header.
- Settings are stored in `backend/data/mail-config.json` (mode `0600`, gitignored).
  The password is never returned to the browser. **Remove saved settings** deletes it.

### Configure SMTP with environment variables (optional)

Environment variables take priority over settings saved from the UI — useful for
Docker or headless deployments.

1. Copy the Mail Sender block from `backend/.env.example` into `backend/.env`.
2. Fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`.
3. Restart the backend. The page shows `(environment variables)` as the source.

> Running with Docker? Put the same `SMTP_*` / `MAIL_*` variables in a `.env` file at
> the repository root — `docker-compose.yml` passes them to the backend container.
> You can still configure SMTP from the page; it is saved inside the `/data` volume.

**Template variables:** `{name}`, `{business}`, `{city}`, `{state}`, `{email}`
(subject supports `{name}`, `{business}`, `{city}`).

**Safety controls:**

| Control | Default | Notes |
|---|---|---|
| Delay between emails | 45 s | Adds 0–10 s random jitter; minimum 5 s |
| Daily cap (all campaigns) | 50 | Counted across every campaign for today |
| Max recipients per campaign | 25 | Set to `0` to use all eligible addresses |
| Duplicate protection | on | Skips addresses already emailed/pending |
| Opt-out list | on | Skipped by every campaign |
| Auto opt-out footer | on | Added to every email |

**Troubleshooting:**

| Error | Fix |
|---|---|
| `getaddrinfo EAI_FAIL` / `ENOTFOUND` | The Host field contains an email address. Use the server name (e.g. `smtp.gmail.com`). |
| `EAUTH` / `535` / "invalid login" | Wrong username/password. For Gmail use a 16-character **App Password**, not your normal password. |
| `ETIMEDOUT` / `ECONNECTION` | Wrong host or port. Try `587` with implicit TLS off, or `465` with it on. |
| TLS / SSL error | Flip the "Use implicit TLS" checkbox to match the port. |

> **Deliverability:** cold email is heavily filtered. Use a separate sending domain,
> warm it up, and configure SPF, DKIM and DMARC. Typical safe cold-outreach volume is
> **20–50 emails/day per mailbox** — provider hard limits are higher, but inbox
> placement and account suspension are the real constraints. Never use your main
> Gmail/Outlook inbox for bulk sending.

Like the WhatsApp sender, only one mail campaign runs at a time. Auth/connection
failures pause the campaign so you can fix the settings and press **Resume**. A
server restart also pauses running campaigns, and any in-flight email is put back
in the queue.

## Configuration (.env / environment)

| Variable | Default | Description |
|---|---|---|
| PORT | 5000 | Backend port |
| SCRAPER_URL | http://localhost:8080 | Scraper REST API base URL |
| SCRAPER_MAX_TIME_SECONDS | 300 | Max seconds per scraper job |
| SCRAPER_DEPTH | 10 | Scroll depth per query (higher = more results) |
| SCRAPER_RADIUS | 10000 | Search radius in meters |
| MAX_RETRIES | 1 | Auto-retry count for failed cities |
| POLL_INTERVAL_MS | 5000 | Backend poll interval for job status |
| DB_PATH | ./data/leadfinder.db | SQLite history database path |
| VITE_API_BASE | /api | Frontend API base (dev proxy to backend) |
| SMTP_HOST | — | SMTP server (empty = Mail Sender disabled) |
| SMTP_PORT | 587 | SMTP port (465 enables TLS) |
| SMTP_SECURE | false | `true` for implicit TLS (port 465) |
| SMTP_USER | — | SMTP username |
| SMTP_PASS | — | SMTP password / API key |
| MAIL_FROM | SMTP_USER | From address, e.g. `Lead Finder <you@domain.com>` |
| MAIL_REPLY_TO | — | Optional reply-to address |
| MAIL_UNSUBSCRIBE_URL | — | Adds one-click `List-Unsubscribe` header + footer line |
| MAIL_DELAY_SECONDS | 45 | Default delay between emails |
| MAIL_DAILY_CAP | 50 | Default daily email cap |

> SMTP variables are optional: the same settings can be saved from the Mail Sender
> page into `backend/data/mail-config.json`. When both exist, environment variables
> win.

Rate/concurrency limits: each scraper job runs with `exit-on-inactivity 3m`, a depth of 10, and a 10 km radius. Jobs run one-at-a-time per city with retries, so the scraper is not overwhelmed.

## Project layout

```
lead-finder/
├── docker-compose.yml          # starts scraper + backend + frontend
├── backend/                    # Node/Express API
│   ├── server.js               # backend: fan-out, poll, clean, SQLite history
│   ├── whatsapp.js             # Baileys WhatsApp connection + message sender
│   ├── mailer.js               # SMTP transport for the Mail Sender
│   ├── providers.cjs           # multi-provider adapters (serper, serpapi, ...)
│   ├── cities.json             # all Indian states/UTs + major cities
│   ├── areas.json              # city -> areas mapping
│   ├── cityCoords.json         # city -> coordinates (provider search)
│   ├── package.json
│   └── Dockerfile
└── frontend/                   # React + Vite + TypeScript
    ├── src/
    │   ├── App.tsx             # finder + history pages
    │   ├── lib/api.ts          # backend API client
    │   └── main.tsx
    ├── package.json
    ├── vite.config.ts
    ├── nginx.conf              # serves the build + proxies /api to backend
    └── Dockerfile
```

## Notes

- Search requires the scraper service (`:8080`). The repo does **not** vendor the scraper binary — Docker Compose pulls it, or you run it separately.
- The SQLite database is created automatically on first start; it is intentionally **not** committed.
- Results take at least ~3 minutes to appear (the scraper's minimum configured runtime per job).
- Large states with many cities may take a while; the progress panel shows live status.
- For production use behind a proxy, add proxies to the scraper via `SCRAPER_URL` job config or the scraper's proxy options to avoid blocking.
