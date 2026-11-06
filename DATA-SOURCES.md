# Data Sources — Lead Finder

> **Last updated:** 2026-11-03
> This document explains exactly where every piece of data in the Lead Finder app comes from, and the legal/compliance notes you should know before using the data.

---

## 1. The contact data (name, phone, address, city, state)

| Item | Value |
|---|---|
| **Source** | **Google Maps** search results (scraped live, not an API) |
| **Scraper project** | `gosom/google-maps-scraper` (open source, MIT-style license) |
| **Repository link** | https://github.com/gosom/google-maps-scraper |
| **Local documentation** | `C:\Users\dell\Desktop\Scaper\google-maps-scraper\README.md` |
| **Binary used** | `C:\Users\dell\Desktop\Scaper\google-maps-scraper\google-maps-scraper-v2.exe` |
| **Scraper web console** | http://localhost:8080 |

**There is no third-party data provider, purchased list, or API key involved.**
Every row is fetched from Google Maps at the moment you run a search.

### 1.1 How the data is fetched (step by step)

```
User query (e.g. "NGO in Mumbai, Maharashtra")
        │
        ▼
Lead Finder backend (Node.js, port 5000)
        │  creates a scraper job
        ▼
google-maps-scraper (headless browser, port 8080)
        │  opens Google Maps search results
        │  scrolls the listing (-depth)
        │  extracts what Google publicly shows
        ▼
CSV file per query
        │
        ▼
Backend cleaning (cleanRows in server.js)
        │  • drop rows without a phone number
        │  • normalize phone → +91XXXXXXXXXX
        │  • keep only rows whose address matches the selected state
        │  • keep only rows whose address matches the selected city
        │    (when a city is chosen, e.g. Mumbai)
        │  • de-duplicate by phone, then by name + address
        ▼
SQLite database (backend/data/leadfinder.db)  →  shown in the UI / exported
```

### 1.2 Fields taken from Google Maps

Exactly these five columns are stored and exported:

| Column | Where it comes from |
|---|---|
| Business Name | Google Maps listing title |
| Phone Number | Listing's phone field, normalized to `+91XXXXXXXXXX` |
| Address | Listing's street address |
| City | Derived from the address / query city |
| State | Derived from the address, verified against the selected state |

### 1.3 Scraper options used (documented in the README)

From `google-maps-scraper/README.md` (lines ~498–536):

| Flag | Purpose | Value used |
|---|---|---|
| `-c` | Concurrent scrape jobs | `4`–`10` |
| `-depth` | Max scroll depth of results | `100` (high = more rows) |
| `-lang` | Search language | `en` |
| `-exit-on-inactivity` | Auto-close finished queries | `3m`/`5m` |
| `-geo`, `-radius`, `-zoom` | Geographic tile search (Level 4 grid) | per tile |
| `-fast-mode` | **Not used** — reduces data / may drop phone numbers | — |

---

## 2. Cities / states / areas (search-query building only)

These are **local reference files**, not scraped data. They are only used to
generate the list of search queries (L1 cities, L2 areas, L4 geo tiles):

| File | Contents |
|---|---|
| `lead-finder/backend/cities.json` | Indian states → list of cities |
| `lead-finder/backend/areas.json` | Major cities → localities/pincodes (Andheri, Bandra, Kothrud…) |

---

## 3. What is NOT used

- ❌ No purchased lead lists / data brokers
- ❌ No Google Places API (the paid, compliant option)
- ❌ No social media scraping
- ❌ No personal/private databases — only what Google Maps displays publicly

---

## 4. Legal & compliance notes (read before using the data)

1. **Google Terms of Service** — automated scraping of Google Maps is
   generally not permitted.
   👉 https://policies.google.com/terms (see section 3, "Restrictions")
2. **Official compliant alternative** — Google Places API (paid):
   👉 https://developers.google.com/maps/documentation/places/web-service
3. **Personal data** — phone numbers are personal data. If you contact people
   obtained from this tool, comply with:
   - India's **DPDP Act, 2023**
   - **GDPR** (if any EU individuals are involved)
   - Do-not-call / spam regulations in your country
4. **Use responsibly** — keep the data for legitimate business use only,
   honor opt-out requests, and do not resell the raw data.

---

## 5. Quick reference — all local paths

```
C:\Users\dell\Desktop\Scaper\
├── google-maps-scraper\
│   ├── README.md                       ← scraper documentation
│   ├── google-maps-scraper-v2.exe      ← scraper binary (patched, -c 4)
│   └── runner\webrunner\webrunner.go   ← patched concurrency runner
└── lead-finder\
    ├── DATA-SOURCES.md                 ← this file
    ├── backend\
    │   ├── server.js                   ← cleaning + filtering logic
    │   ├── cities.json                 ← state → cities
    │   ├── areas.json                  ← city → localities
    │   └── data\leadfinder.db          ← SQLite (saved contacts)
    └── frontend\                       ← UI (React + Vite)
```
