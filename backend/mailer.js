/* ------------------------------------------------------------------ */
/* mailer.js — SMTP transport for the Mail Sender.                     */
/*                                                                     */
/* Configuration can come from two places:                             */
/*   1. Environment variables (highest priority):                      */
/*      SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,       */
/*      MAIL_FROM, MAIL_REPLY_TO, MAIL_UNSUBSCRIBE_URL                 */
/*   2. A local JSON file saved from the UI (mode 0600, gitignored):   */
/*      backend/data/mail-config.json                                  */
/*                                                                     */
/* Works with Gmail/Workspace app passwords, Brevo, Resend, SendGrid,  */
/* Mailgun, Amazon SES SMTP, Zoho, or any standard SMTP relay.         */
/* ------------------------------------------------------------------ */

import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let cached = null; // { key, transporter }
let configFile = null; // absolute path to mail-config.json
let fileConfig = {}; // values saved from the UI

function env(name, fallback = '') {
  const value = process.env[name];
  return String(value === undefined || value === null ? fallback : value).trim();
}

/**
 * Pull the first email address out of a free-form string.
 * Accepts "you@example.com", "Name <you@example.com>",
 * "you@example.com, Name" and similar pasted values.
 */
function looseEmail(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^mailto:/i, '');
  if (!raw) return '';

  const angled = raw.match(/<\s*([^>]+?)\s*>/);
  const direct = normalizeEmail(angled ? angled[1] : raw);
  if (direct) return direct;

  const found = raw.match(/[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[A-Za-z]{2,}/);
  return found ? normalizeEmail(found[0]) : '';
}

/**
 * Canonical From value: keeps "Name <email>" when given, otherwise
 * falls back to the bare address.
 */
function normalizeFrom(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^mailto:/i, '');
  if (!raw) return '';

  const named = raw.match(/^(.+?)\s*<\s*([^>]+?)\s*>\s*$/);
  if (named) {
    const address = looseEmail(named[2]);
    if (!address) return '';
    const name = named[1].replace(/^["']|["']$/g, '').trim();
    return name ? `${name} <${address}>` : address;
  }
  return looseEmail(raw);
}

/** Backwards-compatible name used across the mailer. */
function extractAddress(value) {
  return looseEmail(value);
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
 * Point the mailer at a data directory (the same volume as the SQLite DB).
 * @param {string} dir
 */
export function configure(dir) {
  configFile = dir.toLowerCase().endsWith('.json')
    ? dir
    : path.join(dir, 'mail-config.json');
  loadFileConfig();
}

function pick(envName, fileKey) {
  const fromEnv = env(envName);
  if (fromEnv) return fromEnv;
  const value = fileConfig[fileKey];
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Effective SMTP configuration. Environment variables win over the file.
 * Never includes the password in API responses (see getSafeConfig).
 */
export function getConfig() {
  const host = pick('SMTP_HOST', 'host');
  const port = parseInt(pick('SMTP_PORT', 'port') || '587', 10) || 587;
  const secureValue = pick('SMTP_SECURE', 'secure');
  const secure =
    secureValue === true ||
    String(secureValue).toLowerCase() === 'true' ||
    port === 465;
  const user = pick('SMTP_USER', 'user');
  const pass = pick('SMTP_PASS', 'pass');
  const from = normalizeFrom(pick('MAIL_FROM', 'from') || user);
  const replyTo = pick('MAIL_REPLY_TO', 'replyTo');
  const unsubscribeUrl = pick('MAIL_UNSUBSCRIBE_URL', 'unsubscribeUrl');

  const configured = !!(host && extractAddress(from) && (!user || pass));

  return { host, port, secure, user, pass, from, replyTo, unsubscribeUrl, configured };
}

/** Safe snapshot for the API/UI (no password). */
export function getSafeConfig() {
  const cfg = getConfig();
  const usingEnv = ['SMTP_HOST', 'SMTP_USER', 'MAIL_FROM'].some((key) => !!env(key));
  const usingFile = !usingEnv && !!(fileConfig.host || fileConfig.from);

  return {
    configured: cfg.configured,
    host: cfg.host || null,
    port: cfg.port,
    secure: cfg.secure,
    from: cfg.from || null,
    replyTo: cfg.replyTo || null,
    unsubscribeUrl: cfg.unsubscribeUrl || null,
    hasAuth: !!cfg.user,
    hasPassword: !!cfg.pass,
    source: usingEnv ? 'env' : usingFile ? 'file' : 'none',
    configFile: configFile || null,
  };
}

/** Throws a readable error when SMTP is not configured. */
export function assertConfigured() {
  const cfg = getConfig();
  if (!cfg.configured) {
    throw new Error(
      'Email is not configured. Open Mail Sender and save your SMTP settings first.'
    );
  }
  return cfg;
}

/**
 * Save SMTP settings from the UI. Blank password keeps the existing one.
 * @param {Record<string, unknown>} input
 */
export function saveConfig(input = {}) {
  if (!configFile) throw new Error('Mail configuration is not initialized');

  const current = getConfig();

  const host = String(input.host ?? current.host ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const port = Math.min(65535, Math.max(1, parseInt(input.port ?? current.port, 10) || 587));
  const secure =
    typeof input.secure === 'boolean' ? input.secure : current.secure || port === 465;
  const user =
    input.user === undefined
      ? current.user
      : String(input.user).trim() || current.user;
  const fromInput = input.from === undefined ? '' : String(input.from).trim();
  // Blank From is fine when the username is an email address.
  const from = normalizeFrom(fromInput || (looseEmail(user) ? user : ''));
  const replyTo =
    input.replyTo === undefined
      ? current.replyTo
      : normalizeFrom(String(input.replyTo).trim());
  const unsubscribeUrl =
    input.unsubscribeUrl === undefined
      ? current.unsubscribeUrl
      : String(input.unsubscribeUrl).trim();

  const typedPass = typeof input.pass === 'string' ? input.pass : '';
  const userUnchanged = !input.user || String(input.user).trim() === (fileConfig.user || '');
  const filePass = typedPass || (userUnchanged ? String(fileConfig.pass || '') : '');
  const effectivePass = env('SMTP_PASS') || filePass;

  if (!host) throw new Error('SMTP host is required (for example smtp.gmail.com).');
  if (!from) {
    const typed = String(fromInput || user || '').trim();
    throw new Error(
      `From address is not valid${typed ? ` ("${typed.slice(0, 80)}")` : ''}. ` +
        'Use a real email such as "you@gmail.com" or "Your Name <you@gmail.com>".'
    );
  }
  if (replyTo && !extractAddress(replyTo)) {
    throw new Error(
      'Reply-To is not a valid email. Use "you@gmail.com" or "Your Name <you@gmail.com>".'
    );
  }
  if (unsubscribeUrl && !/^https?:\/\//i.test(unsubscribeUrl)) {
    throw new Error('Unsubscribe URL must start with http:// or https://.');
  }
  if (user && !effectivePass) throw new Error('SMTP password (or app password) is required.');

  const payload = {
    host,
    port,
    secure: port === 465 ? true : secure,
    user,
    pass: filePass,
    from,
    replyTo,
    unsubscribeUrl,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(configFile, 0o600);
  } catch (_) {
    /* Windows may ignore POSIX modes */
  }

  fileConfig = payload;
  reset();
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
  reset();
  return getSafeConfig();
}

function getTransporter() {
  const cfg = assertConfigured();
  const key = [cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass].join('|');

  if (cached && cached.key === key) return cached.transporter;

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure && cfg.port === 587,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });

  cached = { key, transporter };
  return transporter;
}

/** Verify the SMTP login without sending a message. */
export async function verify() {
  return getTransporter().verify();
}

/**
 * Validate and normalize an email address.
 * @param {string} email
 * @returns {string} lower-cased address, or '' when invalid
 */
export function normalizeEmail(email) {
  const value = String(email || '')
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^<|>$/g, '')
    .toLowerCase();
  return EMAIL_RE.test(value) ? value : '';
}

export function isValidEmail(email) {
  return !!normalizeEmail(email);
}

/**
 * Replace template placeholders with row values.
 * Supports {name}, {business}, {city}, {state}, {email}.
 */
export function renderTemplate(template, row = {}) {
  const values = {
    name: row.name || row.business_name || 'there',
    business: row.business_name || row.name || 'your business',
    city: row.city || '',
    state: row.state || '',
    email: row.email || '',
  };

  return String(template || '').replace(
    /\{(name|business|city|state|email)\}/gi,
    (match, key) => values[key.toLowerCase()] ?? match
  );
}

function withUnsubscribeFooter(text, unsubscribeUrl) {
  const body = String(text || '').trimEnd();
  if (/unsubscribe/i.test(body)) return body;

  const line = unsubscribeUrl
    ? `Don't want these emails? Unsubscribe here: ${unsubscribeUrl}`
    : 'Don\'t want these emails? Reply "UNSUBSCRIBE" and we\'ll remove you.';

  return `${body}\n\n---\n${line}`;
}

/**
 * Send one plain-text email.
 * @param {{ to: string, subject: string, text: string }} options
 * @returns {Promise<{ messageId: string, accepted: string[], rejected: string[] }>}
 */
export async function sendMail({ to, subject, text }) {
  const cfg = assertConfigured();
  const recipient = normalizeEmail(to);
  if (!recipient) throw new Error('Invalid email address');

  const unsubscribeUrl = cfg.unsubscribeUrl || '';
  const headers = unsubscribeUrl
    ? {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined;

  const info = await getTransporter().sendMail({
    from: cfg.from,
    to: recipient,
    replyTo: cfg.replyTo || undefined,
    subject: String(subject || '').slice(0, 200) || 'Hello',
    text: withUnsubscribeFooter(text, unsubscribeUrl),
    headers,
  });

  return {
    messageId: info.messageId || '',
    accepted: (info.accepted || []).map(String),
    rejected: (info.rejected || []).map(String),
  };
}

/** Drop the cached transporter (used after a config change). */
export function reset() {
  cached = null;
}
