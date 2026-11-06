import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import { createRequire } from 'module';
import ExcelJS from 'exceljs';
import path from 'node:path';
import * as wa from './whatsapp.js';
import * as mailer from './mailer.js';

const { Workbook } = ExcelJS;

const require = createRequire(import.meta.url);
const citiesData = require('./cities.json');
const areasData = require('./areas.json');
const cityCoords = require('./cityCoords.json');
const { PROVIDER_META, TOPUP_ORDER, ADAPTERS, testKey } = require('./providers.cjs');

const PORT = process.env.PORT || 5000;
const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:8080';
const SCRAPER_MAX_TIME = parseInt(process.env.SCRAPER_MAX_TIME_SECONDS || '600', 10);
const SCRAPER_DEPTH = parseInt(process.env.SCRAPER_DEPTH || '100', 10);
const SCRAPER_RADIUS = parseInt(process.env.SCRAPER_RADIUS || '15000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
// A single deep search is allowed to run at a time.
let currentRunId = null;
// Which provider is currently running (for progress card).
let currentProvider = 'gosom';
// Watchdog: kill a job that has not produced results within this window.
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || String(10 * 60 * 1000), 10);
// True while a deep-search level plan is executing (suppress auto-next until done).
let deepPlanActive = false;
// Runs that finished below their target but exhausted all expandable levels.
const runExhaustedMap = new Map();

// Satellite cities for metros — used to filter out satellite results when
// searching a specific metro city (e.g. drop Navi Mumbai/Thane from "Mumbai").
const CITY_SATELLITES = {
  mumbai: ['navi mumbai', 'thane', 'kalyan', 'dombivali', 'ulhasnagar', 'badlapur', 'panvel', 'vasai', 'virar', 'mira bhayandar'],
  delhi: ['noida', 'gurugram', 'gurgaon', 'faridabad', 'ghaziabad'],
  bengaluru: [],
  pune: ['pimpri chinchwad', 'pimpri', 'chinchwad'],
  hyderabad: [],
};

const DB_PATH = process.env.DB_PATH || './data/leadfinder.db';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------- keyword variants ----------
const KEYWORD_VARIANTS = {
  ngo: ['NGO', 'charitable trust', 'foundation', 'welfare society', 'social organization', 'orphanage', 'non profit organization'],
  school: ['school', 'international school', 'play school', 'preschool', 'kindergarten', 'montessori school'],
  hospital: ['hospital', 'clinic', 'nursing home', 'diagnostic center', 'multi speciality hospital', 'eye hospital', 'dental clinic'],
  'it company': ['IT company', 'software company', 'web development company', 'digital marketing agency', 'web design company'],
  'coaching institute': ['coaching institute', 'tuition center', 'competitive exam coaching', 'IAS coaching', 'NEET coaching', 'JEE coaching'],
  ca: ['CA', 'Chartered Accountant', 'Chartered Accountants', 'CA Firm', 'Audit Firm', 'Chartered Accountants Network'],
  ceo: ['CEO', 'Chief Executive Officer', 'Managing Director', 'Founder', 'Founder & CEO', 'MD'],
  'business person': ['Business Person', 'Founder', 'Managing Director', 'Director', 'CEO', 'Executive'],
  enterprise: ['Enterprise', 'Private Limited', 'Pvt Ltd', 'LLP', 'Limited Company', 'Private Limited Company'],
  'pvt ltd': ['Pvt Ltd', 'Private Limited', 'Private Limited Company', 'LLP', 'Partnership Firm', 'Proprietorship'],
};

function getKeywordVariants(niche) {
  const raw = String(niche || '');
  const key = raw.toLowerCase().trim();
  if (KEYWORD_VARIANTS[key]) return KEYWORD_VARIANTS[key];
  // Tolerant lookup so "ITCompany", "PvtLtd" or "CA" style inputs still resolve.
  const compact = key.replace(/[^a-z0-9]/g, '');
  const match = Object.keys(KEYWORD_VARIANTS).find((k) => k.replace(/[^a-z0-9]/g, '') === compact);
  if (match) return KEYWORD_VARIANTS[match];
  return [raw];
}

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  niche TEXT NOT NULL,
  state TEXT NOT NULL,
  city TEXT,
  max_results INTEGER,
  deep_search INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',
  total_cities INTEGER DEFAULT 0,
  completed_cities INTEGER DEFAULT 0,
  failed_cities INTEGER DEFAULT 0,
  result_count INTEGER DEFAULT 0,
  raw_rows INTEGER DEFAULT 0,
  duplicates_removed INTEGER DEFAULT 0,
  current_area TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scraper_job_id TEXT,
  city TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  retries INTEGER DEFAULT 0,
  raw_rows INTEGER DEFAULT 0,
  dups_removed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  address TEXT,
  state TEXT,
  city TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_results_run_phone ON results(run_id, phone);
CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_run_jobs_run ON run_jobs(run_id);
`);

// ---------- multi-provider settings & counts ----------
db.exec(`
CREATE TABLE IF NOT EXISTS provider_settings (
  provider TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 0,
  api_key TEXT DEFAULT '',
  used INTEGER DEFAULT 0,
  limit_val INTEGER DEFAULT 0,
  period TEXT DEFAULT 'monthly',
  reset_at TEXT,
  name TEXT,
  signup_url TEXT
);
CREATE TABLE IF NOT EXISTS run_provider_counts (
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  new_contacts INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, provider)
);
`);

// Seed default provider settings (idempotent).
const seedProviders = db.prepare(`
  INSERT OR IGNORE INTO provider_settings (provider, enabled, api_key, used, limit_val, period, reset_at, name, signup_url)
  VALUES (?,?,?,?,?,?,?,?,?)
`);
for (const [key, meta] of Object.entries(PROVIDER_META)) {
  seedProviders.run(key, key === 'gosom' || key === 'overpass' || key === 'sherlock' ? 1 : 0, '', 0, meta.limit, meta.period, null, meta.name, meta.signup);
}

// Add columns for existing databases
try { db.exec('ALTER TABLE run_jobs ADD COLUMN raw_rows INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE run_jobs ADD COLUMN dups_removed INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE runs ADD COLUMN raw_rows INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE runs ADD COLUMN duplicates_removed INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE runs ADD COLUMN current_area TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE runs ADD COLUMN deep_search INTEGER DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE results ADD COLUMN dedupe_key TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE results ADD COLUMN emails TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE results ADD COLUMN website TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE runs ADD COLUMN level INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE run_jobs ADD COLUMN level INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE runs ADD COLUMN exhausted INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE run_jobs ADD COLUMN failure_reason TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE runs ADD COLUMN job_type TEXT DEFAULT \'lead\''); } catch (_) {}

// Mail Finder tables
const createMailTables = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_jobs (
      id TEXT PRIMARY KEY,
      niche TEXT NOT NULL,
      state TEXT NOT NULL,
      city TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      results_found INTEGER DEFAULT 0,
      websites_checked INTEGER DEFAULT 0,
      websites_with_email INTEGER DEFAULT 0,
      current_website TEXT,
      error_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_results (
      id TEXT PRIMARY KEY,
      mail_job_id TEXT NOT NULL,
      business_name TEXT NOT NULL,
      email TEXT,
      type TEXT DEFAULT 'generic',
      status TEXT DEFAULT 'pending',
      phone TEXT,
      website TEXT,
      city TEXT,
      state TEXT,
      address TEXT,
      found_on TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (mail_job_id) REFERENCES mail_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mail_results_job ON mail_results(mail_job_id);
    CREATE INDEX IF NOT EXISTS idx_mail_results_email ON mail_results(email);
    CREATE INDEX IF NOT EXISTS idx_mail_results_status ON mail_results(status);
    CREATE INDEX IF NOT EXISTS idx_mail_results_name ON mail_results(mail_job_id, business_name);
    CREATE TABLE IF NOT EXISTS mail_job_businesses (
      mail_job_id TEXT NOT NULL,
      business_key TEXT NOT NULL,
      had_email INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (mail_job_id, business_key)
    );
    CREATE INDEX IF NOT EXISTS idx_mail_job_businesses_job ON mail_job_businesses(mail_job_id);
  `);
};
createMailTables();

// Columns added after the first Mail Finder release.
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN run_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN stage TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN businesses_total INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN businesses_checked INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN businesses_with_email INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN pages_crawled INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN emails_total INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE mail_jobs ADD COLUMN source TEXT'); } catch (_) {}

// WhatsApp bulk sender tables
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_jobs (
      id TEXT PRIMARY KEY,
      template TEXT NOT NULL,
      delay_seconds INTEGER DEFAULT 30,
      daily_cap INTEGER DEFAULT 100,
      total INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wa_messages (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      name TEXT,
      phone TEXT NOT NULL,
      city TEXT,
      state TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      wa_message_id TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES wa_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wa_messages_job ON wa_messages(job_id);
    CREATE INDEX IF NOT EXISTS idx_wa_messages_status ON wa_messages(status);
    CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone);
    CREATE TABLE IF NOT EXISTS wa_blacklist (
      phone TEXT PRIMARY KEY,
      reason TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

// Mail Sender tables (separate from the Mail Finder tables above).
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_sender_jobs (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      template TEXT NOT NULL,
      delay_seconds INTEGER DEFAULT 45,
      daily_cap INTEGER DEFAULT 50,
      total INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_sender_messages (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      business_name TEXT,
      email TEXT NOT NULL,
      city TEXT,
      state TEXT,
      subject TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      smtp_message_id TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES mail_sender_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mail_sender_messages_job ON mail_sender_messages(job_id);
    CREATE INDEX IF NOT EXISTS idx_mail_sender_messages_status ON mail_sender_messages(status);
    CREATE INDEX IF NOT EXISTS idx_mail_sender_messages_email ON mail_sender_messages(email);
    CREATE TABLE IF NOT EXISTS mail_sender_blacklist (
      email TEXT PRIMARY KEY,
      reason TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

// Backfill dedupe keys, drop duplicates left by older versions, then enforce
// uniqueness per run. This keeps results clean even when the same business is
// returned by many areas / keyword variants.
{
  const backfill = db.transaction(() => {
    const rows = db.prepare('SELECT id, run_id, name, address FROM results').all();
    const seen = new Set();
    const update = db.prepare('UPDATE results SET dedupe_key=? WHERE id=?');
    const remove = db.prepare('DELETE FROM results WHERE id=?');
    for (const row of rows) {
      const key = dedupeKey(row.name, row.address);
      const scoped = `${row.run_id}|${key}`;
      if (seen.has(scoped)) {
        remove.run(row.id);
        continue;
      }
      seen.add(scoped);
      update.run(key, row.id);
    }
  });
  backfill();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_results_run_dedupe ON results(run_id, dedupe_key)');
  db.exec('UPDATE runs SET result_count = (SELECT COUNT(*) FROM results WHERE results.run_id = runs.id)');

  // ---------- fix legacy runs: "done" with 0 contacts → "failed" ----------
  {
    const bad = db
      .prepare("SELECT id FROM runs WHERE status='done' AND result_count=0")
      .all();
    if (bad.length) {
      const upd = db.prepare("UPDATE runs SET status='failed', updated_at=? WHERE id=?");
      const now = nowIso();
      for (const r of bad) upd.run(now, r.id);
      console.log(`Fixed ${bad.length} legacy "done with 0 contacts" runs → failed`);
    }
  }
}

const insert = db.prepare(
  'INSERT INTO results(id, run_id, name, phone, address, state, city, dedupe_key, emails, website, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
);
const insertJob = db.prepare(
  'INSERT INTO run_jobs(id, run_id, scraper_job_id, city, query, status, retries, level, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
);
const updateJob = db.prepare(
  'UPDATE run_jobs SET status=?, retries=?, updated_at=? WHERE id=?'
);
const updateRun = db.prepare(
  'UPDATE runs SET status=?, completed_cities=?, failed_cities=?, result_count=?, raw_rows=?, duplicates_removed=?, current_area=?, level=?, updated_at=? WHERE id=?'
);

// ---------- state / city helpers ----------
const STATES = citiesData.states;

function findState(nameOrCode) {
  if (!nameOrCode) return null;
  const s = String(nameOrCode).trim();
  return (
    STATES.find((st) => st.name.toLowerCase() === s.toLowerCase()) ||
    STATES.find((st) => st.code.toLowerCase() === s.toLowerCase()) ||
    null
  );
}

function normalizeStateName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
const STATE_BY_NORMALIZED = new Map();
for (const st of STATES) {
  STATE_BY_NORMALIZED.set(normalizeStateName(st.name), st.name);
  STATE_BY_NORMALIZED.set(normalizeStateName(st.code), st.name);
}

function getCitiesForState(stateName) {
  const st = findState(stateName);
  if (!st) return [];
  return st.cities;
}

// ---------- phone normalization ----------
function normalizePhone(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/[^0-9+]/g, '');
  s = s.replace(/^\+/, '');
  s = s.replace(/^0+/, '');
  if (s.startsWith('91') && s.length === 12) s = s.slice(2);
  if (s.length === 10) return '+91' + s;
  if (s.length > 10) return '+91' + s.slice(-10);
  return s;
}

// ---------- duplicate detection ----------
// Compare names/addresses ignoring case, spacing and punctuation so that
// "Kothrud, Pune" and "kothrud pune" are treated as the same place.
function normalizeKeyPart(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function dedupeKey(name, address) {
  return `${normalizeKeyPart(name)}|${normalizeKeyPart(address)}`;
}

function getCityAreas(city) {
  return areasData[city] || [];
}

function cleanCityName(value, stateName) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const cities = (stateName ? (getCitiesForState(stateName) || []) : []).map((c) =>
    String(c).toLowerCase()
  );
  // 1. Prefer a part that is a known city of the state.
  for (const p of parts) {
    if (cities.includes(p.toLowerCase())) return p;
  }
  // 2. Prefer a part that is a known satellite city of another part (metro).
  for (const p of parts) {
    const pl = p.toLowerCase();
    for (const [metro, sats] of Object.entries(CITY_SATELLITES)) {
      if (sats.includes(pl)) return p;
    }
  }
  // 3. Fallback: last part (Google's "Neighbourhood, City" convention).
  return parts.length > 0 ? parts[parts.length - 1] : '';
}


// ---------- state detection from address ----------
function detectState(address, completeAddress) {
  let detected = '';
  if (completeAddress) {
    try {
      const ca = JSON.parse(completeAddress);
      if (ca && ca.state) detected = ca.state;
    } catch (_) {
      // ignore
    }
  }
  if (!detected && address) {
    const text = address + ' ' + (completeAddress || '');
    for (const [norm, canon] of STATE_BY_NORMALIZED) {
      if (norm && new RegExp('\\b' + norm.replace(/[^a-z0-9]/g, '\\W') + '\\b', 'i').test(text)) {
        detected = canon;
        break;
      }
      if (norm.length <= 4 && new RegExp('\\b' + norm + '\\b', 'i').test(text)) {
        detected = canon;
        break;
      }
    }
  }
  return detected;
}

// ---------- scraper api ----------
async function scraperRequest(path, opts = {}) {
  const url = SCRAPER_URL.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`scraper ${res.status}: ${text || res.statusText}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// Remove a queued scraper job. Used when a run is stopped so abandoned cities
// do not keep blocking the single-threaded scraper queue.
async function deleteScraperJob(id) {
  if (!id) return;
  try {
    const res = await fetch(`${SCRAPER_URL.replace(/\/$/, '')}/api/v1/jobs/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      console.error(`delete scraper job ${id}: ${res.status}`);
    }
  } catch (err) {
    console.error(`delete scraper job ${id}:`, err.message);
  }
}

// Drop scraper jobs that can no longer produce results: jobs from deleted runs,
// and queued jobs belonging to finished / stopped runs. Without this, old jobs
// sit at the front of the scraper queue and make new searches look stuck.
async function cleanupScraperQueue() {
  let jobs;
  try {
    jobs = await scraperRequest('/api/v1/jobs');
  } catch (err) {
    console.error('cleanup scraper queue:', err.message);
    return;
  }
  if (!Array.isArray(jobs)) return;

  const refs = new Set(
    db
      .prepare('SELECT scraper_job_id FROM run_jobs WHERE scraper_job_id IS NOT NULL')
      .all()
      .map((r) => r.scraper_job_id)
  );
  const terminalRefs = new Set(
    db
      .prepare(
        `SELECT j.scraper_job_id FROM run_jobs j JOIN runs r ON r.id = j.run_id
         WHERE r.status IN ('done','stopped','failed') AND j.scraper_job_id IS NOT NULL`
      )
      .all()
      .map((r) => r.scraper_job_id)
  );

  let removed = 0;
  for (const job of jobs) {
    if (!job || job.Status === 'ok') continue;
    if (!String(job.Name || '').startsWith('leadfinder:')) continue;
    const isActive = refs.has(job.ID) && !terminalRefs.has(job.ID);
    if (isActive) continue;
    await deleteScraperJob(job.ID);
    removed += 1;
  }
  if (removed > 0) console.log(`cleaned up ${removed} abandoned scraper job(s)`);
}

// ---------- email utilities for Mail Finder ----------

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Non-global copy: RegExp.test() on a global regex keeps lastIndex state and
// silently returns false for every second call. Always test with this one.
const EMAIL_TEST = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const JUNK_EMAIL_PATTERNS = [
  /example\.(com|org|net)$/i,
  /^(test|user|name|email|your|someone)@/i,
  /sentry/i,
  /wixpress/i,
  /placeholder/i,
  /@domain\.com$/i,
  /@(sentry\.io|wixpress\.com|email\.com)$/i,
  /@2x\.(png|jpg|jpeg|gif|svg|webp)$/i,
  /\.(png|jpg|jpeg|gif|svg|webp)$/i,
];
const GENERIC_PREFIXES = ['info', 'contact', 'sales', 'admin', 'support', 'help', 'hello', 'inquiry', 'enquiry', 'office', 'mail', 'team', 'careers', 'hr'];
const MX_CACHE = new Map();
const ROBOTS_CACHE = new Map();

function isValidEmailSyntax(email) {
  return EMAIL_TEST.test(String(email || '').trim());
}

function isJunkEmail(email) {
  if (!email || !isValidEmailSyntax(email)) return true;
  const lower = String(email).toLowerCase();
  return JUNK_EMAIL_PATTERNS.some((pat) => pat.test(lower));
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x40;|&#64;|&commat;/gi, '@')
    .replace(/&#x2e;|&#46;|&period;/gi, '.')
    .replace(/&#x2d;|&#45;/gi, '-')
    .replace(/&nbsp;/gi, ' ')
    .replace(/%40/gi, '@');
}

function deobfuscateEmail(text) {
  if (!text) return [];
  const html = decodeHtmlEntities(text);
  const results = [];
  const deobf = html
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\{\s*at\s*\}\s*/gi, '@')
    .replace(/\s+at\s+(?=[a-z0-9-]+\s*(?:\.|\[dot\]|\(dot\)))/gi, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    .replace(/\s*\{\s*dot\s*\}\s*/gi, '.')
    .replace(/\s+dot\s+(?=[a-z]{2,})/gi, '.');
  const matches = deobf.match(EMAIL_REGEX) || [];
  for (const raw of matches) {
    const m = raw.replace(/^mailto:/i, '').replace(/[.,;:'")\]]+$/, '').toLowerCase();
    if (!isJunkEmail(m)) results.push(m);
  }
  // Cloudflare-obfuscated addresses: data-cfemail="hex"
  const cfMatches = html.match(/data-cfemail=["']([0-9a-fA-F]+)["']/g) || [];
  for (const cf of cfMatches) {
    const hex = cf.match(/data-cfemail=["']([0-9a-fA-F]+)["']/);
    if (!hex) continue;
    try {
      const bytes = Buffer.from(hex[1], 'hex');
      const key = bytes[0];
      let decoded = '';
      for (let i = 1; i < bytes.length; i++) decoded += String.fromCharCode(bytes[i] ^ key);
      if (isValidEmailSyntax(decoded) && !isJunkEmail(decoded)) results.push(decoded.toLowerCase());
    } catch (_) {
      /* ignore malformed cfemail */
    }
  }
  // JSON-LD "email": "..." blocks
  const ldMatches = html.match(/"email"\s*:\s*"([^"]+)"/gi) || [];
  for (const m of ldMatches) {
    const e = m.replace(/"email"\s*:\s*"/i, '').replace(/"$/, '').trim().toLowerCase();
    if (isValidEmailSyntax(e) && !isJunkEmail(e)) results.push(e);
  }
  return [...new Set(results)];
}

function classifyEmailType(email) {
  if (!email) return 'generic';
  const prefix = String(email).split('@')[0].toLowerCase().replace(/[._-].*$/, '');
  return GENERIC_PREFIXES.includes(prefix) ? 'generic' : 'personal';
}

async function domainHasMx(domain) {
  const key = String(domain || '').toLowerCase();
  if (!key) return { mx: false, domainExists: false };
  if (MX_CACHE.has(key)) return MX_CACHE.get(key);
  let result = { mx: false, domainExists: false };
  try {
    const { resolveMx, resolve4 } = await import('node:dns/promises');
    const recs = await resolveMx(key);
    result = { mx: Array.isArray(recs) && recs.length > 0, domainExists: true };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOTFOUND') {
      result = { mx: false, domainExists: false };
    } else {
      // ENODATA / ESERVFAIL: the domain exists but has no MX record.
      try {
        const { resolve4 } = await import('node:dns/promises');
        await resolve4(key);
        result = { mx: false, domainExists: true };
      } catch (_) {
        result = { mx: false, domainExists: false };
      }
    }
  }
  MX_CACHE.set(key, result);
  return result;
}

async function checkEmailQuality(email) {
  const clean = String(email || '').trim().toLowerCase();
  const type = classifyEmailType(clean);
  if (!isValidEmailSyntax(clean) || isJunkEmail(clean)) {
    return { status: 'invalid', type };
  }
  const domain = clean.split('@')[1];
  const check = await domainHasMx(domain);
  if (!check.domainExists) return { status: 'invalid', type };
  if (!check.mx) return { status: 'risky', type };
  return { status: type === 'generic' ? 'risky' : 'valid', type };
}

function normalizeWebsite(raw) {
  let site = String(raw || '').trim();
  if (!site) return '';
  if (/google\.[a-z.]+\/maps|goo\.gl\/maps/i.test(site)) return '';
  if (!/^https?:\/\//i.test(site)) site = `https://${site}`;
  try {
    const u = new URL(site);
    if (!u.hostname || !u.hostname.includes('.')) return '';
    return `${u.protocol}//${u.hostname}`;
  } catch (_) {
    return '';
  }
}

async function robotsAllows(origin, pathname) {
  let rules = ROBOTS_CACHE.get(origin);
  if (!rules) {
    rules = [];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${origin}/robots.txt`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'LeadFinderMailFinder/1.0' },
      });
      clearTimeout(t);
      if (res.ok) {
        const body = await res.text();
        let applies = false;
        for (const line of body.split(/\r?\n/)) {
          const clean = line.split('#')[0].trim();
          if (!clean) continue;
          const [rawKey, ...rest] = clean.split(':');
          const key = rawKey.trim().toLowerCase();
          const value = rest.join(':').trim();
          if (key === 'user-agent') applies = value === '*' || /leadfinder/i.test(value);
          else if (applies && key === 'disallow' && value) rules.push(value);
        }
      }
    } catch (_) {
      /* no robots.txt -> allow */
    }
    ROBOTS_CACHE.set(origin, rules);
  }
  return !rules.some((rule) => rule !== '/' && pathname.startsWith(rule.replace(/\*.*$/, ''))) && !rules.includes('/');
}

async function extractEmailsFromWebsite(website, maxPages = 5) {
  const origin = normalizeWebsite(website);
  if (!origin) return { emails: [], pagesChecked: 0, foundOn: {} };
  const paths = ['', '/contact', '/contact-us', '/about', '/about-us'];
  const found = {};
  const emails = new Set();
  let pagesChecked = 0;

  for (let i = 0; i < Math.min(maxPages, paths.length); i++) {
    const path = paths[i];
    try {
      if (!(await robotsAllows(origin, path || '/'))) continue;
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(origin + path, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'LeadFinderMailFinder/1.0 (+https://localhost; business email discovery)',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const contentType = String(res.headers.get('content-type') || '');
      if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) continue;
      const html = (await res.text()).slice(0, 600_000);
      pagesChecked++;
      for (const e of deobfuscateEmail(html)) {
        if (!emails.has(e)) {
          emails.add(e);
          found[e] = origin + path;
        }
      }
      // Polite crawl: at most ~2 requests/second against one domain.
      await new Promise((r) => setTimeout(r, 500));
    } catch (_) {
      /* skip unreachable / timed-out page */
    }
  }
  return { emails: [...emails], pagesChecked, foundOn: found };
}

function canonicalCity(value, stateName, address) {
  const raw = String(value || '').trim();
  const stateCities = getCitiesForState(stateName) || [];
  if (raw) {
    const match = stateCities.find((c) => String(c).toLowerCase() === raw.toLowerCase());
    if (match) return match;
    if (raw === raw.toUpperCase() || raw === raw.toLowerCase()) {
      return raw.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
    }
    return raw;
  }
  // Last resort: look for a known city of the state inside the address.
  const addr = String(address || '').toLowerCase();
  if (addr) {
    const inAddress = stateCities.find((c) => new RegExp(`\\b${String(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(addr));
    if (inAddress) return inAddress;
  }
  return '';
}

async function mapWithConcurrency(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      await fn(items[current], current);
    }
  });
  await Promise.all(workers);
}

async function processMailJob(mailJobId, { runId = null, source = 'run', final = true } = {}) {
  const job = db.prepare('SELECT * FROM mail_jobs WHERE id=?').get(mailJobId);
  if (!job) return;

  const isStopped = () => {
    const row = db.prepare('SELECT status FROM mail_jobs WHERE id=?').get(mailJobId);
    return !row || row.status === 'stopped';
  };

  // One row per email, within this search.
  const seenEmails = new Set();
  const emailExists = db.prepare('SELECT 1 AS hit FROM mail_results WHERE mail_job_id=? AND LOWER(email)=LOWER(?) LIMIT 1');
  const insertEmail = db.prepare(
    'INSERT INTO mail_results(id, mail_job_id, business_name, email, type, status, phone, website, city, state, address, found_on, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );

  // Businesses already checked for this job (so incremental harvests never
  // re-crawl the same website).
  const businessKey = (biz) =>
    `${normalizeKeyPart(biz.name)}|${normalizeKeyPart(biz.phone || biz.address)}`;
  const processedRows = db
    .prepare('SELECT business_key, had_email FROM mail_job_businesses WHERE mail_job_id=?')
    .all(mailJobId);
  const processedKeys = new Set(processedRows.map((r) => r.business_key));
  const markProcessed = db.prepare(
    'INSERT OR IGNORE INTO mail_job_businesses(mail_job_id, business_key, had_email, created_at) VALUES (?,?,?,?)'
  );

  // Counters are cumulative across incremental harvests.
  const priorEmails = db
    .prepare("SELECT COUNT(*) as c FROM mail_results WHERE mail_job_id=? AND TRIM(COALESCE(email,''))<>''")
    .get(mailJobId).c;
  const counters = {
    checked: processedRows.length,
    withEmail: processedRows.filter((r) => r.had_email).length,
    pages: Number(job.pages_crawled || 0),
    emails: priorEmails,
  };
  let lastWrite = 0;
  const writeProgress = (currentWebsite, force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 1200) return;
    // Never let a background progress tick overwrite a user's Stop.
    const stateRow = db.prepare('SELECT status FROM mail_jobs WHERE id=?').get(mailJobId);
    if (!stateRow || stateRow.status === 'stopped') return;
    lastWrite = now;
    db.prepare(
      `UPDATE mail_jobs SET
         businesses_checked=?, businesses_with_email=?, websites_checked=?,
         websites_with_email=?, pages_crawled=?, emails_total=?, results_found=?,
         current_website=?, stage=?, updated_at=?
       WHERE id=?`
    ).run(
      counters.checked,
      counters.withEmail,
      counters.checked,
      counters.withEmail,
      counters.pages,
      counters.emails,
      counters.emails,
      currentWebsite || '',
      source === 'contacts' ? 'crawling contacts' : 'finding emails',
      nowIso(),
      mailJobId
    );
  };

  const addEmailRow = (biz, email, foundOn) => {
    const clean = String(email || '').trim().toLowerCase();
    if (!isValidEmailSyntax(clean) || isJunkEmail(clean)) return false;
    if (seenEmails.has(clean)) return false;
    if (emailExists.get(mailJobId, clean)) {
      seenEmails.add(clean);
      return false;
    }
    seenEmails.add(clean);
    return { clean, foundOn };
  };

  // Collect the businesses this mail job should inspect.
  let businesses = [];
  if (source === 'contacts') {
    if (runId) {
      businesses = db.prepare(
        `SELECT name, phone, address, city, state, website, emails
         FROM results
         WHERE run_id=?
           AND (emails IS NULL OR TRIM(emails)='')
         GROUP BY COALESCE(NULLIF(TRIM(phone),''), name || '|' || COALESCE(address,''))
         ORDER BY name
         LIMIT 20000`
      ).all(runId);
    } else {
      businesses = db.prepare(
        `SELECT name, phone, address, city, state, website, emails
         FROM results
         WHERE (emails IS NULL OR TRIM(emails)='')
         GROUP BY COALESCE(NULLIF(TRIM(phone),''), name || '|' || COALESCE(address,''))
         ORDER BY name
         LIMIT 20000`
      ).all();
    }
  } else if (runId) {
    businesses = db.prepare(
      `SELECT name, phone, address, city, state, website, emails
       FROM results
       WHERE run_id=?
       GROUP BY COALESCE(NULLIF(TRIM(phone),''), name || '|' || COALESCE(address,''))
       ORDER BY name`
    ).all(runId);
  } else {
    businesses = db.prepare(
      `SELECT name, phone, address, city, state, website, emails
       FROM results
       GROUP BY COALESCE(NULLIF(TRIM(phone),''), name || '|' || COALESCE(address,''))
       ORDER BY name
       LIMIT 20000`
    ).all();
  }

  // Skip businesses that an earlier incremental harvest already checked.
  businesses = businesses.filter((biz) => !processedKeys.has(businessKey(biz)));

  const totalBusinesses = runId
    ? db.prepare('SELECT COUNT(*) as c FROM results WHERE run_id=?').get(runId).c
    : counters.checked + businesses.length;

  db.prepare('UPDATE mail_jobs SET businesses_total=?, stage=?, updated_at=? WHERE id=?').run(
    totalBusinesses,
    'finding emails',
    nowIso(),
    mailJobId
  );

  if (businesses.length === 0 && counters.checked === 0) {
    if (!final) return;
    db.prepare(
      "UPDATE mail_jobs SET status='failed', error_reason=?, stage='finished', updated_at=? WHERE id=?"
    ).run('No businesses found to check for emails', nowIso(), mailJobId);
    return;
  }

  const concurrency = 4;
  await mapWithConcurrency(businesses, concurrency, async (biz) => {
    if (isStopped()) return;
    counters.checked += 1;
    const city = canonicalCity(biz.city, job.state, biz.address);
    const state = canonicalCityState(biz.state, job.state);
    let addedForBusiness = 0;

    // 1) Use the email that came with the listing, if any.
    const listingEmails = String(biz.emails || '')
      .split(/[,;]/)
      .map((e) => e.trim())
      .filter(Boolean);

    for (const email of listingEmails) {
      const pending = addEmailRow(biz, email, 'listing');
      if (!pending) continue;
      const quality = await checkEmailQuality(pending.clean);
      insertEmail.run(
        crypto.randomUUID(), mailJobId, biz.name, pending.clean, quality.type, quality.status,
        biz.phone || '', biz.website || '', city, state, biz.address || '', pending.foundOn, nowIso()
      );
      counters.emails += 1;
      addedForBusiness += 1;
    }

    // 2) Crawl the website when the listing did not include an email.
    if (addedForBusiness === 0 && biz.website) {
      const result = await extractEmailsFromWebsite(biz.website, 5);
      counters.pages += result.pagesChecked;
      for (const email of result.emails.slice(0, 5)) {
        const pending = addEmailRow(biz, email, result.foundOn[email] || biz.website);
        if (!pending) continue;
        const quality = await checkEmailQuality(pending.clean);
        insertEmail.run(
          crypto.randomUUID(), mailJobId, biz.name, pending.clean, quality.type, quality.status,
          biz.phone || '', biz.website || '', city, state, biz.address || '', pending.foundOn, nowIso()
        );
        counters.emails += 1;
        addedForBusiness += 1;
      }
    }

    if (addedForBusiness > 0) counters.withEmail += 1;
    markProcessed.run(mailJobId, businessKey(biz), addedForBusiness > 0 ? 1 : 0, nowIso());
    writeProgress(biz.website || biz.name);
  });

  if (isStopped()) return;
  if (!final) {
    writeProgress('', true);
    return;
  }
  writeProgress('', true);

  const found = db.prepare('SELECT COUNT(*) as c FROM mail_results WHERE mail_job_id=?').get(mailJobId).c;
  const finalStatus = 'done';
  db.prepare(
    `UPDATE mail_jobs SET status=?, results_found=?, emails_total=?, stage='finished',
       error_reason=?, updated_at=? WHERE id=?`
  ).run(
    finalStatus,
    found,
    found,
    found > 0 ? null : 'No public emails found',
    nowIso(),
    mailJobId
  );
  console.log(`mail job ${mailJobId} finished: ${found} emails from ${counters.checked} businesses (${counters.pages} pages)`);
}

// Mail Finder stores the state as given by the user, but a business listing may
// carry a missing or differently-cased state. Normalise it for the sheet.
function canonicalCityState(value, fallbackState) {
  const found = findState(value);
  if (found) return found.name;
  return fallbackState || String(value || '').trim();
}

// ---------- scraper health check ----------
async function scraperHealthCheck() {
  try {
    const r = await scraperRequest('/api/v1/health', { method: 'GET' });
    // The scraper's health endpoint answers with HTML, so a 200 means it is up.
    if (typeof r === 'string') return true;
    return r && r.status !== 'unhealthy';
  } catch {
    return false;
  }
}

// Extract city name from a query like "CA in Andheri, Mumbai, Maharashtra"
// or "CA in Mumbai". Returns the city key (lowercase) for coordinate lookup.
function extractCityFromQuery(query) {
  if (!query) return '';
  const q = String(query).trim();
  // Strip niche prefix: everything before " in "
  const inIdx = q.toLowerCase().indexOf(' in ');
  const tail = inIdx >= 0 ? q.slice(inIdx + 4) : q;
  // tail is like "Andheri, Mumbai, Maharashtra" or "Mumbai, Maharashtra"
  const parts = tail.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  // First part could be a locality/area; the city is typically the last meaningful
  // part before the state. Try the part right before state, or the last part.
  // Heuristic: if there are 2+ parts, city is parts[parts.length - 2] (before state)
  // or parts[0] if only one part.
  const city = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return String(city).toLowerCase();
}

// Look up geo coordinates for a city. Falls back to India center.
function geoCoordsForCity(cityKey) {
  if (!cityKey) return cityCoords.default;
  return cityCoords[cityKey] || cityCoords.default;
}

// ---------- create scraper job ----------
async function createScraperJob(query) {
  const cityKey = extractCityFromQuery(query);
  const geoCoords = geoCoordsForCity(cityKey);
  const body = {
    name: `leadfinder:${query}`,
    keywords: [query],
    lang: 'en',
    zoom: 15,
    lat: geoCoords.split(',')[0],
    lon: geoCoords.split(',')[1],
    fast_mode: true,
    geo_coordinates: geoCoords,
    radius: SCRAPER_RADIUS,
    depth: SCRAPER_DEPTH,
    email: true,
    extra_reviews: false,
    max_time: SCRAPER_MAX_TIME,
    proxies: [],
  };
  const data = await scraperRequest('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.id;
}

async function getScraperJob(id) {
  return scraperRequest(`/api/v1/jobs/${encodeURIComponent(id)}`);
}

async function downloadScraperJob(id) {
  return scraperRequest(`/api/v1/jobs/${encodeURIComponent(id)}/download`);
}

// Extract business emails from a scraper row (CSV column: "emails").
function extractEmails(r) {
  const raw = r && (r.emails ?? r.email);
  if (!raw) return '';
  const list = Array.isArray(raw) ? raw.map((e) => String(e || '').trim()).filter(Boolean) : [String(raw).trim()];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out.join(', ');
}

// ---------- result cleaning ----------
function cleanRows(csvText, selectedState, queryCity, runId) {
  if (!csvText) return { rows: [], rawCount: 0, dupCount: 0 };

  let records;
  try {
    records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  } catch (_) {
    return { rows: [], rawCount: 0, dupCount: 0 };
  }

  const rawCount = records.length;
  const byPhone = new Map();
  const seenKeys = new Set();
  let dupCount = 0;

  for (const r of records) {
    const name = (r.title || r.name || '').trim();
    const phone = normalizePhone(r.phone);
    const address = (r.address || '').trim();
    if (!name || !phone) continue;
    if (!/^\+\d{1,3}\d{10}$/.test(phone)) continue;

    const completeAddress = r.complete_address || '';
    let addressCity = '';
    if (completeAddress) {
      try {
        const ca = JSON.parse(completeAddress);
        addressCity = cleanCityName(ca && ca.city, selectedState);
      } catch (_) {
        addressCity = '';
      }
    }

    const detected = detectState(address, completeAddress);
    if (detected && normalizeStateName(detected) !== normalizeStateName(selectedState)) continue;

    if (queryCity) {
      const addrLower = (address + ' ' + (r.city || '')).toLowerCase();
      let jsonCity = '';
      if (completeAddress) {
        try {
          const ca = JSON.parse(completeAddress);
          jsonCity = cleanCityName(ca && (ca.city || ca.town || ca.village), selectedState);
        } catch (_) {
          jsonCity = '';
        }
      }
      const q = queryCity.toLowerCase();
      const allowed = [q].concat(getCityAreas(queryCity).map((a) => String(a).toLowerCase()));
      const addrNorm = addrLower;
      // Positive match: address mentions the city OR Google's structured city matches.
      const positive = allowed.some((term) => addrLower.includes(term)) || (jsonCity && jsonCity.toLowerCase() === q);
      // Mismatch: address clearly names a different known city of the state.
      const stateCities = (getCitiesForState(selectedState) || []).map((c) => String(c).toLowerCase());
      let otherCityMentioned = false;
      for (const c of stateCities) {
        if (allowed.includes(c)) continue;
        if (new RegExp('\\\\b' + c.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\b', 'i').test(address)) {
          otherCityMentioned = true;
          break;
        }
      }
      // Mumbai metro satellite cities (drop them for a Mumbai search).
      if (!otherCityMentioned && q === 'mumbai') {
        const sats = CITY_SATELLITES.mumbai || [];
        for (const s of sats) {
          if (new RegExp('\\b' + s.replace(/ /g, '\\s+') + '\\b', 'i').test(address.toLowerCase())) {
            otherCityMentioned = true;
            break;
          }
        }
      }
    }

    const key = dedupeKey(name, address);
    if (seenKeys.has(key)) {
      dupCount++;
      continue;
    }
    seenKeys.add(key);

    const existing = byPhone.get(phone);
    if (!existing) {
      byPhone.set(phone, {
        name,
        phone,
        address,
        state: selectedState,
        city: queryCity || addressCity || '',
        emails: extractEmails(r),
        website: String(r.website || r.web_site || r.site || '').trim(),
      });
    } else {
      // Keep an email or website discovered on a later duplicate listing.
      if (!existing.emails && extractEmails(r)) existing.emails = extractEmails(r);
      if (!existing.website) existing.website = String(r.website || r.web_site || r.site || '').trim();
      dupCount++;
    }
  }

  return { rows: Array.from(byPhone.values()), rawCount, dupCount };
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- auto-continue: start the next deep search when one finishes ----------
const NEXT_SEARCH_CANDIDATES = [
  { niche: 'Hospital', state: 'Maharashtra', city: null, maxResults: 5000 },
  { niche: 'NGO', state: 'Maharashtra', city: null, maxResults: 5000 },
  { niche: 'Coaching institute', state: 'Maharashtra', city: null, maxResults: 5000 },
  { niche: 'School', state: 'Maharashtra', city: null, maxResults: 5000 },
  { niche: 'Clinic', state: 'Maharashtra', city: null, maxResults: 5000 },
];
let autoNextIdx = 0;
let autoNextInFlight = false;

async function autoStartNextDeepSearch() {
  if (autoNextInFlight) return;
  autoNextInFlight = true;
  try {
    const cand = NEXT_SEARCH_CANDIDATES[Math.abs(autoNextIdx) % NEXT_SEARCH_CANDIDATES.length];
    autoNextIdx = (autoNextIdx + 1) % NEXT_SEARCH_CANDIDATES.length;
    console.log(`auto-starting next deep search: ${cand.niche} in ${cand.state}`);
    const run = await startSearchRun({
      niche: cand.niche,
      state: cand.state,
      city: cand.city,
      maxResults: cand.maxResults,
      deepSearch: true,
    });
    if (!run.cached) console.log(`auto-started deep search run ${run.runId} (${run.niche}) — ${run.totalCities} searches queued`);
  } catch (err) {
    console.error('auto next deep search failed:', err.message);
  } finally {
    autoNextInFlight = false;
  }
}

// ---------- run lifecycle ----------
function startRun({ id, niche, state, city, maxResults, deepSearch, queries }) {
  const runRow = db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  if (!runRow) return;

  currentRunId = id;
  console.log(`startRun ${id} (niche=${niche}, state=${state}, city=${city || 'ALL'}, deep=${deepSearch})`);

  processRunJobsConcurrent(id).catch((err) => {
    console.error(`run ${id} processor error:`, err);
    currentRunId = null;
  });
}

// Process one scraper job to completion (create -> poll -> download -> insert).
async function processOneJob(job, run) {
  const dbInsert = db.transaction((rows) => {
    let dupCount = 0;
    const byPhone = new Map();
    const seenKeys = new Set();

    for (const row of rows) {
      const name = String(row.name || '').trim();
      const phone = String(row.phone || '');
      const address = String(row.address || '');
      const state = String(row.state || '');
      const city = String(row.city || '');
      if (!name || !phone) continue;
      if (!/^\+\d{1,3}\d{10}$/.test(phone)) continue;

      const key = dedupeKey(name, address);
      if (seenKeys.has(key)) {
        dupCount++;
        continue;
      }
      seenKeys.add(key);

      if (byPhone.has(phone)) {
        dupCount++;
        continue;
      }
      byPhone.set(phone, {
        name,
        phone,
        address,
        state,
        city,
        key,
        emails: row.emails || '',
        website: String(row.website || '').trim(),
      });
    }

    for (const [phone, row] of byPhone) {
      try {
        insert.run(
          crypto.randomUUID(),
          run.id,
          row.name,
          row.phone,
          row.address,
          row.state,
          row.city,
          row.key,
          row.emails || '',
          row.website || '',
          nowIso()
        );
      } catch (_) {
        // duplicate phone / name+address already stored for this run -> skip
      }
    }

    return { dupCount };
  });

  const mark = (status, retries, failureReason) => {
    db.prepare('UPDATE run_jobs SET status=?, retries=?, failure_reason=?, updated_at=? WHERE id=?').run(
      status,
      retries,
      failureReason || null,
      nowIso(),
      job.id
    );
  };

  const refreshRunProgress = (currentArea = null) => {
    const agg = db.prepare(
      `SELECT 
         SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as done,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN status='working' THEN 1 ELSE 0 END) as working,
         COUNT(*) as total
       FROM run_jobs WHERE run_id=?`
    ).get(run.id);
    const resultCount = db.prepare('SELECT COUNT(*) as c FROM results WHERE run_id=?').get(run.id).c;
    const rawRows = db.prepare('SELECT SUM(COALESCE(raw_rows,0)) as s FROM run_jobs WHERE run_id=?').get(run.id).s || 0;
    const dupsRemoved = db.prepare('SELECT SUM(COALESCE(dups_removed,0)) as s FROM run_jobs WHERE run_id=?').get(run.id).s || 0;
    const total = agg.total || 0;
    const done = (agg.done || 0) + (agg.failed || 0);
    const current = db.prepare('SELECT status FROM runs WHERE id=?').get(run.id);
    let status = 'queued';
    if (current && current.status === 'stopped') status = 'stopped';
    else if (total > 0 && done >= total) status = resultCount > 0 ? 'done' : 'failed';
    else if (done > 0 || (agg.working || 0) > 0) status = 'running';
    updateRun.run(status, agg.done || 0, agg.failed || 0, resultCount, rawRows, dupsRemoved, currentArea, run.level || 0, nowIso(), run.id);
  };

  // ensure scraper job exists
  let scraperId = job.scraper_job_id;
  if (!scraperId) {
    // Health check: don't start a job if the scraper is not responding.
    const healthy = await scraperHealthCheck();
    if (!healthy) {
      console.error(`scraper not responding — skipping job ${job.id} (${job.query})`);
      if (job.retries < MAX_RETRIES) {
        mark('queued', job.retries + 1, 'scraper not responding');
      } else {
        mark('failed', job.retries, 'scraper not responding');
      }
      refreshRunProgress(job.query);
      return;
    }
    try {
      scraperId = await createScraperJob(job.query);
      db.prepare('UPDATE run_jobs SET scraper_job_id=?, status=\'working\', updated_at=? WHERE id=?').run(
        scraperId,
        nowIso(),
        job.id
      );
      refreshRunProgress(job.query);
    } catch (err) {
      console.error(`create scraper job ${job.id}:`, err.message);
      if (job.retries < MAX_RETRIES) {
        mark('queued', job.retries + 1, err.message);
      } else {
        mark('failed', job.retries, err.message);
      }
      refreshRunProgress(job.query);
      return;
    }
  }

  // poll until terminal (or watchdog timeout)
  let retries = job.retries;
  const jobStartedAt = Date.now();
  for (let i = 0; i < 120; i++) {
    if (Date.now() - jobStartedAt > JOB_TIMEOUT_MS) {
      console.log(`job ${job.id} (${job.query}) timed out after ${JOB_TIMEOUT_MS / 60000} min — marking failed`);
      mark('failed', retries);
      refreshRunProgress(job.query);
      return;
    }
    try {
      const sj = await getScraperJob(scraperId);
      const status = sj.Status || sj.status;
      if (status === 'ok') {
        const csv = await downloadScraperJob(scraperId);
        const cleaned = cleanRows(csv, run.state, job.city);
        const txResult = dbInsert(cleaned.rows);
        const dupCount = txResult ? txResult.dupCount : 0;
        mark('ok', retries);
        // store raw rows and dup count in job for stats
        db.prepare('UPDATE run_jobs SET raw_rows=?, dups_removed=?, updated_at=? WHERE id=?').run(
          cleaned.rawCount,
          dupCount,
          nowIso(),
          job.id
        );
        refreshRunProgress(job.query);
        return;
      }
      if (status === 'failed') {
        if (retries < MAX_RETRIES) {
          mark('queued', retries + 1, 'scraper job failed — retrying');
          refreshRunProgress(job.query);
          return; // caller will re-queue
        }
        mark('failed', retries, 'scraper job failed — max retries reached');
        refreshRunProgress(job.query);
        return;
      }
    } catch (err) {
      console.error(`poll job ${job.id}:`, err.message);
      const reason = err.message || 'poll error';
      if (retries < MAX_RETRIES) {
        mark('queued', retries + 1, reason);
      } else {
        mark('failed', retries, reason);
        refreshRunProgress(job.query);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  mark('failed', retries, 'job timeout — no terminal status');
  refreshRunProgress(job.query);
}

async function processRunJobsConcurrent(runId, { resume = false } = {}) {
  if (resume) {
    // On restart, any job that was mid-flight has no worker polling it. Put it back
    // in the queue so a worker picks it up and resumes polling the scraper job.
    db.prepare("UPDATE run_jobs SET status='queued' WHERE run_id=? AND status='working'").run(runId);
  }
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return;

  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (true) {
          const job = db.prepare(
            "SELECT * FROM run_jobs WHERE run_id=? AND status='queued' ORDER BY created_at LIMIT 1"
          ).get(runId);
          if (!job) return;
          await processOneJob(job, run);
        }
      })()
    );
  }
  await Promise.all(workers);

  const agg = db.prepare(
    `SELECT 
       SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as done,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
       COUNT(*) as total
     FROM run_jobs WHERE run_id=?`
  ).get(runId);

  const resultCount = db.prepare('SELECT COUNT(*) as c FROM results WHERE run_id=?').get(run.id).c;
  const rawRows = db.prepare('SELECT SUM(COALESCE(raw_rows,0)) as s FROM run_jobs WHERE run_id=?').get(run.id).s || 0;
  const dupsRemoved = db.prepare('SELECT SUM(COALESCE(dups_removed,0)) as s FROM run_jobs WHERE run_id=?').get(run.id).s || 0;

  const total = agg.total || 0;
  const done = (agg.done || 0) + (agg.failed || 0);
  const current = db.prepare('SELECT status FROM runs WHERE id=?').get(runId);
  let status = total > 0 && done >= total ? (resultCount > 0 ? 'done' : 'failed') : done > 0 ? 'running' : 'queued';
  if (current && current.status === 'stopped') status = 'stopped';

  const currentJob = db.prepare("SELECT query FROM run_jobs WHERE run_id=? AND status='working' ORDER BY created_at LIMIT 1").get(runId);
  updateRun.run(status, agg.done || 0, agg.failed || 0, resultCount, rawRows, dupsRemoved, currentJob ? currentJob.query : null, run.level || 0, nowIso(), runId);

  if (status === 'done') {
    // Deep search finished -> automatically kick off the next niche deep search
    // so data collection keeps flowing without waiting for the user.
    if (!deepPlanActive) {
      autoStartNextDeepSearch().catch((err) => console.error('auto next deep search trigger failed:', err.message));
    }
  }

  const pending = db.prepare(
    "SELECT COUNT(*) as c FROM run_jobs WHERE run_id=? AND status='queued'"
  ).get(runId).c;
  if (pending > 0) {
    setTimeout(() => processRunJobsConcurrent(runId).catch(() => {}), POLL_INTERVAL_MS * 2);
    return;
  }

  // Run reached a terminal state -> release the single-active-search slot.
  currentRunId = null;
}

// ---------- multi-provider quota helpers ----------
function resetQuotaIfNeeded(row) {
  if (!row || !row.reset_at) return row;
  const now = new Date();
  const reset = new Date(row.reset_at);
  if (now >= reset) {
    let next = null;
    const period = row.period;
    if (period === 'daily') {
      const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); next = d.toISOString();
    } else if (period === 'monthly') {
      const d = new Date(now.getFullYear(), now.getMonth() + 1, 1); next = d.toISOString();
    } else {
      next = '2099-12-31T23:59:59.000Z';
    }
    db.prepare('UPDATE provider_settings SET used=0, reset_at=? WHERE provider=?').run(next, row.provider);
    row.used = 0;
    row.reset_at = next;
  }
  return row;
}

function getProviderSettings(provider) {
  const row = db.prepare('SELECT * FROM provider_settings WHERE provider=?').get(provider);
  if (!row) return null;
  return resetQuotaIfNeeded(row);
}

function allProviderSettings() {
  const rows = db.prepare('SELECT * FROM provider_settings').all();
  return rows.map(resetQuotaIfNeeded);
}

function quotaOk(provider) {
  const row = getProviderSettings(provider);
  if (!row) return { ok: false, reason: 'unknown provider' };
  if (!row.enabled) return { ok: false, reason: 'disabled' };
  if (row.limit_val > 0 && row.used >= row.limit_val) return { ok: false, reason: 'free limit reached', used: row.used, limit: row.limit_val };
  if (!row.api_key && PROVIDER_META[provider] && PROVIDER_META[provider].needsKey) return { ok: false, reason: 'no API key' };
  return { ok: true, row };
}

function incrementQuota(provider) {
  db.prepare('UPDATE provider_settings SET used = used + 1 WHERE provider=?').run(provider);
}

function recordProviderCount(runId, provider, newContacts) {
  db.prepare('INSERT INTO run_provider_counts (run_id, provider, new_contacts) VALUES (?,?,?) ON CONFLICT(run_id, provider) DO UPDATE SET new_contacts = new_contacts + ?').run(runId, provider, newContacts, newContacts);
}
app.get('/api/settings/providers', (_req, res) => {
  const rows = allProviderSettings();
  res.json(rows.map((r) => ({
    provider: r.provider,
    name: r.name,
    signup_url: r.signup_url,
    enabled: !!r.enabled,
    hasKey: !!r.api_key,
    keyTail: r.api_key ? '••••' + r.api_key.slice(-4) : '',
    used: r.used,
    limit: r.limit_val,
    period: r.period,
    reset_at: r.reset_at,
    needsKey: !!(PROVIDER_META[r.provider] && PROVIDER_META[r.provider].needsKey),
  })));
});

app.post('/api/settings/providers', (req, res) => {
  const { provider, enabled, apiKey, limit } = req.body || {};
  const row = getProviderSettings(provider);
  if (!row) return res.status(404).json({ error: 'unknown provider' });
  const updates = {};
  if (typeof enabled === 'boolean') updates.enabled = enabled ? 1 : 0;
  if (typeof apiKey === 'string' && apiKey.trim() !== '') updates.api_key = apiKey.trim();
  if (typeof limit === 'number' && limit > 0) updates.limit_val = limit;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ ok: true });
  const setClause = keys.map((k) => `${k}=?`).join(', ');
  const vals = keys.map((k) => updates[k]);
  db.prepare(`UPDATE provider_settings SET ${setClause} WHERE provider=?`).run(...vals, provider);
  res.json({ ok: true });
});

app.post('/api/settings/providers/test', async (req, res) => {
  const { provider, apiKey } = req.body || {};
  const row = getProviderSettings(provider);
  const key = (apiKey && apiKey.trim()) || (row && row.api_key) || '';
  try {
    const r = await testKey(provider, key);
    res.json({ ok: true, message: r.message });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post('/api/settings/providers/reset-quota', (req, res) => {
  const { provider } = req.body || {};
  if (provider) db.prepare('UPDATE provider_settings SET used=0 WHERE provider=?').run(provider);
  else db.prepare('UPDATE provider_settings SET used=0').run();
  res.json({ ok: true });
});

app.get('/api/states', (_req, res) => {
  res.json(STATES.map((s) => ({ code: s.code, name: s.name })));
});

app.get('/api/cities', (req, res) => {
  const state = req.query.state;
  const st = findState(state);
  if (!st) return res.status(400).json({ error: 'unknown state' });
  const areas = areasData[st.name] || [];
  res.json({ state: st.name, cities: st.cities, areas: areas });
});

function buildDeepPlan({ niche, state, city, deep, target, variants }) {
  const scopeCities = city ? [city] : (getCitiesForState(state) || []);
  const bases = [];
  if (city) {
    const areas = getCityAreas(city);
    if (areas.length > 0) for (const a of areas) bases.push({ city, area: a });
    else bases.push({ city, area: null });
  }
  else {
    for (const c of scopeCities) {
      const areas = getCityAreas(c);
      if (areas.length > 0) for (const a of areas) bases.push({ city: c, area: a });
      else bases.push({ city: c, area: null });
    }
  }
  const vs = (variants && variants.length) ? variants : (deep ? getKeywordVariants(niche) : [niche]);
  const uniqueVariants = Array.from(new Set(vs.map((v) => String(v).trim()).filter(Boolean)));
  const variants2 = uniqueVariants.length ? uniqueVariants : [niche];
  const mk = (level, query, b, variant) => ({ level, query, city: b ? b.city : (city || ''), area: b ? b.area : null, variant });

  const l1 = [];
  for (const c of scopeCities) l1.push(mk(1, `${niche} in ${c}, ${state}`, { city: c, area: null }));
  const l2 = [];
  for (const b of bases) if (b.area) l2.push(mk(2, `${niche} in ${b.area}, ${b.city}, ${state}`, b));
  const l3 = [];
  for (const b of bases) for (const v of variants2) l3.push(mk(3, b.area ? `${v} in ${b.area}, ${b.city}, ${state}` : `${v} in ${b.city}, ${state}`, b, v));
  // Level 4 broadens the keyword net at city level (never repeats level 3).
  const l4 = [];
  for (const c of scopeCities) for (const v of variants2) l4.push(mk(4, `${v} in ${c}, ${state}`, { city: c, area: null }, v));

  let levels;
  if (!deep) {
    levels = [{ level: 1, queries: l1 }];
    if (l2.length) levels.push({ level: 2, queries: l2 });
  } else {
    levels = [{ level: 1, queries: l1 }];
    if (l2.length) levels.push({ level: 2, queries: l2 });
    levels.push({ level: 3, queries: l3 });
    levels.push({ level: 4, queries: l4 });
  }

  // Drop empty levels and any query that already appeared at an earlier level.
  const seenQueries = new Set();
  levels = levels
    .map((lv) => ({
      ...lv,
      queries: lv.queries.filter((q) => {
        const key = String(q.query || '').trim().toLowerCase();
        if (!key || seenQueries.has(key)) return false;
        seenQueries.add(key);
        return true;
      }),
    }))
    .filter((lv) => lv.queries.length > 0);

  const flat = [];
  for (const lv of levels) for (const qq of lv.queries) flat.push(qq);
  return { levels, flat, target: target || 3000 };
}

async function startSearchRun({ niche, state, city, maxResults, deepSearch, extraVariants, onRunId = null }) {
  const st = findState(state);
  if (!st) throw new Error('unknown state');

  // Requested lead ceiling (null / invalid => collect everything the plan yields).
  const requestedTarget = Number(maxResults);
  const limitTarget =
    Number.isFinite(requestedTarget) && requestedTarget > 0
      ? Math.min(Math.floor(requestedTarget), 20000)
      : null;

  // Only ONE deep search may run at a time.
  if (currentRunId) {
    const active = db.prepare('SELECT id, niche, state, city, status FROM runs WHERE id=?').get(currentRunId);
    return { busy: true, runId: currentRunId, state: st.name, activeNiche: active ? active.niche : null, activeStatus: active ? active.status : null };
  }

  // Instant cache: return a previous done run for the same niche+state+city.
  // Only reuse it when the stored businesses carry website URLs — Mail Finder
  // needs those URLs to crawl for public emails. An old lead-only run with no
  // websites would otherwise "finish" instantly with zero emails. When the user
  // asked for a bigger target than the cached run has, scrape fresh instead.
  const cached = db.prepare(
    `SELECT r.id, r.status, r.result_count,
        (SELECT COUNT(*) FROM results x
          WHERE x.run_id = r.id AND TRIM(COALESCE(x.website,'')) <> '') AS with_site
     FROM runs r
     WHERE r.niche=? AND r.state=? AND r.city IS ? AND r.status='done'
     ORDER BY r.updated_at DESC LIMIT 1`
  ).get(niche, st.name, city || '');
  if (cached && cached.with_site > 0 && (!limitTarget || cached.result_count >= limitTarget)) {
    console.log(`reusing cached run ${cached.id} (${cached.result_count} businesses, ${cached.with_site} with websites)`);
    if (onRunId) onRunId(cached.id);
    return { cached: true, runId: cached.id, state: st.name, resultCount: cached.result_count };
  }
  if (cached) {
    console.log(
      `cached run ${cached.id} skipped (${cached.result_count} results, ${cached.with_site} with websites, target ${limitTarget || 'all'}) — scraping fresh`
    );
  }

  const deep = deepSearch !== false;
  const baseVariants = deep ? getKeywordVariants(niche) : [niche];
  const variants = Array.from(new Set([...baseVariants, ...(extraVariants || [])].map((v) => String(v).trim()).filter(Boolean)));
  if (variants.length === 0) variants.push(niche);

  // Deep search engine...
  const deepTarget = limitTarget != null ? limitTarget : Infinity;
  const plan = buildDeepPlan({ niche, state, city, deep, target: deepTarget, variants });
  const queries = plan.flat;
  const levels = plan.levels;
  const total = queries.length;

  const runId = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    'INSERT INTO runs(id, niche, state, city, max_results, deep_search, status, total_cities, completed_cities, failed_cities, result_count, raw_rows, duplicates_removed, current_area, created_at, updated_at) VALUES (?,?,?,?,?,?,\'queued\',0,0,0,0,0,0,null,?,?)'
  ).run(runId, niche, st.name, city || '', maxResults || null, deep ? 1 : 0, now, now);

  db.prepare('UPDATE runs SET total_cities=?, updated_at=? WHERE id=?').run(total, now, runId);
  for (const q of queries) {
    const jobId = crypto.randomUUID();
    insertJob.run(jobId, runId, null, q.city || city || '', q.query, 'queued', 0, q.level || 1, now, now);
  }

  currentRunId = runId;
  deepPlanActive = true;
  if (onRunId) onRunId(runId);
  let targetReached = false;
  let exhausted = false;
  let prevCount = 0;

  for (const lv of levels) {
    const currentCount = db.prepare('SELECT result_count as c FROM runs WHERE id=?').get(runId).c;
    if (currentCount >= deepTarget) { targetReached = true; break; }
    db.prepare('DELETE FROM run_jobs WHERE run_id=?').run(runId);
    db.prepare("UPDATE runs SET status='running', level=?, updated_at=? WHERE id=?").run(lv.level, nowIso(), runId);
    for (const q of lv.queries) {
      const jobId = crypto.randomUUID();
      insertJob.run(jobId, runId, null, q.city || city || '', q.query, 'queued', 0, q.level || 1, now, now);
    }
    currentRunId = runId;
    deepPlanActive = true;
    await processRunJobsConcurrent(runId);
    const runNow = db.prepare('SELECT result_count as c FROM runs WHERE id=?').get(runId);
    db.prepare('UPDATE runs SET level=?, updated_at=? WHERE id=?').run(lv.level, nowIso(), runId);
    const added = runNow.c - prevCount;
    prevCount = runNow.c;
    if (runNow.c >= deepTarget) { targetReached = true; break; }
  if (added < Math.max(1, Math.floor(prevCount * 0.02))) {
      exhausted = true;
      runExhaustedMap.set(runId, true);
      db.prepare('UPDATE runs SET exhausted=1, updated_at=? WHERE id=?').run(nowIso(), runId);
      console.log(`deep level ${lv.level} exhausted for run ${runId} (added ${added} new contacts)`);
    }
  }

  // ---------- Top-up providers (if target not reached after gosom) ----------
  if (!targetReached) {
    // pick queries that returned fewest results (by raw_rows asc)
    const lowYield = db.prepare(
      "SELECT query, city FROM run_jobs WHERE run_id=? ORDER BY COALESCE(raw_rows,0) ASC, created_at ASC LIMIT 20"
    ).all(runId);
    const seenQueries = new Set(lowYield.map((q) => q.query));
    // ensure at least some queries
    if (lowYield.length === 0) {
      for (const lv of levels) for (const q of lv.queries) { if (!seenQueries.has(q.query)) { lowYield.push({ query: q.query, city: q.city }); seenQueries.add(q.query); } if (lowYield.length >= 20) break; }
    }

    for (const prov of TOPUP_ORDER) {
      if (targetReached) break;
      const qset = quotaOk(prov);
      if (!qset.ok) {
        console.log(`topup skip ${prov}: ${qset.reason}`);
        recordProviderCount(runId, prov, 0);
        continue;
      }
      currentProvider = prov;
      let addedThis = 0;
      for (const job of lowYield) {
        if (targetReached) break;
        const rc = db.prepare('SELECT result_count as c FROM runs WHERE id=?').get(runId).c;
        if (rc >= deepTarget) { targetReached = true; break; }
        try {
          const rows = await ADAPTERS[prov]({ keyword: niche, area: null, city: job.city || city || '', state: st.name, apiKey: qset.row.api_key });
          incrementQuota(prov);
          // build CSV-like and clean
          const csvRows = rows.map((r) => ({ title: r.name, phone: r.phone, address: r.address, complete_address: '', city: r.city }));
          const cleaned = cleanContactList(csvRows, st.name, job.city || city || '');
          if (cleaned.rows.length > 0) {
            const before = db.prepare('SELECT COUNT(*) as c FROM results WHERE run_id=?').get(runId).c;
            dbInsert(cleaned.rows);
            const after = db.prepare('SELECT COUNT(*) as c FROM results WHERE run_id=?').get(runId).c;
            const newAdded = Math.max(0, after - before);
            db.prepare('UPDATE runs SET result_count=?, updated_at=? WHERE id=?').run(after, nowIso(), runId);
            addedThis += newAdded;
            recordProviderCount(runId, prov, newAdded);
          }
        } catch (err) {
          console.error(`topup ${prov} failed:`, err.message);
        }
        const rc2 = db.prepare('SELECT result_count as c FROM runs WHERE id=?').get(runId).c;
        if (rc2 >= deepTarget) { targetReached = true; break; }
      }
      console.log(`topup ${prov} added ${addedThis} new contacts`);
      if (addedThis === 0) continue;
    }
  }

  currentProvider = 'gosom';
  deepPlanActive = false;
  if (!targetReached) {
    runExhaustedMap.set(runId, true);
    exhausted = true;
    db.prepare('UPDATE runs SET exhausted=1, updated_at=? WHERE id=?').run(nowIso(), runId);
    console.log(`deep search run ${runId} finished below target=${deepTarget}: finalContacts=${prevCount}`);
  } else {
    db.prepare('UPDATE runs SET exhausted=0, updated_at=? WHERE id=?').run(nowIso(), runId);
  }

  const finalRun = db.prepare('SELECT status as s FROM runs WHERE id=?').get(runId);
  if (finalRun.s === 'done') {
    autoStartNextDeepSearch().catch((err) => console.error('auto next deep search trigger failed:', err.message));
  }

  return { runId, state: st.name, totalCities: total, deepSearch: deep, keywordVariants: variants.length };
}

app.post('/api/search', async (req, res) => {
  const { niche, state, city, maxResults, deepSearch, extraVariants } = req.body || {};
  if (!niche || !state) {
    return res.status(400).json({ error: 'niche and state are required' });
  }
  const st = findState(state);
  if (!st) return res.status(400).json({ error: 'unknown state' });

  const result = await startSearchRun({ niche, state, city, maxResults, deepSearch, extraVariants });
  if (result.cached) {
    return res.json({
      runId: result.runId,
      state: result.state,
      totalCities: 0,
      cached: true,
      resultCount: result.resultCount,
    });
  }
  if (result.busy) {
    return res.status(409).json({
      error: 'A search is already running. Stop it or wait.',
      runId: result.runId,
      state: result.state,
      activeNiche: result.activeNiche || null,
      activeStatus: result.activeStatus || null,
    });
  }
  res.json({ runId: result.runId, state: result.state, totalCities: result.totalCities, deepSearch: result.deepSearch, keywordVariants: result.keywordVariants });
});

app.get('/api/runs/:id/progress', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const jobs = db.prepare('SELECT status, COUNT(*) as c FROM run_jobs WHERE run_id=? GROUP BY status').all(req.params.id);
  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = j.c;
  res.json({
    id: run.id,
    niche: run.niche,
    state: run.state,
    city: run.city || '',
    status: run.status,
    totalCities: run.total_cities,
    completedCities: run.completed_cities,
    failedCities: run.failed_cities,
    resultCount: run.result_count,
    rawRows: run.raw_rows || 0,
    duplicatesRemoved: run.duplicates_removed || 0,
    currentArea: run.current_area || null,
    startedAt: run.created_at || null,
    deepSearch: run.deep_search,
    level: run.level || 0,
    currentProvider,
    byStatus,
  });
});

app.get('/api/runs/:id/results', (req, res) => {
  const runId = req.params.id;
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
  const offset = (page - 1) * limit;
  const search = (req.query.q || '').trim();
  const sortRecent = req.query.sort === 'recent';

  // Get the run's selected city to filter results to that city only
  const run = db.prepare('SELECT city, state FROM runs WHERE id=?').get(runId);
  if (!run) return res.status(404).json({ error: 'run not found' });

  let where = 'WHERE run_id=?';
  const params = [runId];
  // When a specific city was selected, only show results from that city
  if (run.city) {
    where += ' AND LOWER(city) = LOWER(?)';
    params.push(run.city);
  }
  if (search) {
    where += ' AND (LOWER(name) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(address) LIKE ? OR LOWER(city) LIKE ? OR LOWER(state) LIKE ?)';
    const like = `%${search.toLowerCase()}%`;
    params.push(like, like, like, like, like);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM results ${where}`).get(...params).c;
  const orderBy = sortRecent ? 'created_at DESC, name' : 'name';
  const rows = db.prepare(
    `SELECT name, phone, address, emails, city, state FROM results ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ rows, total, page, limit, totalPages: Math.ceil(total / limit), city: run.city, state: run.state });
});

app.get('/api/runs/:id/summary', (req, res) => {
  const runId = req.params.id;
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const jobsOk = db.prepare("SELECT COUNT(*) as c FROM run_jobs WHERE run_id=? AND status='ok'").get(runId).c;
  const jobsFailed = db.prepare("SELECT COUNT(*) as c FROM run_jobs WHERE run_id=? AND status='failed'").get(runId).c;
  res.json({
    id: run.id,
    niche: run.niche,
    state: run.state,
    city: run.city,
    status: run.status,
    queriesRun: run.total_cities,
    queriesOk: jobsOk,
    queriesFailed: jobsFailed,
    rawRows: run.raw_rows || 0,
    duplicatesRemoved: run.duplicates_removed || 0,
    finalCount: run.result_count,
    deepSearch: run.deep_search,
    level: run.level || 0,
    exhausted: !!run.exhausted || !!runExhaustedMap.get(runId),
    providerCounts: db.prepare('SELECT provider, new_contacts FROM run_provider_counts WHERE run_id=?').all(runId),
    createdAt: run.created_at,
  });
});

app.get('/api/runs', (_req, res) => {
  const rows = db.prepare(
    `SELECT id, niche, state, city, status, total_cities, completed_cities, failed_cities, result_count, created_at,
            max_results, deep_search, level, exhausted FROM runs ORDER BY created_at DESC`
  ).all();
  const out = rows.map((r) => {
    const counts = db.prepare('SELECT provider, new_contacts FROM run_provider_counts WHERE run_id=?').all(r.id);
    return { ...r, provider_counts: counts };
  });
  res.json(out);
});

app.post('/api/runs/:id/retry', (req, res) => {
  const runId = req.params.id;
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const failed = db.prepare("SELECT * FROM run_jobs WHERE run_id=? AND status='failed'").all(runId);
  const tx = db.transaction(() => {
    for (const j of failed) {
      db.prepare("UPDATE run_jobs SET status='queued', retries=0, updated_at=? WHERE id=?").run(nowIso(), j.id);
    }
  });
  tx();
  processRunJobs(runId).catch(() => {});
  res.json({ retried: failed.length });
});

app.post('/api/runs/:id/resume', (req, res) => {
  const runId = req.params.id;
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const now = nowIso();
  const tx = db.transaction(() => {
    // Return non-completed jobs to the queue and clear stale scraper job links
    // so the processor creates fresh scraper jobs.
    db.prepare("UPDATE run_jobs SET status='queued', retries=0, scraper_job_id=NULL, updated_at=? WHERE run_id=? AND status!='ok'").run(now, runId);
    db.prepare("UPDATE runs SET status='queued', updated_at=? WHERE id=?").run(now, runId);
  });
  tx();
  startRun({ id: runId });
  res.json({ resumed: true });
});

app.post('/api/runs/:id/stop', (req, res) => {
  const runId = req.params.id;
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const tx = db.transaction(() => {
    db.prepare("UPDATE run_jobs SET status='stopped', updated_at=? WHERE status='queued' AND run_id=?").run(nowIso(), runId);
    db.prepare("UPDATE runs SET status='stopped', updated_at=? WHERE id=?").run(nowIso(), runId);
  });
  tx();

  currentRunId = null;

  // Free the scraper queue immediately instead of letting abandoned cities run.
  const queuedJobs = db
    .prepare(
      "SELECT scraper_job_id FROM run_jobs WHERE run_id=? AND status IN ('queued','working') AND scraper_job_id IS NOT NULL"
    )
    .all(runId);
  for (const job of queuedJobs) deleteScraperJob(job.scraper_job_id);

  res.json({ stopped: true });
});

async function deleteRunById(runId) {
  const run = db.prepare('SELECT id FROM runs WHERE id=?').get(runId);
  if (!run) return false;
  const jobs = db
    .prepare('SELECT scraper_job_id FROM run_jobs WHERE run_id=? AND scraper_job_id IS NOT NULL')
    .all(runId);
  for (const j of jobs) {
    if (j.scraper_job_id) await deleteScraperJob(j.scraper_job_id);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM results WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM run_jobs WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM run_provider_counts WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM runs WHERE id=?').run(runId);
  });
  tx();
  if (currentRunId === runId) currentRunId = null;
  return true;
}

app.delete('/api/runs', async (req, res) => {
  const rows = db.prepare('SELECT id FROM runs').all();
  let deleted = 0;
  for (const row of rows) {
    try {
      if (await deleteRunById(row.id)) deleted += 1;
    } catch (err) {
      console.error(`delete run ${row.id} failed:`, err.message);
    }
  }
  res.json({ deleted });
});

app.delete('/api/runs/:id', async (req, res) => {
  const runId = req.params.id;
  const deleted = await deleteRunById(runId);
  if (!deleted) return res.status(404).json({ error: 'run not found' });
  res.json({ deleted: true, runId });
});

app.post('/api/runs/:id/clear-stuck', async (req, res) => {
  const runId = req.params.id;
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const jobs = db
    .prepare("SELECT id, scraper_job_id, status FROM run_jobs WHERE run_id=? AND status IN ('working','queued','failed')")
    .all(runId);
  let cleared = 0;
  for (const j of jobs) {
    if (j.status === 'working' && j.scraper_job_id) await deleteScraperJob(j.scraper_job_id);
    db.prepare("UPDATE run_jobs SET status='stopped', updated_at=? WHERE id=?").run(nowIso(), j.id);
    cleared += 1;
  }
  res.json({ cleared, runId });
});

// ---------- Mail Finder API ----------

// Mail Finder uses the same single-worker idea as lead searches: jobs are
// queued and only one mail job crawls websites at a time.
const mailQueue = [];
let mailWorkerRunning = false;
let activeMailJobId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markMailJob(id, fields) {
  const allowed = ['status', 'stage', 'error_reason', 'run_id', 'source', 'current_website'];
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key}=?`);
    params.push(value);
  }
  if (!sets.length) return;
  sets.push('updated_at=?');
  params.push(nowIso(), id);
  db.prepare(`UPDATE mail_jobs SET ${sets.join(', ')} WHERE id=?`).run(...params);
}

async function runMailJobInBackground(mailJobId, opts) {
  const { mode, sourceRunId, niche, state, city, maxResults, deepSearch, extraVariants } = opts;
  const isStopped = () => {
    const row = db.prepare('SELECT status FROM mail_jobs WHERE id=?').get(mailJobId);
    return !row || row.status === 'stopped';
  };

  try {
    markMailJob(mailJobId, { status: 'running', stage: 'starting' });

    if (mode === 'contacts') {
      markMailJob(mailJobId, {
        stage: 'finding emails',
        source: 'contacts',
        run_id: sourceRunId || null,
        current_website: 'Loading saved contacts…',
      });
      await processMailJob(mailJobId, { runId: sourceRunId || null, source: 'contacts' });
      return;
    }

    // 1) Health check before every job.
    const healthy = await scraperHealthCheck();
    if (!healthy) {
      db.prepare(
        "UPDATE mail_jobs SET status='failed', stage='finished', error_reason=?, updated_at=? WHERE id=?"
      ).run('Scraper not responding on port 8080. Start the scraper and try again.', nowIso(), mailJobId);
      return;
    }

    // 2) Wait for any active lead search to finish (single active job rule).
    markMailJob(mailJobId, { stage: 'collecting businesses', current_website: 'Waiting for the current search…' });
    let waited = 0;
    while (currentRunId && waited < 5 * 60 * 1000) {
      if (isStopped()) return;
      await sleep(3000);
      waited += 3000;
    }
    if (isStopped()) return;

    // 3) Collect businesses. While the scraper is still collecting, harvest
    // emails from whatever has already arrived so the user sees live progress
    // instead of staring at "0 emails" for many minutes.
    let activeRunId = null;
    const onRunId = (id) => {
      if (id) activeRunId = id;
    };

    const watcher = setInterval(() => {
      if (isStopped()) return;
      try {
        const rid = activeRunId;
        if (!rid) return;
        const count = db.prepare('SELECT COUNT(*) as c FROM results WHERE run_id=?').get(rid).c;
        const stateRow = db.prepare('SELECT businesses_checked FROM mail_jobs WHERE id=?').get(mailJobId);
        const text = stateRow && stateRow.businesses_checked > 0
          ? 'Finding emails while collecting more businesses…'
          : 'Collecting business listings…';
        db.prepare(
          "UPDATE mail_jobs SET run_id=?, businesses_total=?, current_website=?, stage='collecting businesses', updated_at=? WHERE id=?"
        ).run(rid, count, text, nowIso(), mailJobId);
      } catch (_) {
        /* ignore */
      }
    }, 3000);

    let harvestChain = Promise.resolve();
    const harvest = () => {
      harvestChain = harvestChain.then(async () => {
        const rid = activeRunId;
        if (!rid || isStopped()) return;
        try {
          await processMailJob(mailJobId, { runId: rid, source: 'run', final: false });
        } catch (err) {
          console.error(`mail job ${mailJobId} incremental harvest error:`, err.message);
        }
      });
      return harvestChain;
    };
    const harvestTimer = setInterval(harvest, 15000);

    let run;
    try {
      run = await startSearchRun({ niche, state, city, maxResults, deepSearch, extraVariants, onRunId });
    } finally {
      clearInterval(watcher);
      clearInterval(harvestTimer);
      await harvestChain;
    }

    if (run.busy) {
      db.prepare(
        "UPDATE mail_jobs SET status='failed', stage='finished', error_reason=?, updated_at=? WHERE id=?"
      ).run('Another search is still running. Please try again in a few minutes.', nowIso(), mailJobId);
      return;
    }
    if (isStopped()) return;

    const runId = run.runId || run.id;
    const total = db.prepare('SELECT COUNT(*) as c FROM results WHERE run_id=?').get(runId).c;
    if (total === 0) {
      db.prepare(
        "UPDATE mail_jobs SET status='failed', stage='finished', error_reason=?, updated_at=? WHERE id=?"
      ).run('No businesses found for this search. Try a different niche or city.', nowIso(), mailJobId);
      return;
    }
    db.prepare(
      "UPDATE mail_jobs SET run_id=?, businesses_total=?, stage='finding emails', current_website=?, updated_at=? WHERE id=?"
    ).run(runId, total, 'Reading websites for public emails…', nowIso(), mailJobId);

    // 4) Extract emails from listings + crawl websites.
    await processMailJob(mailJobId, { runId, source: 'run' });
  } catch (err) {
    console.error(`mail job ${mailJobId} failed:`, err.message);
    db.prepare(
      "UPDATE mail_jobs SET status='failed', stage='finished', error_reason=?, updated_at=? WHERE id=?"
    ).run(err.message || 'Mail Finder job failed', nowIso(), mailJobId);
  }
}

function enqueueMailJob(mailJobId, opts) {
  mailQueue.push({ mailJobId, opts });
  if (mailWorkerRunning) return;
  mailWorkerRunning = true;
  (async () => {
    try {
      while (mailQueue.length > 0) {
        const next = mailQueue.shift();
        activeMailJobId = next.mailJobId;
        await runMailJobInBackground(next.mailJobId, next.opts);
        activeMailJobId = null;
      }
    } finally {
      mailWorkerRunning = false;
      activeMailJobId = null;
    }
  })().catch((err) => console.error('mail queue error:', err.message));
}

app.post('/api/mail/search', async (req, res) => {
  const {
    mode = 'new',
    sourceRunId = null,
    niche,
    state,
    city,
    maxResults,
    deepSearch,
    extraVariants,
  } = req.body || {};

  const st = findState(state);
  if (!st) return res.status(400).json({ error: 'unknown state' });
  if (mode !== 'contacts' && !String(niche || '').trim()) {
    return res.status(400).json({ error: 'niche and state are required' });
  }

  // Maximum leads: null means "all available". Otherwise clamp to a sane ceiling.
  const requestedMax = Number(maxResults);
  const safeMaxResults =
    Number.isFinite(requestedMax) && requestedMax > 0 ? Math.min(Math.floor(requestedMax), 20000) : null;

  const id = crypto.randomUUID();
  const now = nowIso();
  const jobNiche = mode === 'contacts' ? String(niche || 'From my contacts') : String(niche).trim();
  db.prepare(
    `INSERT INTO mail_jobs(id, niche, state, city, status, stage, source, run_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, jobNiche, st.name, city || null, 'queued', 'queued', mode === 'contacts' ? 'contacts' : 'new', sourceRunId || null, now, now);

  enqueueMailJob(id, {
    mode,
    sourceRunId: sourceRunId || null,
    niche: jobNiche,
    state: st.name,
    city: city || null,
    maxResults: safeMaxResults,
    deepSearch,
    extraVariants,
  });

  res.json({ mailJobId: id, state: st.name, queued: true });
});

app.get('/api/mail/:id/progress', (req, res) => {
  const id = req.params.id;
  const job = db.prepare('SELECT * FROM mail_jobs WHERE id=?').get(id);
  if (!job) return res.status(404).json({ error: 'mail job not found' });
  const found = db.prepare("SELECT COUNT(*) as c FROM mail_results WHERE mail_job_id=? AND TRIM(COALESCE(email,''))<>''").get(id).c;
  res.json({
    id: job.id,
    niche: job.niche,
    state: job.state,
    city: job.city,
    status: job.status,
    stage: job.stage,
    runId: job.run_id,
    source: job.source,
    resultsFound: found,
    emailsTotal: found,
    businessesTotal: job.businesses_total || 0,
    businessesChecked: job.businesses_checked || 0,
    businessesWithEmail: job.businesses_with_email || 0,
    websitesChecked: job.websites_checked || 0,
    websitesWithEmail: job.websites_with_email || 0,
    pagesCrawled: job.pages_crawled || 0,
    currentWebsite: job.current_website || '',
    errorReason: job.error_reason || '',
    createdAt: job.created_at,
    startedAt: job.created_at,
    updatedAt: job.updated_at,
  });
});

app.get('/api/mail/:id/results', (req, res) => {
  const id = req.params.id;
  const job = db.prepare('SELECT id, created_at FROM mail_jobs WHERE id=?').get(id);
  if (!job) return res.status(404).json({ error: 'mail job not found' });

  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 100);
  const offset = (page - 1) * limit;
  const search = String(req.query.q || '').trim();
  const filter = String(req.query.filter || req.query.status || '').toLowerCase();
  const showInvalid = req.query.show_invalid === 'true';
  const newOnly = req.query.new_only === 'true';
  const cityFilter = String(req.query.city || '').trim();

  // Emails only: a business without an email is counted, never listed.
  let where = "WHERE mail_job_id=? AND TRIM(COALESCE(email,''))<>''";
  const params = [id];
  if (!showInvalid) where += " AND COALESCE(status,'') <> 'invalid'";
  if (filter === 'valid' || filter === 'risky' || filter === 'invalid') {
    where += ' AND status=?';
    params.push(filter);
  } else if (filter === 'generic' || filter === 'personal') {
    where += ' AND type=?';
    params.push(filter);
  } else if (filter === 'has_phone') {
    where += " AND TRIM(COALESCE(phone,''))<>''";
  }
  if (search) {
    where += ' AND (LOWER(business_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(address) LIKE ? OR LOWER(city) LIKE ? OR LOWER(state) LIKE ?)';
    const like = `%${search.toLowerCase()}%`;
    params.push(like, like, like, like, like);
  }
  if (cityFilter) {
    where += " AND LOWER(COALESCE(city, '')) = LOWER(?)";
    params.push(cityFilter);
  }
  if (newOnly) {
    where += ` AND LOWER(email) NOT IN (
      SELECT LOWER(mr.email) FROM mail_results mr
      JOIN mail_jobs mj ON mj.id = mr.mail_job_id
      WHERE mj.id <> ? AND mj.created_at < ?
        AND mr.email IS NOT NULL AND TRIM(mr.email) <> ''
    )`;
    params.push(id, job.created_at);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM (SELECT LOWER(email) FROM mail_results ${where} GROUP BY LOWER(email))`
  ).get(...params).c;
  const rows = db.prepare(
    `SELECT business_name, email, type, status, phone, website, city, state, address, found_on
     FROM mail_results ${where}
     GROUP BY LOWER(email)
     ORDER BY state COLLATE NOCASE, city COLLATE NOCASE, business_name COLLATE NOCASE
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ rows, total, page, limit, totalPages: Math.ceil(total / limit) });
});

app.post('/api/mail/:id/stop', (req, res) => {
  const id = req.params.id;
  const job = db.prepare('SELECT id, run_id FROM mail_jobs WHERE id=?').get(id);
  if (!job) return res.status(404).json({ error: 'mail job not found' });

  db.prepare("UPDATE mail_jobs SET status='stopped', stage='stopped', updated_at=? WHERE id=?").run(nowIso(), id);
  const queuedIndex = mailQueue.findIndex((q) => q.mailJobId === id);
  if (queuedIndex >= 0) mailQueue.splice(queuedIndex, 1);

  // If the linked lead search is still running, stop it too. Emails already
  // saved stay in mail_results and remain downloadable.
  if (job.run_id && currentRunId === job.run_id) {
    db.prepare("UPDATE run_jobs SET status='stopped', updated_at=? WHERE run_id=? AND status IN ('queued','working')").run(nowIso(), job.run_id);
    db.prepare("UPDATE runs SET status='stopped', updated_at=? WHERE id=?").run(nowIso(), job.run_id);
    currentRunId = null;
    const scraperJobs = db.prepare("SELECT scraper_job_id FROM run_jobs WHERE run_id=? AND scraper_job_id IS NOT NULL").all(job.run_id);
    for (const sj of scraperJobs) deleteScraperJob(sj.scraper_job_id);
  }
  res.json({ stopped: true });
});

app.get('/api/mail/sources', (_req, res) => {
  const rows = db.prepare(
    `SELECT r.id, r.niche, r.state, r.city, r.status, r.result_count, r.created_at,
        (SELECT COUNT(*) FROM results x WHERE x.run_id=r.id AND TRIM(COALESCE(x.emails,''))<>'') AS with_email
     FROM runs r
     WHERE r.result_count > 0
     ORDER BY r.created_at DESC
     LIMIT 100`
  ).all();
  res.json(rows);
});

app.get('/api/mail/jobs', (_req, res) => {
  const rows = db.prepare(
    `SELECT m.*,
        (SELECT COUNT(*) FROM mail_results x WHERE x.mail_job_id=m.id AND TRIM(COALESCE(x.email,''))<>'') AS emails_found
     FROM mail_jobs m ORDER BY m.created_at DESC LIMIT 200`
  ).all();
  res.json(rows);
});

app.delete('/api/mail', (req, res) => {
  const jobs = db.prepare('SELECT id FROM mail_jobs').all();
  mailQueue.length = 0;
  const tx = db.transaction(() => {
    for (const job of jobs) {
      db.prepare('DELETE FROM mail_results WHERE mail_job_id=?').run(job.id);
      db.prepare('DELETE FROM mail_job_businesses WHERE mail_job_id=?').run(job.id);
      db.prepare('DELETE FROM mail_jobs WHERE id=?').run(job.id);
    }
  });
  tx();
  res.json({ deleted: jobs.length });
});

app.delete('/api/mail/:id', (req, res) => {
  const id = req.params.id;
  const job = db.prepare('SELECT id FROM mail_jobs WHERE id=?').get(id);
  if (!job) return res.status(404).json({ error: 'mail job not found' });
  const queuedIndex = mailQueue.findIndex((q) => q.mailJobId === id);
  if (queuedIndex >= 0) mailQueue.splice(queuedIndex, 1);
  db.prepare('DELETE FROM mail_results WHERE mail_job_id=?').run(id);
  db.prepare('DELETE FROM mail_job_businesses WHERE mail_job_id=?').run(id);
  db.prepare('DELETE FROM mail_jobs WHERE id=?').run(id);
  res.json({ deleted: true, id });
});

app.get('/api/mail/:id/download', async (req, res) => {
  const id = req.params.id;
  const format = String(req.query.format || 'xlsx').toLowerCase();
  const splitBy = String(req.query.split_by || '').toLowerCase(); // '', 'city', 'state'
  const columnsRaw = String(req.query.columns || 'business_name,email,city,state');
  const showInvalid = req.query.show_invalid === 'true';
  const cityFilter = String(req.query.city || '').trim();

  const job = db.prepare('SELECT niche, state, city, created_at FROM mail_jobs WHERE id=?').get(id);
  if (!job) return res.status(404).json({ error: 'mail job not found' });

  const search = String(req.query.q || '').trim();
  const filter = String(req.query.filter || '').toLowerCase();
  const newOnly = req.query.new_only === 'true';

  let sql = "SELECT business_name, email, type, status, phone, website, city, state, address, found_on FROM mail_results WHERE mail_job_id=? AND TRIM(COALESCE(email,''))<>''";
  const sqlParams = [id];
  if (!showInvalid) sql += " AND COALESCE(status,'')<>'invalid'";
  if (cityFilter) {
    sql += " AND LOWER(COALESCE(city, '')) = LOWER(?)";
    sqlParams.push(cityFilter);
  }
  if (filter === 'generic' || filter === 'personal') {
    sql += ' AND type=?';
    sqlParams.push(filter);
  }
  if (search) {
    sql += ' AND (LOWER(business_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(address) LIKE ? OR LOWER(city) LIKE ? OR LOWER(state) LIKE ?)';
    const like = `%${search.toLowerCase()}%`;
    sqlParams.push(like, like, like, like, like);
  }
  if (newOnly) {
    sql += ` AND LOWER(email) NOT IN (
      SELECT LOWER(mr.email) FROM mail_results mr
      JOIN mail_jobs mj ON mj.id = mr.mail_job_id
      WHERE mj.id <> ? AND mj.created_at < ?
        AND mr.email IS NOT NULL AND TRIM(mr.email) <> ''
    )`;
    sqlParams.push(id, job.created_at);
  }
  sql += ' ORDER BY state COLLATE NOCASE, city COLLATE NOCASE, business_name COLLATE NOCASE';
  const rawRows = db.prepare(sql).all(...sqlParams);

  // One row per email, and never guess a city that is not in the address.
  const seen = new Set();
  const rows = [];
  for (const r of rawRows) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    rows.push({
      ...r,
      email,
      business_name: String(r.business_name || '').trim(),
      address: String(r.address || '').trim(),
      city: canonicalCity(r.city, job.state, r.address),
      state: canonicalCityState(r.state, job.state),
      type: r.type === 'personal' ? 'Personal' : 'Generic',
      status: r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '',
    });
  }

  const colDefs = {
    business_name: { header: 'Business Name', key: 'business_name', width: 44 },
    email: { header: 'Email', key: 'email', width: 46 },
    address: { header: 'Address', key: 'address', width: 60 },
    city: { header: 'City', key: 'city', width: 22 },
    state: { header: 'State', key: 'state', width: 26 },
    phone: { header: 'Phone', key: 'phone', width: 20 },
    website: { header: 'Website', key: 'website', width: 38 },
    type: { header: 'Type', key: 'type', width: 14 },
    status: { header: 'Status', key: 'status', width: 14 },
  };
  const colKeys = columnsRaw.split(',').map((s) => s.trim()).filter((k) => colDefs[k]);
  if (!colKeys.length) colKeys.push('business_name', 'email', 'city', 'state');
  const cols = colKeys.map((k) => colDefs[k]);

  const sanitizeSheetName = (name) =>
    String(name || 'Unknown').replace(/[\\/?*[\]:]/g, '').trim().slice(0, 31) || 'Unknown';

  const formatSheet = (ws, data) => {
    ws.columns = cols;
    cols.forEach((c) => {
      if (c.key === 'email' || c.key === 'phone') ws.getColumn(c.key).numFmt = '@';
      if (c.key === 'address' || c.key === 'business_name') ws.getColumn(c.key).alignment = { wrapText: true, vertical: 'top' };
    });
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    header.alignment = { vertical: 'middle' };
    header.height = 20;
    for (const row of data) {
      const obj = {};
      for (const k of colKeys) obj[k] = row[k] || '';
      ws.addRow(obj);
    }
    const lastCol = String.fromCharCode(64 + Math.min(colKeys.length, 26));
    ws.autoFilter = { from: 'A1', to: `${lastCol}1` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const location = String(job.city || job.state || 'all').replace(/[^A-Za-z0-9]+/g, '_');
  const nicheStr = String(job.niche || 'leads').replace(/[^A-Za-z0-9]+/g, '_');
  const fileBase = `MailFinder_${nicheStr}_${location}_${dateStr}`;

  if (format === 'xlsx') {
    const wb = new Workbook();
    if (splitBy === 'city' || splitBy === 'state') {
      const groups = new Map();
      for (const r of rows) {
        const key = splitBy === 'city' ? (r.city || 'Unknown city') : (r.state || 'Unknown state');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      formatSheet(wb.addWorksheet('All emails'), rows);
      for (const [name, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        formatSheet(wb.addWorksheet(sanitizeSheetName(name)), group);
      }
    } else {
      formatSheet(wb.addWorksheet('Emails'), rows);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
    return;
  }

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [colKeys.map((k) => colDefs[k].header).join(',')];
  for (const r of rows) lines.push(colKeys.map((k) => esc(r[k] || '')).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});

// ---------- export helpers ----------
// Guarantee a clean export: within one run a business must appear only once,
// no matter how many cities / keyword variants / levels produced it. Phone
// numbers are normalized before writing so Excel/CSV always get +91 numbers.
function dedupeLeads(rows) {
  const byPhone = new Map();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const name = String(r.name || '').trim();
    const phone = normalizePhone(r.phone);
    const address = String(r.address || '').trim();
    const key = `${name.toLowerCase()}|${address.toLowerCase()}`;
    if (byPhone.has(phone) || seen.has(key)) continue;
    seen.add(key);
    byPhone.set(phone, true);
    out.push({
      name,
      phone,
      address,
      emails: String(r.emails || '').trim(),
      city: String(r.city || '').trim(),
      state: String(r.state || '').trim(),
    });
  }
  return out;
}

app.get('/api/runs/:id/download', async (req, res) => {
  const runId = req.params.id;
  const format = req.query.format || 'csv';
  const rows = db
    .prepare('SELECT name, phone, address, emails, city, state FROM results WHERE run_id=? ORDER BY name')
    .all(runId);

  const clean = dedupeLeads(rows);

  if (format === 'xlsx') {
    const wb = new Workbook();
    const ws = wb.addWorksheet('Leads', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Business Name', key: 'name', width: 42 },
      { header: 'Phone Number', key: 'phone', width: 20 },
      { header: 'Email', key: 'emails', width: 50 },
      { header: 'Address', key: 'address', width: 70 },
      { header: 'City', key: 'city', width: 22 },
      { header: 'State', key: 'state', width: 26 },
    ];

    // Force phone numbers to stay as text so Excel keeps the leading "+".
    ws.getColumn('phone').numFmt = '@';
    ws.getColumn('emails').numFmt = '@';
    ws.getColumn('address').alignment = { wrapText: true, vertical: 'top' };
    ws.getColumn('name').alignment = { wrapText: true, vertical: 'top' };

    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    header.alignment = { vertical: 'middle' };
    header.height = 20;

    for (const row of clean) {
      ws.addRow(row);
    }

    ws.autoFilter = { from: 'A1', to: 'F1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${runId}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } else {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['Business Name,Phone Number,Email,Address,City,State'];
    for (const r of clean) {
      lines.push(
        [r.name, r.phone, r.emails || '', r.address, r.city, r.state].map(esc).join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${runId}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  }
});

// ---------- global leads endpoint (Lead Database) ----------
// Returns all unique leads across all runs, de-duplicated by phone,
// with filtering, sorting and pagination.
function isMobilePhone(phone) {
  const s = String(phone || '').replace(/[^0-9]/g, '');
  // Indian mobile: +91 followed by 10 digits starting with 6-9
  return /^\+?91?[6-9]\d{9}$/.test(s) || (/^[6-9]\d{9}$/.test(s));
}

app.get('/api/leads', async (req, res) => {
  const {
    page = 1,
    limit = 50,
    q = '',
    state,
    city,
    niche,
    has_email,
    phone_type,
    from,
    to,
    sort = 'recent',
  } = req.query;

  const pageNum = Math.max(1, parseInt(String(page), 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10)));
  const offset = (pageNum - 1) * limitNum;

  // Fetch all results joined with runs (niche from run)
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.phone, r.address, r.state, r.city, r.emails, r.created_at,
              run.niche AS run_niche, run.status AS run_status, run.created_at AS run_created_at
       FROM results r
       JOIN runs run ON r.run_id = run.id`
    )
    .all();

  // De-duplicate by normalized phone: keep the most recent entry per phone
  const byPhone = new Map();
  for (const r of rows) {
    const phone = normalizePhone(r.phone);
    if (!phone) continue;
    const existing = byPhone.get(phone);
    if (!existing || new Date(r.created_at || 0) > new Date(existing.created_at || 0)) {
      byPhone.set(phone, r);
    }
  }
  let leads = Array.from(byPhone.values());

  // Apply filters
  const qLower = String(q).toLowerCase().trim();
  leads = leads.filter((r) => {
    if (qLower) {
      const haystack = `${r.name || ''} ${r.phone || ''} ${r.address || ''} ${r.city || ''} ${r.state || ''}`.toLowerCase();
      if (!haystack.includes(qLower)) return false;
    }
    if (state && String(r.state || '').toLowerCase() !== String(state).toLowerCase()) return false;
    if (city && String(r.city || '').toLowerCase() !== String(city).toLowerCase()) return false;
    if (niche && String(r.run_niche || '').toLowerCase() !== String(niche).toLowerCase()) return false;
    if (has_email === 'true' && !(r.emails && r.emails.trim())) return false;
    if (has_email === 'false' && (r.emails && r.emails.trim())) return false;
    if (phone_type === 'mobile' && !isMobilePhone(r.phone)) return false;
    if (phone_type === 'landline' && isMobilePhone(r.phone)) return false;
    if (from && String(r.created_at || '') < String(from)) return false;
    if (to && String(r.created_at || '') > String(to)) return false;
    return true;
  });

  // Sort
  leads.sort((a, b) => {
    if (sort === 'name') {
      return String(a.name || '').localeCompare(String(b.name || ''));
    }
    if (sort === 'city') {
      return String(a.city || '').localeCompare(String(b.city || ''));
    }
    if (sort === 'state') {
      return String(a.state || '').localeCompare(String(b.state || ''));
    }
    // recent: newest created_at first
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  const total = leads.length;
  const paged = leads.slice(offset, offset + limitNum);

  const out = paged.map((r) => ({
    id: r.id,
    name: r.name || '',
    phone: r.phone || '',
    address: r.address || '',
    state: r.state || '',
    city: r.city || '',
    emails: r.emails || '',
    niche: r.run_niche || '',
    created_at: r.created_at || '',
    phone_type: isMobilePhone(r.phone) ? 'mobile' : 'landline',
  }));

  res.json({ rows: out, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) });
});

// ---------- bulk export all leads ----------
app.get('/api/leads/export', async (req, res) => {
  const { ids, format = 'csv', q = '', state, city, niche, has_email, phone_type, from, to } = req.query;

  // Fetch all results joined with runs
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.phone, r.address, r.state, r.city, r.emails, r.created_at,
              run.niche AS run_niche
       FROM results r
       JOIN runs run ON r.run_id = run.id`
    )
    .all();

  // De-duplicate by normalized phone: keep most recent per phone
  const byPhone = new Map();
  for (const r of rows) {
    const phone = normalizePhone(r.phone);
    if (!phone) continue;
    const existing = byPhone.get(phone);
    if (!existing || new Date(r.created_at || 0) > new Date(existing.created_at || 0)) {
      byPhone.set(phone, r);
    }
  }
  let leads = Array.from(byPhone.values());

  // If specific IDs requested, filter to those
  if (ids) {
    const idSet = new Set(String(ids).split(',').map((s) => s.trim()).filter(Boolean));
    leads = leads.filter((r) => idSet.has(r.id));
  }

  // Apply same filters as /api/leads
  const qLower = String(q).toLowerCase().trim();
  leads = leads.filter((r) => {
    if (qLower) {
      const haystack = `${r.name || ''} ${r.phone || ''} ${r.address || ''} ${r.city || ''} ${r.state || ''}`.toLowerCase();
      if (!haystack.includes(qLower)) return false;
    }
    if (state && String(r.state || '').toLowerCase() !== String(state).toLowerCase()) return false;
    if (city && String(r.city || '').toLowerCase() !== String(city).toLowerCase()) return false;
    if (niche && String(r.run_niche || '').toLowerCase() !== String(niche).toLowerCase()) return false;
    if (has_email === 'true' && !(r.emails && r.emails.trim())) return false;
    if (has_email === 'false' && (r.emails && r.emails.trim())) return false;
    if (phone_type === 'mobile' && !isMobilePhone(r.phone)) return false;
    if (phone_type === 'landline' && isMobilePhone(r.phone)) return false;
    if (from && String(r.created_at || '') < String(from)) return false;
    if (to && String(r.created_at || '') > String(to)) return false;
    return true;
  });

  // Sort newest first
  leads.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const clean = leads.map((r) => ({
    name: r.name || '',
    phone: r.phone || '',
    emails: r.emails || '',
    address: r.address || '',
    city: r.city || '',
    state: r.state || '',
  }));

  const fileName = `leads-all-${new Date().toISOString().slice(0, 10)}`;

  if (format === 'xlsx') {
    const wb = new Workbook();
    const ws = wb.addWorksheet('Leads', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Business Name', key: 'name', width: 42 },
      { header: 'Phone Number', key: 'phone', width: 20 },
      { header: 'Email', key: 'emails', width: 50 },
      { header: 'Address', key: 'address', width: 70 },
      { header: 'City', key: 'city', width: 22 },
      { header: 'State', key: 'state', width: 26 },
    ];
    ws.getColumn('phone').numFmt = '@';
    ws.getColumn('emails').numFmt = '@';
    ws.getColumn('address').alignment = { wrapText: true, vertical: 'top' };
    ws.getColumn('name').alignment = { wrapText: true, vertical: 'top' };
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    header.alignment = { vertical: 'middle' };
    header.height = 20;
    for (const row of clean) ws.addRow(row);
    ws.autoFilter = { from: 'A1', to: 'F1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } else {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['Business Name,Phone Number,Email,Address,City,State'];
    for (const r of clean) {
      lines.push([r.name, r.phone, r.emails || '', r.address, r.city, r.state].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  }
});

/* ================================================================== */
/* WhatsApp bulk sender (Baileys)                                      */
/* ================================================================== */

const WA_SESSION_DIR = path.join(path.dirname(DB_PATH), 'wa-session');
wa.configure(WA_SESSION_DIR);

// Any message left mid-send by a restart goes back in the queue.
try { db.prepare("UPDATE wa_messages SET status='pending' WHERE status='sending'").run(); } catch (_) {}
try {
  db.prepare("UPDATE wa_jobs SET status='paused', error='Server restarted - press Resume', updated_at=? WHERE status='running'").run(nowIso());
} catch (_) {}

function renderWaTemplate(template, row) {
  return String(template || '')
    .replace(/\{name\}/gi, row.name || 'there')
    .replace(/\{city\}/gi, row.city || '')
    .replace(/\{state\}/gi, row.state || '')
    .replace(/\{phone\}/gi, row.phone || '');
}

function waTodayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function waSentToday() {
  return db.prepare("SELECT COUNT(*) AS c FROM wa_messages WHERE status='sent' AND sent_at >= ?").get(waTodayStartIso()).c;
}

function waBlacklistSet() {
  return new Set(db.prepare('SELECT phone FROM wa_blacklist').all().map((r) => wa.normalizePhone(r.phone)));
}

function waBuildRecipients({ state, city, limit } = {}) {
  const where = ["phone IS NOT NULL", "phone <> ''"];
  const params = [];
  if (state) {
    where.push('state = ?');
    params.push(state);
  }
  if (city) {
    where.push('LOWER(city) = LOWER(?)');
    params.push(city);
  }

  const rows = db
    .prepare(
      `SELECT phone, MAX(name) AS name, MAX(city) AS city, MAX(state) AS state
         FROM results
        WHERE ${where.join(' AND ')}
        GROUP BY phone
        ORDER BY MAX(created_at) DESC`
    )
    .all(...params);

  const blacklist = waBlacklistSet();
  const already = new Set(
    db
      .prepare("SELECT DISTINCT phone FROM wa_messages WHERE status IN ('sent','pending','sending')")
      .all()
      .map((r) => wa.normalizePhone(r.phone))
  );

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const phone = wa.normalizePhone(row.phone);
    if (!phone || phone.length < 10) continue;
    if (blacklist.has(phone) || already.has(phone) || seen.has(phone)) continue;
    seen.add(phone);
    out.push({ phone, name: row.name || '', city: row.city || '', state: row.state || '' });
    if (limit && out.length >= limit) break;
  }
  return out;
}

function countActiveWaJob() {
  return db
    .prepare("SELECT id FROM wa_jobs WHERE status IN ('running','paused') ORDER BY created_at DESC LIMIT 1")
    .get();
}

const runningWaJobs = new Set();

async function runWaJob(jobId) {
  if (runningWaJobs.has(jobId)) return;
  runningWaJobs.add(jobId);
  try {
    for (;;) {
      const job = db.prepare('SELECT * FROM wa_jobs WHERE id=?').get(jobId);
      if (!job || job.status !== 'running') break;

      if (!wa.isConnected()) {
        db.prepare("UPDATE wa_jobs SET status='paused', error=?, updated_at=? WHERE id=?").run(
          'WhatsApp disconnected',
          nowIso(),
          jobId
        );
        break;
      }

      if (waSentToday() >= job.daily_cap) {
        db.prepare("UPDATE wa_jobs SET status='capped', error=?, updated_at=? WHERE id=?").run(
          `Daily cap of ${job.daily_cap} reached`,
          nowIso(),
          jobId
        );
        break;
      }

      const msg = db
        .prepare("SELECT * FROM wa_messages WHERE job_id=? AND status='pending' ORDER BY created_at LIMIT 1")
        .get(jobId);

      if (!msg) {
        db.prepare("UPDATE wa_jobs SET status='done', error=NULL, updated_at=? WHERE id=?").run(nowIso(), jobId);
        break;
      }

      db.prepare("UPDATE wa_messages SET status='sending' WHERE id=?").run(msg.id);
      const text = renderWaTemplate(job.template, msg);

      try {
        const sent = await wa.sendText(msg.phone, text);
        db.prepare(
          "UPDATE wa_messages SET status='sent', wa_message_id=?, sent_at=?, message=?, error=NULL WHERE id=?"
        ).run(sent.id, nowIso(), text, msg.id);
        db.prepare('UPDATE wa_jobs SET sent=sent+1, updated_at=? WHERE id=?').run(nowIso(), jobId);
      } catch (err) {
        db.prepare("UPDATE wa_messages SET status='failed', message=?, error=? WHERE id=?").run(
          text,
          err.message,
          msg.id
        );
        db.prepare('UPDATE wa_jobs SET failed=failed+1, updated_at=? WHERE id=?').run(nowIso(), jobId);
        if (/not connected/i.test(err.message)) {
          db.prepare("UPDATE wa_jobs SET status='paused', error=?, updated_at=? WHERE id=?").run(
            err.message,
            nowIso(),
            jobId
          );
          break;
        }
      }

      const next = db
        .prepare("SELECT 1 FROM wa_messages WHERE job_id=? AND status='pending' LIMIT 1")
        .get(jobId);
      if (!next) {
        db.prepare("UPDATE wa_jobs SET status='done', error=NULL, updated_at=? WHERE id=?").run(nowIso(), jobId);
        break;
      }

      // Rate limit: delay + random jitter so traffic never looks like a burst.
      const base = Math.max(5, job.delay_seconds || 30) * 1000;
      const jitter = Math.floor(Math.random() * 15000);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  } catch (err) {
    db.prepare("UPDATE wa_jobs SET status='failed', error=?, updated_at=? WHERE id=?").run(
      err.message,
      nowIso(),
      jobId
    );
  } finally {
    runningWaJobs.delete(jobId);
  }
}

app.get('/api/whatsapp/status', (_req, res) => {
  res.json({ ...wa.getState(), todaySent: waSentToday() });
});

app.post('/api/whatsapp/connect', async (_req, res) => {
  try {
    const st = await wa.connect(WA_SESSION_DIR);
    res.json(st);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/logout', async (_req, res) => {
  try {
    const st = await wa.logout();
    res.json(st);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/recipients', (req, res) => {
  const { state = '', city = '', limit = '' } = req.query;
  const cap = parseInt(limit, 10) || 0;
  const all = waBuildRecipients({ state: String(state).trim(), city: String(city).trim() });
  const selected = cap > 0 ? all.slice(0, cap) : all;
  res.json({
    matched: all.length,
    selected: selected.length,
    sample: selected.slice(0, 10),
  });
});

// Send a single real message to verify the setup. This is intentionally not
// part of a campaign, so it does not touch wa_jobs/wa_messages or the daily cap.
app.post('/api/whatsapp/test', async (req, res) => {
  if (!wa.isConnected()) {
    return res.status(409).json({ error: 'WhatsApp is not connected. Scan the QR code first.' });
  }

  const body = req.body || {};
  const phone = wa.normalizePhone(body.phone);
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Enter a valid phone number with country code.' });
  }

  const template = String(body.template || '').trim();
  if (!template) return res.status(400).json({ error: 'Test message is empty' });

  const text = renderWaTemplate(template, {
    name: String(body.name || '').trim() || 'there',
    city: String(body.city || '').trim(),
    state: String(body.state || '').trim(),
    phone,
  });

  try {
    const sent = await wa.sendText(phone, text);
    res.json({ sent: true, phone, messageId: sent.id, jid: sent.jid, text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send', (req, res) => {
  const body = req.body || {};
  const template = String(body.template || '').trim();
  if (template.length < 2) return res.status(400).json({ error: 'Message template is empty' });
  if (!wa.isConnected()) {
    return res.status(409).json({ error: 'WhatsApp is not connected. Scan the QR code first.' });
  }

  const active = countActiveWaJob();
  if (active) {
    return res.status(409).json({
      error: 'A WhatsApp campaign is already running. Stop or finish it first.',
      jobId: active.id,
    });
  }

  const delaySeconds = Math.min(600, Math.max(5, parseInt(body.delaySeconds, 10) || 30));
  const dailyCap = Math.min(1000, Math.max(1, parseInt(body.dailyCap, 10) || 100));
  const limit = Math.min(5000, Math.max(0, parseInt(body.limit, 10) || 0));
  const recipients = waBuildRecipients({
    state: String(body.state || '').trim(),
    city: String(body.city || '').trim(),
    limit,
  });

  if (!recipients.length) {
    return res.status(400).json({
      error: 'No eligible contacts. They may already be messaged, blacklisted, or the filter matched nothing.',
    });
  }

  const jobId = crypto.randomUUID();
  const now = nowIso();
  const insertJob = db.prepare(
    `INSERT INTO wa_jobs (id, template, delay_seconds, daily_cap, total, sent, failed, status, created_at, updated_at)
     VALUES (?,?,?,?,?,0,0,'running',?,?)`
  );
  const insertMsg = db.prepare(
    `INSERT INTO wa_messages (id, job_id, name, phone, city, state, message, status, created_at)
     VALUES (?,?,?,?,?,?,?, 'pending', ?)`
  );
  const tx = db.transaction(() => {
    insertJob.run(jobId, template, delaySeconds, dailyCap, recipients.length, now, now);
    for (const r of recipients) {
      insertMsg.run(crypto.randomUUID(), jobId, r.name, r.phone, r.city, r.state, renderWaTemplate(template, r), now);
    }
  });
  tx();

  runWaJob(jobId).catch((err) => console.error('wa job:', err.message));
  res.json({ jobId, total: recipients.length, delaySeconds, dailyCap });
});

app.get('/api/whatsapp/jobs', (_req, res) => {
  const jobs = db
    .prepare('SELECT * FROM wa_jobs ORDER BY created_at DESC LIMIT 25')
    .all();
  res.json(jobs);
});

app.get('/api/whatsapp/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM wa_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const counts = db
    .prepare('SELECT status, COUNT(*) AS c FROM wa_messages WHERE job_id=? GROUP BY status')
    .all(job.id);
  const total = db.prepare('SELECT COUNT(*) AS c FROM wa_messages WHERE job_id=?').get(job.id).c;
  const messages = db
    .prepare('SELECT * FROM wa_messages WHERE job_id=? ORDER BY created_at LIMIT ? OFFSET ?')
    .all(job.id, limit, (page - 1) * limit);

  res.json({
    job,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.c])),
    messages,
    total,
    page,
    limit,
  });
});

app.post('/api/whatsapp/jobs/:id/stop', (req, res) => {
  const info = db
    .prepare("UPDATE wa_jobs SET status='stopped', updated_at=? WHERE id=? AND status IN ('running','paused')")
    .run(nowIso(), req.params.id);
  res.json({ stopped: info.changes > 0 });
});

app.post('/api/whatsapp/jobs/:id/resume', (req, res) => {
  const job = db.prepare('SELECT * FROM wa_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!wa.isConnected()) return res.status(409).json({ error: 'WhatsApp is not connected' });

  const active = countActiveWaJob();
  if (active && active.id !== job.id) {
    return res.status(409).json({ error: 'Another WhatsApp campaign is running', jobId: active.id });
  }

  db.prepare("UPDATE wa_jobs SET status='running', error=NULL, updated_at=? WHERE id=?").run(
    nowIso(),
    job.id
  );
  runWaJob(job.id).catch((err) => console.error('wa job:', err.message));
  res.json({ resumed: true });
});

app.delete('/api/whatsapp/jobs/:id', (req, res) => {
  db.prepare('DELETE FROM wa_messages WHERE job_id=?').run(req.params.id);
  db.prepare('DELETE FROM wa_jobs WHERE id=?').run(req.params.id);
  res.json({ deleted: true });
});

app.get('/api/whatsapp/blacklist', (_req, res) => {
  res.json(db.prepare('SELECT * FROM wa_blacklist ORDER BY created_at DESC').all());
});

app.post('/api/whatsapp/blacklist', (req, res) => {
  const phone = wa.normalizePhone(req.body?.phone);
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
  db.prepare('INSERT OR REPLACE INTO wa_blacklist (phone, reason, created_at) VALUES (?,?,?)').run(
    phone,
    String(req.body?.reason || '').slice(0, 200),
    nowIso()
  );
  res.json({ added: true, phone });
});

app.delete('/api/whatsapp/blacklist/:phone', (req, res) => {
  const phone = wa.normalizePhone(req.params.phone);
  const info = db.prepare('DELETE FROM wa_blacklist WHERE phone=?').run(phone);
  res.json({ removed: info.changes > 0 });
});

/* ================================================================== */
/* Mail Sender (SMTP)                                                  */
/* ================================================================== */

const MAIL_DEFAULT_DELAY = Math.min(
  600,
  Math.max(5, parseInt(process.env.MAIL_DELAY_SECONDS || '45', 10) || 45)
);
const MAIL_DEFAULT_CAP = Math.min(
  500,
  Math.max(1, parseInt(process.env.MAIL_DAILY_CAP || '50', 10) || 50)
);

// Any message left mid-send by a restart goes back in the queue.
try {
  db.prepare("UPDATE mail_sender_messages SET status='pending' WHERE status='sending'").run();
} catch (_) {}
try {
  db.prepare(
    "UPDATE mail_sender_jobs SET status='paused', error='Server restarted - press Resume', updated_at=? WHERE status='running'"
  ).run(nowIso());
} catch (_) {}

function mailTodayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function mailSentToday() {
  return db
    .prepare("SELECT COUNT(*) AS c FROM mail_sender_messages WHERE status='sent' AND sent_at >= ?")
    .get(mailTodayStartIso()).c;
}

function mailBlacklistSet() {
  return new Set(
    db
      .prepare('SELECT email FROM mail_sender_blacklist')
      .all()
      .map((r) => mailer.normalizeEmail(r.email))
      .filter(Boolean)
  );
}

function mailBuildRecipients({ state, city, limit } = {}) {
  const where = [
    "email IS NOT NULL",
    "TRIM(email) <> ''",
    "COALESCE(status,'') <> 'invalid'",
  ];
  const params = [];
  if (state) {
    where.push('state = ?');
    params.push(state);
  }
  if (city) {
    where.push('LOWER(city) = LOWER(?)');
    params.push(city);
  }

  const rows = db
    .prepare(
      `SELECT email, MAX(business_name) AS business_name, MAX(city) AS city, MAX(state) AS state
         FROM mail_results
        WHERE ${where.join(' AND ')}
        GROUP BY LOWER(email)
        ORDER BY MAX(created_at) DESC`
    )
    .all(...params);

  const blacklist = mailBlacklistSet();
  const already = new Set(
    db
      .prepare(
        "SELECT DISTINCT email FROM mail_sender_messages WHERE status IN ('sent','pending','sending')"
      )
      .all()
      .map((r) => mailer.normalizeEmail(r.email))
      .filter(Boolean)
  );

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const email = mailer.normalizeEmail(row.email);
    if (!email) continue;
    if (blacklist.has(email) || already.has(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      name: row.business_name || '',
      business_name: row.business_name || '',
      city: row.city || '',
      state: row.state || '',
    });
    if (limit && out.length >= limit) break;
  }
  return out;
}

function activeMailJob() {
  return db
    .prepare(
      "SELECT id FROM mail_sender_jobs WHERE status IN ('running','paused') ORDER BY created_at DESC LIMIT 1"
    )
    .get();
}

const runningMailJobs = new Set();

async function runMailJob(jobId) {
  if (runningMailJobs.has(jobId)) return;
  runningMailJobs.add(jobId);

  try {
    for (;;) {
      const job = db.prepare('SELECT * FROM mail_sender_jobs WHERE id=?').get(jobId);
      if (!job || job.status !== 'running') break;

      if (!mailer.getConfig().configured) {
        db.prepare(
          "UPDATE mail_sender_jobs SET status='paused', error=?, updated_at=? WHERE id=?"
        ).run('SMTP is not configured', nowIso(), jobId);
        break;
      }

      if (mailSentToday() >= job.daily_cap) {
        db.prepare(
          "UPDATE mail_sender_jobs SET status='capped', error=?, updated_at=? WHERE id=?"
        ).run(`Daily cap of ${job.daily_cap} reached`, nowIso(), jobId);
        break;
      }

      const msg = db
        .prepare(
          "SELECT * FROM mail_sender_messages WHERE job_id=? AND status='pending' ORDER BY created_at LIMIT 1"
        )
        .get(jobId);

      if (!msg) {
        db.prepare("UPDATE mail_sender_jobs SET status='done', error=NULL, updated_at=? WHERE id=?").run(
          nowIso(),
          jobId
        );
        break;
      }

      db.prepare("UPDATE mail_sender_messages SET status='sending' WHERE id=?").run(msg.id);

      const subject = mailer.renderTemplate(job.subject, msg);
      const text = mailer.renderTemplate(job.template, msg);

      try {
        const sent = await mailer.sendMail({ to: msg.email, subject, text });
        db.prepare(
          "UPDATE mail_sender_messages SET status='sent', smtp_message_id=?, sent_at=?, subject=?, message=?, error=NULL WHERE id=?"
        ).run(sent.messageId || null, nowIso(), subject, text, msg.id);
        db.prepare('UPDATE mail_sender_jobs SET sent=sent+1, updated_at=? WHERE id=?').run(
          nowIso(),
          jobId
        );
      } catch (err) {
        const reason = String(err.message || 'send failed').slice(0, 500);
        db.prepare(
          "UPDATE mail_sender_messages SET status='failed', subject=?, message=?, error=? WHERE id=?"
        ).run(subject, text, reason, msg.id);
        db.prepare('UPDATE mail_sender_jobs SET failed=failed+1, updated_at=? WHERE id=?').run(
          nowIso(),
          jobId
        );

        // Auth/connection problems affect every remaining message, so pause.
        const fatal = /EAUTH|ECONNECTION|ETIMEDOUT|ESOCKET|EDNS|not configured|invalid login|535/i.test(
          reason
        );
        if (fatal) {
          db.prepare(
            "UPDATE mail_sender_jobs SET status='paused', error=?, updated_at=? WHERE id=?"
          ).run(reason, nowIso(), jobId);
          break;
        }
      }

      const next = db
        .prepare("SELECT 1 FROM mail_sender_messages WHERE job_id=? AND status='pending' LIMIT 1")
        .get(jobId);
      if (!next) {
        db.prepare("UPDATE mail_sender_jobs SET status='done', error=NULL, updated_at=? WHERE id=?").run(
          nowIso(),
          jobId
        );
        break;
      }

      // Rate limit: delay + small jitter, same idea as the WhatsApp sender.
      const base = Math.max(5, job.delay_seconds || 45) * 1000;
      const jitter = Math.floor(Math.random() * 10000);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  } catch (err) {
    db.prepare("UPDATE mail_sender_jobs SET status='failed', error=?, updated_at=? WHERE id=?").run(
      err.message,
      nowIso(),
      jobId
    );
  } finally {
    runningMailJobs.delete(jobId);
  }
}

app.get('/api/mailsender/status', (_req, res) => {
  res.json({
    ...mailer.getSafeConfig(),
    todaySent: mailSentToday(),
    defaultDelaySeconds: MAIL_DEFAULT_DELAY,
    defaultDailyCap: MAIL_DEFAULT_CAP,
  });
});

app.post('/api/mailsender/test', async (req, res) => {
  const to = mailer.normalizeEmail(req.body?.to);
  if (!to) return res.status(400).json({ error: 'Enter a valid email address.' });

  try {
    const sent = await mailer.sendMail({
      to,
      subject: 'Lead Finder test email',
      text: 'This is a test email from your Lead Finder app.\n\nIf you received it, your SMTP settings work.',
    });
    res.json({ sent: true, to, messageId: sent.messageId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/mailsender/recipients', (req, res) => {
  const { state = '', city = '', limit = '' } = req.query;
  const cap = parseInt(limit, 10) || 0;
  const all = mailBuildRecipients({
    state: String(state).trim(),
    city: String(city).trim(),
  });
  const selected = cap > 0 ? all.slice(0, cap) : all;
  res.json({
    matched: all.length,
    selected: selected.length,
    sample: selected.slice(0, 10),
  });
});

app.post('/api/mailsender/send', (req, res) => {
  const body = req.body || {};
  const subject = String(body.subject || '').trim();
  const template = String(body.template || '').trim();

  if (subject.length < 2) return res.status(400).json({ error: 'Subject is empty' });
  if (template.length < 5) return res.status(400).json({ error: 'Message is too short' });
  if (!mailer.getConfig().configured) {
    return res.status(409).json({
      error: 'Email is not configured. Add SMTP settings to backend/.env and restart.',
    });
  }

  const active = activeMailJob();
  if (active) {
    return res.status(409).json({
      error: 'A mail campaign is already running. Stop or finish it first.',
      jobId: active.id,
    });
  }

  const delaySeconds = Math.min(
    600,
    Math.max(5, parseInt(body.delaySeconds, 10) || MAIL_DEFAULT_DELAY)
  );
  const dailyCap = Math.min(500, Math.max(1, parseInt(body.dailyCap, 10) || MAIL_DEFAULT_CAP));
  const limit = Math.min(2000, Math.max(0, parseInt(body.limit, 10) || 0));

  const recipients = mailBuildRecipients({
    state: String(body.state || '').trim(),
    city: String(body.city || '').trim(),
    limit,
  });

  if (!recipients.length) {
    return res.status(400).json({
      error:
        'No eligible emails. They may already be contacted, opted out, or the filter matched nothing.',
    });
  }

  const jobId = crypto.randomUUID();
  const now = nowIso();
  const insertJob = db.prepare(
    `INSERT INTO mail_sender_jobs (id, subject, template, delay_seconds, daily_cap, total, sent, failed, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,0,'running',?,?)`
  );
  const insertMsg = db.prepare(
    `INSERT INTO mail_sender_messages (id, job_id, business_name, email, city, state, subject, message, status, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?)`
  );

  const tx = db.transaction(() => {
    insertJob.run(jobId, subject, template, delaySeconds, dailyCap, recipients.length, now, now);
    for (const r of recipients) {
      insertMsg.run(
        crypto.randomUUID(),
        jobId,
        r.business_name,
        r.email,
        r.city,
        r.state,
        mailer.renderTemplate(subject, r),
        mailer.renderTemplate(template, r),
        now
      );
    }
  });
  tx();

  runMailJob(jobId).catch((err) => console.error('mail job:', err.message));
  res.json({ jobId, total: recipients.length, delaySeconds, dailyCap });
});

app.get('/api/mailsender/jobs', (_req, res) => {
  res.json(db.prepare('SELECT * FROM mail_sender_jobs ORDER BY created_at DESC LIMIT 25').all());
});

app.get('/api/mailsender/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM mail_sender_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const counts = db
    .prepare('SELECT status, COUNT(*) AS c FROM mail_sender_messages WHERE job_id=? GROUP BY status')
    .all(job.id);
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM mail_sender_messages WHERE job_id=?')
    .get(job.id).c;
  const messages = db
    .prepare('SELECT * FROM mail_sender_messages WHERE job_id=? ORDER BY created_at LIMIT ? OFFSET ?')
    .all(job.id, limit, (page - 1) * limit);

  res.json({
    job,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.c])),
    messages,
    total,
    page,
    limit,
  });
});

app.post('/api/mailsender/jobs/:id/stop', (req, res) => {
  const info = db
    .prepare(
      "UPDATE mail_sender_jobs SET status='stopped', updated_at=? WHERE id=? AND status IN ('running','paused')"
    )
    .run(nowIso(), req.params.id);
  res.json({ stopped: info.changes > 0 });
});

app.post('/api/mailsender/jobs/:id/resume', (req, res) => {
  const job = db.prepare('SELECT * FROM mail_sender_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!mailer.getConfig().configured) {
    return res.status(409).json({ error: 'Email is not configured. Add SMTP settings first.' });
  }

  const active = activeMailJob();
  if (active && active.id !== job.id) {
    return res.status(409).json({ error: 'Another mail campaign is running', jobId: active.id });
  }

  db.prepare("UPDATE mail_sender_jobs SET status='running', error=NULL, updated_at=? WHERE id=?").run(
    nowIso(),
    job.id
  );
  runMailJob(job.id).catch((err) => console.error('mail job:', err.message));
  res.json({ resumed: true });
});

app.delete('/api/mailsender/jobs/:id', (req, res) => {
  db.prepare('DELETE FROM mail_sender_messages WHERE job_id=?').run(req.params.id);
  db.prepare('DELETE FROM mail_sender_jobs WHERE id=?').run(req.params.id);
  res.json({ deleted: true });
});

app.get('/api/mailsender/blacklist', (_req, res) => {
  res.json(db.prepare('SELECT * FROM mail_sender_blacklist ORDER BY created_at DESC').all());
});

app.post('/api/mailsender/blacklist', (req, res) => {
  const email = mailer.normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Invalid email address' });
  db.prepare(
    'INSERT OR REPLACE INTO mail_sender_blacklist (email, reason, created_at) VALUES (?,?,?)'
  ).run(email, String(req.body?.reason || '').slice(0, 200), nowIso());
  res.json({ added: true, email });
});

app.delete('/api/mailsender/blacklist/:email', (req, res) => {
  const email = mailer.normalizeEmail(req.params.email);
  const info = db.prepare('DELETE FROM mail_sender_blacklist WHERE email=?').run(email);
  res.json({ removed: info.changes > 0 });
});

// Add indexes for lead database performance (idempotent)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_results_phone ON results(phone)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_results_state ON results(state)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_results_city ON results(city)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at)'); } catch (_) {}

app.listen(PORT, () => {
  console.log(`Lead Finder backend listening on http://localhost:${PORT}`);
  console.log(`Scraper URL: ${SCRAPER_URL}`);

  // Clear abandoned scraper jobs first, then resume runs interrupted by a restart.
  cleanupScraperQueue()
    .catch((err) => console.error('cleanup scraper queue:', err.message))
    .finally(() => {
      // Any job still marked "running" when the backend stopped is now dead -> mark stopped.
      db.prepare("UPDATE run_jobs SET status='stopped', updated_at=? WHERE status='running'").run(nowIso());
      // Crash recovery: resume runs that were running.
      db.prepare("UPDATE runs SET status='queued', updated_at=? WHERE status='running'").run(nowIso());
      const resumable = db.prepare("SELECT id FROM runs WHERE status='queued'").all();
      for (const r of resumable) {
        processRunJobsConcurrent(r.id, { resume: true }).catch((err) =>
          console.error(`resume run ${r.id}:`, err.message)
        );
      }
    });
});

export { app };
