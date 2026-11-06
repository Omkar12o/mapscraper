/* ------------------------------------------------------------------ */
/* mailer.js — SMTP transport for the Mail Sender.                     */
/*                                                                     */
/* Credentials come from environment variables only, never the DB:     */
/*   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS           */
/*   MAIL_FROM, MAIL_REPLY_TO, MAIL_UNSUBSCRIBE_URL                    */
/*                                                                     */
/* Works with Gmail/Workspace app passwords, Brevo, Resend, SendGrid,  */
/* Mailgun, Amazon SES SMTP, Zoho, or any standard SMTP relay.         */
/* ------------------------------------------------------------------ */

import nodemailer from 'nodemailer';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let cached = null; // { key, transporter }

function env(name, fallback = '') {
  const value = process.env[name];
  return String(value === undefined || value === null ? fallback : value).trim();
}

/**
 * Current SMTP configuration. Never includes the password.
 */
export function getConfig() {
  const host = env('SMTP_HOST');
  const port = parseInt(env('SMTP_PORT', '587'), 10) || 587;
  const secure = env('SMTP_SECURE', '').toLowerCase() === 'true' || port === 465;
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASS');
  const from = env('MAIL_FROM') || (user ? user : '');
  const replyTo = env('MAIL_REPLY_TO');
  const unsubscribeUrl = env('MAIL_UNSUBSCRIBE_URL');

  const configured = !!(host && from && (!user || pass));

  return { host, port, secure, user, pass, from, replyTo, unsubscribeUrl, configured };
}

/** Safe snapshot for the API/UI (no password). */
export function getSafeConfig() {
  const cfg = getConfig();
  return {
    configured: cfg.configured,
    host: cfg.host || null,
    port: cfg.port,
    secure: cfg.secure,
    from: cfg.from || null,
    replyTo: cfg.replyTo || null,
    unsubscribeUrl: cfg.unsubscribeUrl || null,
    hasAuth: !!cfg.user,
  };
}

/** Throws a readable error when SMTP is not configured. */
export function assertConfigured() {
  const cfg = getConfig();
  if (!cfg.configured) {
    throw new Error(
      'Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM in backend/.env.'
    );
  }
  return cfg;
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
