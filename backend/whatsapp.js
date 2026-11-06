/* ------------------------------------------------------------------ */
/* whatsapp.js — Baileys connection manager for the WhatsApp sender.   */
/*                                                                     */
/* This talks to WhatsApp Web through the unofficial Baileys library.  */
/* It owns exactly one socket, exposes a small state machine, and      */
/* persists the login credentials to disk so the QR scan is one-time.  */
/*                                                                     */
/* Public API:                                                         */
/*   configure(dir)         set the session directory                  */
/*   getState()             current connection snapshot                */
/*   isConnected()          true when a socket is open                 */
/*   connect(dir?)          open the socket / start the QR flow        */
/*   logout()               unlink the device and delete the session   */
/*   disconnect()           close the socket but keep the session      */
/*   sendText(phone, text)  send one text message                      */
/*   normalizePhone(phone)  -> 91XXXXXXXXXX                           */
/* ------------------------------------------------------------------ */

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {'disconnected'|'connecting'|'qr'|'connected'|'reconnecting'|'logged_out'|'error'} WaStatus */

const RECONNECT_DELAY_MS = 4000;
const QR_OPTIONS = { margin: 1, width: 320 };

/** @type {import('@whiskeysockets/baileys').WASocket | null} */
let sock = null;
/** @type {string | null} */
let sessionDir = null;
/** @type {NodeJS.Timeout | null} */
let reconnectTimer = null;
/** When true, a socket close is intentional and must not trigger reconnect. */
let manualClose = false;
/** Guards against two concurrent openSocket() calls. */
let opening = null;

let state = {
  /** @type {WaStatus} */
  status: 'disconnected',
  /** @type {string | null} data: URL of the current QR code */
  qr: null,
  /** @type {string | null} */
  phone: null,
  /** @type {string | null} */
  name: null,
  /** @type {string | null} */
  connectedAt: null,
  /** @type {string | null} */
  lastError: null,
  updatedAt: new Date().toISOString(),
};

function setState(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function destroySessionDir() {
  if (!sessionDir) return;
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* Configuration & state                                               */
/* ------------------------------------------------------------------ */

/**
 * Point the manager at the directory that stores the WhatsApp credentials.
 * Safe to call repeatedly.
 * @param {string} dir
 */
export function configure(dir) {
  sessionDir = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* best effort */
  }
}

/**
 * Snapshot of the connection, suitable for returning from an HTTP endpoint.
 */
export function getState() {
  return {
    ...state,
    sessionSaved: !!sessionDir && fs.existsSync(sessionDir),
    hasSocket: !!sock,
  };
}

export function isConnected() {
  return state.status === 'connected' && !!sock;
}

/**
 * Normalize an Indian phone number to the digits-only international form
 * used by WhatsApp JIDs (`91XXXXXXXXXX`).
 * @param {string} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = '91' + digits;

  return digits;
}

/* ------------------------------------------------------------------ */
/* Socket lifecycle                                                    */
/* ------------------------------------------------------------------ */

/**
 * Open a new Baileys socket and wire up its event handlers.
 * @returns {Promise<import('@whiskeysockets/baileys').WASocket>}
 */
async function openSocket() {
  if (!sessionDir) throw new Error('WhatsApp session directory is not configured');
  if (sock) return sock;

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (_) {
    version = undefined; // use the version bundled with Baileys
  }

  const socket = makeWASocket({
    version,
    auth: authState,
    browser: ['Lead Finder', 'Chrome', '125.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock = socket;
  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', (update) => handleConnectionUpdate(socket, update || {}));

  return socket;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} socket
 * @param {import('@whiskeysockets/baileys').ConnectionUpdate} update
 */
function handleConnectionUpdate(socket, update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    QRCode.toDataURL(qr, QR_OPTIONS)
      .then((dataUrl) => setState({ status: 'qr', qr: dataUrl, lastError: null }))
      .catch((err) => setState({ status: 'qr', qr: null, lastError: err.message }));
  }

  if (connection === 'open') {
    const id = socket.user?.id || '';
    setState({
      status: 'connected',
      qr: null,
      phone: id ? jidNormalizedUser(id).split('@')[0] : null,
      name: socket.user?.name || null,
      connectedAt: new Date().toISOString(),
      lastError: null,
    });
    return;
  }

  if (connection !== 'close') return;

  // Ignore events from a socket that has already been replaced.
  if (sock !== socket) return;
  sock = null;

  const statusCode = lastDisconnect?.error?.output?.statusCode;
  const message = lastDisconnect?.error?.message || 'connection closed';

  if (manualClose) {
    setState({ status: 'disconnected', qr: null, lastError: null });
    return;
  }

  if (statusCode === DisconnectReason.loggedOut) {
    destroySessionDir();
    setState({
      status: 'logged_out',
      qr: null,
      phone: null,
      name: null,
      lastError: 'Logged out from WhatsApp. Connect again.',
    });
    return;
  }

  setState({ status: 'reconnecting', qr: null, lastError: message });
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket().catch((err) => setState({ status: 'error', lastError: err.message }));
  }, RECONNECT_DELAY_MS);
}

/**
 * Connect (or reuse) the WhatsApp socket. Returns immediately with the
 * current state; the QR code arrives through the status endpoint.
 * @param {string} [dir]
 */
export async function connect(dir) {
  if (dir) configure(dir);

  if (sock && ['connected', 'qr', 'connecting', 'reconnecting'].includes(state.status)) {
    return getState();
  }

  manualClose = false;
  clearReconnectTimer();
  setState({ status: 'connecting', qr: null, lastError: null });

  try {
    if (!opening) {
      opening = openSocket().finally(() => {
        opening = null;
      });
    }
    await opening;
  } catch (err) {
    setState({ status: 'error', qr: null, lastError: err.message });
  }

  return getState();
}

/**
 * Unlink the device: asks WhatsApp to revoke the session, then deletes the
 * local credentials so the next connect shows a fresh QR code.
 */
export async function logout() {
  manualClose = true;
  clearReconnectTimer();

  try {
    if (sock) await sock.logout();
  } catch (_) {
    /* already gone */
  }

  sock = null;
  destroySessionDir();
  setState({
    status: 'disconnected',
    qr: null,
    phone: null,
    name: null,
    connectedAt: null,
    lastError: null,
  });
  return getState();
}

/**
 * Close the socket without unlinking the device. The saved session is kept,
 * so a later connect() resumes without a QR scan.
 */
export async function disconnect() {
  manualClose = true;
  clearReconnectTimer();

  try {
    if (sock) await sock.end(undefined);
  } catch (_) {
    /* already gone */
  }

  sock = null;
  setState({ status: 'disconnected', qr: null, lastError: null });
  return getState();
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

/**
 * Send a plain text message. Throws a readable error when the socket is not
 * ready or the number is invalid / not on WhatsApp.
 * @param {string} phone
 * @param {string} text
 * @returns {Promise<{ id: string | null, jid: string }>}
 */
export async function sendText(phone, text) {
  if (!isConnected()) throw new Error('WhatsApp is not connected. Scan the QR code first.');

  const digits = normalizePhone(phone);
  if (!digits || digits.length < 10) throw new Error('Invalid phone number');

  const jid = `${digits}@s.whatsapp.net`;

  // Best-effort registration check. Some numbers cannot be looked up because
  // of privacy settings, so lookup failures are ignored and the send is tried.
  try {
    const check = await sock.onWhatsApp(digits);
    if (Array.isArray(check) && check.length > 0 && check[0].exists === false) {
      throw new Error('Number is not on WhatsApp');
    }
  } catch (err) {
    if (/not on WhatsApp/i.test(err.message)) throw err;
  }

  const sent = await sock.sendMessage(jid, { text });
  return { id: sent?.key?.id || null, jid };
}

/* ------------------------------------------------------------------ */
/* Convenience                                                         */
/* ------------------------------------------------------------------ */

/** Absolute path of the session directory, or null when not configured. */
export function sessionPath() {
  return sessionDir ? path.resolve(sessionDir) : null;
}

/** Configure the manager and return the resolved session directory. */
export function ensureSessionDir(dir) {
  configure(dir);
  return path.resolve(dir);
}
