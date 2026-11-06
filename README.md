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

Rate/concurrency limits: each scraper job runs with `exit-on-inactivity 3m`, a depth of 10, and a 10 km radius. Jobs run one-at-a-time per city with retries, so the scraper is not overwhelmed.

## Project layout

```
lead-finder/
├── docker-compose.yml          # starts scraper + backend + frontend
├── backend/                    # Node/Express API
│   ├── server.js               # backend: fan-out, poll, clean, SQLite history
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
