/* ------------------------------------------------------------------ */
/* sms.js — bulk SMS transport for the SMS Sender.                     */
/*                                                                     */
/* Two providers, chosen in the UI or with SMS_PROVIDER:              */
/*   fast2sms  India — API key, optional sender id / DLT route         */
/*   twilio    global — Account SID, Auth Token, From number            */
/*                                                                     */
/* Configuration can come from environment variables (highest         */
/* priority) or backend/data/sms-config.json saved from the UI         */
/* (mode 0600, gitignored). Secrets are never returned to the browser. */
/* ------------------------------------------------------------------ */

import fs from 'node:fs';
import path from 'node:path';

export const PROVIDERS = {
  fast2sms: {
    label: 'Fast2SMS (India)',
    signup: 'https://www.fast2sms.com/',
  },
  twilio: {
    label: 'Twilio (global)',
    signup: 'https://www.twilio.com/',
  },
  textbelt: {
    label: 'TextBelt (free tier)',
    signup: 'https://textbelt.com/',
  },
};

const DEFAULT_COUNTRY_CODE = '91';
const REQUEST_TIMEOUT_MS = 20000;

let configFile = null;
let fileConfig = {};

function env(name, fallback = '') {
  const value = process.env[name];
  return String(value === undefined || value === null ? fallback : value).trim();
}

function writeFileConfig(payload) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(configFile, 0o600);
  } catch (_) {
    /* Windows may ignore POSIX modes */
  }
}

function loadFileConfig() {
  if (!configFile) {
    fileConfig = {};
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fileConfig = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    fileConfig = {};
  }
}

/**
 * Point the SMS module at the data directory (same volume as the DB).
 * @param {string} dir
 */
export function configure(dir) {
  configFile = dir.toLowerCase().endsWith('.json')
    ? dir
    : path.join(dir, 'sms-config.json');
  loadFileConfig();
}

function pick(envName, fileKey) {
  const fromEnv = env(envName);
  if (fromEnv) return fromEnv;
  const value = fileConfig[fileKey];
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Normalize a phone number to digits only.
 * 10-digit local numbers get the configured country code.
 * @param {string} phone
 * @param {string} [countryCode]
 */
export function normalizePhone(phone, countryCode) {
  const cc = String(countryCode || DEFAULT_COUNTRY_CODE).replace(/\D/g, '') || DEFAULT_COUNTRY_CODE;
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = cc + digits;
  return digits;
}

/** Twilio needs E.164 with a leading +. */
function toE164(digits) {
  return `+${String(digits || '').replace(/\D/g, '')}`;
}

function normalizeCountryCode(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return DEFAULT_COUNTRY_CODE;
  return digits.slice(0, 4);
}

/** Effective configuration. Never exposed with secrets (see getSafeConfig). */
export function getConfig() {
  const provider = (pick('SMS_PROVIDER', 'provider') || 'fast2sms').toLowerCase();
  const countryCode = normalizeCountryCode(pick('SMS_COUNTRY_CODE', 'countryCode'));
  const apiKey = provider === 'textbelt' ? pick('TEXTBELT_API_KEY', 'apiKey') : pick('FAST2SMS_API_KEY', 'apiKey');
  const senderId = pick('FAST2SMS_SENDER_ID', 'senderId');
  const route = (pick('FAST2SMS_ROUTE', 'route') || 'q').toLowerCase();
  const templateId = pick('FAST2SMS_TEMPLATE_ID', 'templateId');
  const accountSid = pick('TWILIO_ACCOUNT_SID', 'accountSid');
  const authToken = pick('TWILIO_AUTH_TOKEN', 'authToken');
  const from = pick('TWILIO_FROM', 'from');

  let configured = false;
  if (provider === 'twilio') configured = !!(accountSid && authToken && from);
  else if (provider === 'fast2sms') configured = !!apiKey;
  else if (provider === 'textbelt') configured = !!apiKey;

  return {
    provider,
    countryCode,
    apiKey,
    senderId,
    route,
    templateId,
    accountSid,
    authToken,
    from,
    configured,
  };
}

/** Safe snapshot for the API/UI (no secrets). */
export function getSafeConfig() {
  const cfg = getConfig();
  const usingEnv = [
    'SMS_PROVIDER',
    'FAST2SMS_API_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TEXTBELT_API_KEY',
  ].some((key) => !!env(key));
  const usingFile = !usingEnv && !!(fileConfig.provider || fileConfig.apiKey || fileConfig.accountSid);

  return {
    configured: cfg.configured,
    provider: cfg.provider,
    providerLabel: PROVIDERS[cfg.provider]?.label || cfg.provider,
    countryCode: cfg.countryCode,
    senderId: cfg.senderId || null,
    route: cfg.route,
    templateId: cfg.templateId || null,
    accountSid: cfg.accountSid || null,
    from: cfg.from || null,
    hasApiKey: !!cfg.apiKey,
    hasAuthToken: !!cfg.authToken,
    source: usingEnv ? 'env' : usingFile ? 'file' : 'none',
    configFile: configFile || null,
  };
}

/** Throws a readable error when SMS is not configured. */
export function assertConfigured() {
  const cfg = getConfig();
  if (!PROVIDERS[cfg.provider]) {
    throw new Error(`Unknown SMS provider "${cfg.provider}". Choose fast2sms or twilio.`);
  }
  if (!cfg.configured) {
    throw new Error('SMS is not configured. Open SMS Sender and save your provider settings first.');
  }
  return cfg;
}

/**
 * Save settings from the UI. A blank secret keeps the existing one.
 * @param {Record<string, unknown>} input
 */
export function saveConfig(input = {}) {
  if (!configFile) throw new Error('SMS configuration is not initialized');

  const current = getConfig();
  const provider = String(input.provider ?? current.provider ?? 'fast2sms').toLowerCase();
  if (!PROVIDERS[provider]) {
    throw new Error('Choose a provider: fast2sms or twilio.');
  }

  const countryCode = normalizeCountryCode(input.countryCode ?? current.countryCode);

  const apiKey =
    typeof input.apiKey === 'string' && input.apiKey.trim()
      ? input.apiKey.trim()
      : String(fileConfig.apiKey || '');
  const senderId =
    input.senderId === undefined ? String(fileConfig.senderId || '') : String(input.senderId).trim();
  const route = String(input.route ?? fileConfig.route ?? 'q').toLowerCase();
  const templateId =
    input.templateId === undefined
      ? String(fileConfig.templateId || '')
      : String(input.templateId).trim();

  const accountSid = String(input.accountSid ?? fileConfig.accountSid ?? '').trim();
  const authToken =
    typeof input.authToken === 'string' && input.authToken.trim()
      ? input.authToken.trim()
      : String(fileConfig.authToken || '');
  const from = String(input.from ?? fileConfig.from ?? '').trim();

  if (provider === 'fast2sms') {
    if (!apiKey) throw new Error('Fast2SMS API key is required.');
    if (!['q', 'v3', 'dlt'].includes(route)) {
      throw new Error('Fast2SMS route must be q, v3 or dlt.');
    }
    if (route === 'dlt' && !templateId) {
      throw new Error('DLT route requires a template ID.');
    }
    if (senderId && !/^[A-Za-z0-9]{3,11}$/.test(senderId)) {
      throw new Error('Sender ID must be 3–11 letters or digits (e.g. TXTIND).');
    }
  } else if (provider === 'textbelt') {
    if (!apiKey) throw new Error('TextBelt API key is required.');
  } else {
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
      throw new Error('Twilio Account SID must start with "AC" and be 34 characters.');
    }
    if (!authToken) throw new Error('Twilio Auth Token is required.');
    if (!/^\+\d{8,15}$/.test(from)) {
      throw new Error('Twilio From number must be in E.164 form, e.g. +14155550123.');
    }
  }

  const payload = {
    provider,
    countryCode,
    apiKey: provider === 'fast2sms' || provider === 'textbelt' ? apiKey : String(fileConfig.apiKey || ''),
    senderId,
    route,
    templateId,
    accountSid: provider === 'twilio' ? accountSid : String(fileConfig.accountSid || ''),
    authToken: provider === 'twilio' ? authToken : String(fileConfig.authToken || ''),
    from,
    updatedAt: new Date().toISOString(),
  };

  writeFileConfig(payload);
  fileConfig = payload;
  return getSafeConfig();
}

/** Remove settings saved from the UI (environment variables are untouched). */
export function clearConfig() {
  if (configFile) {
    try {
      fs.rmSync(configFile, { force: true });
    } catch (_) {
      /* best effort */
    }
  }
  fileConfig = {};
  return getSafeConfig();
}

async function postJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'Lead-Finder/1.0', ...(options.headers || {}) },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { raw: text };
    }
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

function providerError(message, extra = {}) {
  const err = new Error(message);
  Object.assign(err, extra);
  return err;
}

async function sendFast2Sms(cfg, to, text) {
  // Fast2SMS expects the Indian number without the country code.
  let number = to;
  if (cfg.countryCode === '91' && number.length === 12 && number.startsWith('91')) {
    number = number.slice(2);
  }

  const payload = {
    route: cfg.route || 'q',
    message: text,
    language: 'english',
    flash: 0,
    numbers: number,
  };
  if (cfg.senderId) payload.sender_id = cfg.senderId;
  if (cfg.route === 'dlt' && cfg.templateId) payload.template_id = cfg.templateId;

  const { res, data } = await postJson('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: cfg.apiKey,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok || !data || data.return === false) {
    const raw = Array.isArray(data?.message)
      ? data.message.join(' ')
      : data?.message || data?.raw || `HTTP ${res.status}`;
    throw providerError(String(raw).slice(0, 300), { status: res.status });
  }

  const first = Array.isArray(data.message) ? data.message[0] : '';
  return { messageId: String(data.request_id || first || ''), provider: 'fast2sms' };
}

async function sendTextBelt(cfg, to, text) {
  const { res, data } = await postJson('https://textbelt.com/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ phone: to, message: text, key: cfg.apiKey }),
  });

  const ok = res.ok && (data?.status === undefined || data?.status === 200);
  if (!ok) {
    const raw = String(data?.error ?? data?.message ?? `HTTP ${res.status}`).slice(0, 300);
    throw providerError(raw, { status: res.status });
  }

  return { messageId: String(data?.data?.id ?? ''), provider: 'textbelt' };
}

async function sendTwilio(cfg, to, text) {
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  const body = new URLSearchParams({
    To: toE164(to),
    From: cfg.from,
    Body: text,
  });

  const { res, data } = await postJson(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );

  if (!res.ok) {
    throw providerError(String(data?.message || `HTTP ${res.status}`).slice(0, 300), {
      status: res.status,
      code: data?.code,
    });
  }

  return { messageId: String(data?.sid || ''), provider: 'twilio' };
}

/**
 * Send one SMS.
 * @param {{ to: string, text: string }} options
 */
export async function sendSms({ to, text }) {
  const cfg = assertConfigured();
  const body = String(text || '').trim();
  if (body.length < 2) throw new Error('Message is too short.');
  if (body.length > 1000) throw new Error('Message is too long (max 1000 characters).');

  const phone = normalizePhone(to, cfg.countryCode);
  if (!phone || phone.length < 10 || phone.length > 15) {
    throw new Error('Invalid phone number.');
  }

  if (cfg.provider === 'twilio') return sendTwilio(cfg, phone, body);
  if (cfg.provider === 'textbelt') return sendTextBelt(cfg, phone, body);
  return sendFast2Sms(cfg, phone, body);
}

/**
 * Replace {name}, {business}, {city}, {state}, {phone} in a template.
 */
export function renderTemplate(template, row = {}) {
  const values = {
    name: row.name || row.business_name || 'there',
    business: row.business_name || row.name || 'your business',
    city: row.city || '',
    state: row.state || '',
    phone: row.phone || '',
  };

  return String(template || '').replace(
    /\{(name|business|city|state|phone)\}/gi,
    (match, key) => values[key.toLowerCase()] ?? match
  );
}

/**
 * Turn provider/socket errors into actionable messages.
 */
export function friendlyError(err) {
  const status = Number(err?.status || 0);
  const code = String(err?.code || '');
  const message = String((err?.message || '') || 'Unknown error');
  const cause = String(err?.cause?.code || '');
  const text = `${status} ${code} ${cause} ${message}`;

  if (/401|403|unauthor|invalid.*(api|auth|token|key)|authentication/i.test(text)) {
    return 'SMS login failed. Check the API key / auth token for the selected provider.';
  }
  if (/dlt|template|sender.?id|entity/i.test(text) && /dlt|template|sender|entity/i.test(message)) {
    return (
      'The provider rejected the sender/template. In India, promotional SMS needs DLT ' +
      'registration (entity, sender ID and template). Check the sender ID and template ID.'
    );
  }
  if (/429|too many|rate.?limit/i.test(text)) {
    return 'The SMS provider rate-limited the request. Lower the daily cap or increase the delay.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|aborted|abort/i.test(text)) {
    return 'Could not reach the SMS provider. Check your internet connection and try again.';
  }
  return message;
}
