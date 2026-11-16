/**
 * KAIRO TOOL - Backend Server
 * Node.js / Express / PostgreSQL / Telegram Bot
 * Refactored: Security + Reliability Edition
 */

'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================
// CONFIG
// ============================================================
const BOT_TOKEN   = process.env.TELEGRAM_TOKEN || '';
const ADMIN_ID    = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const ADMIN_USER  = (process.env.ADMIN_USER || '').toLowerCase();

const BANK_CODE   = 'BIDV';
const BANK_ACC    = '96247V4IWI';
const BANK_HOLDER = 'TRAN NHAT HOANG';

const API_BANK = 'https://reimagined-spork-bu28.onrender.com/lich-su';
const PORT     = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL;

// SECRET_KEY: BẮT BUỘC trên production
const SECRET_KEY      = process.env.SECRET_KEY || crypto.randomBytes(32).toString('hex');
const SECRET_KEY_PREV = process.env.SECRET_KEY_PREV || ''; // hỗ trợ rotate
if (!process.env.SECRET_KEY) {
  console.warn('⚠️  SECRET_KEY chưa set env — token sẽ mất khi restart server!');
}

const TOKEN_ROTATE_MS       = 3_600_000;  // 1 giờ
const RATE_LIMIT_MAX        = 60;
const RATE_LIMIT_WINDOW_MS  = 60_000;
const API_TIMEOUT_MS        = 8_000;
const API_RETRY             = 1;
const CIRCUIT_FAIL_THRESH   = 5;
const CIRCUIT_OPEN_MS       = 30_000;

// ============================================================
// GAME API MAP
// ============================================================
const API_GAME_RAW = {
  md5:      'https://game-lon-5sks.onrender.com/json-predict/lc79/md5',
  hu:       'https://game-lon-5sks.onrender.com/json-predict/lc79/hu',
  luckywin: 'https://game-lon-5sks.onrender.com/json-predict/sicbo/luckywin',
  sumclub:  'https://game-lon-5sks.onrender.com/json-predict/sicbo/sumclub',
};

const PRICES = {
  '1d':   { price: 20_000,  days: 1,    label: '1 Ngày' },
  '4d':   { price: 30_000,  days: 4,    label: '4 Ngày' },
  '1w':   { price: 60_000,  days: 7,    label: '1 Tuần' },
  '1m':   { price: 120_000, days: 30,   label: '1 Tháng' },
  '3m':   { price: 150_000, days: 90,   label: '3 Tháng' },
  'life': { price: 220_000, days: null, label: 'Vĩnh Viễn' },
};

// ============================================================
// DATABASE
// ============================================================
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
    })
  : new (require('pg-mem').newDb().adapters.createPg().Pool)();

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        duration_days INTEGER,
        created_at DOUBLE PRECISION NOT NULL,
        activated_at DOUBLE PRECISION,
        expires_at DOUBLE PRECISION,
        is_active INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id BIGINT,
        username TEXT,
        full_name TEXT,
        plan TEXT,
        amount INTEGER,
        content TEXT,
        status TEXT DEFAULT 'pending',
        created_at DOUBLE PRECISION,
        paid_at DOUBLE PRECISION,
        key_issued TEXT
      );
    `);

    if (!DATABASE_URL && process.env.NODE_ENV !== 'production') {
      await pool.query(
        `INSERT INTO keys (key, plan, duration_days, created_at, is_active)
         VALUES ($1, $2, $3, $4, 0) ON CONFLICT (key) DO NOTHING`,
        ['HT-TEST-2026', 'life', null, Date.now() / 1000]
      );
      console.log('✅ Local In-Memory DB OK! Test key (dev only): HT-TEST-2026');
    } else {
      console.log('✅ Database OK!');
    }
  } catch (err) {
    console.error('❌ DB Error:', err.message);
  }
}
initDB();

// ============================================================
// PREDICT SICBO — Refactored
// ============================================================
function predictSicbo(history) {
  if (!Array.isArray(history) || history.length < 3) {
    return { du_doan: 'TÀI', tin_cay: 55 };
  }

  // Chuẩn hóa: mới nhất ở index 0 → đảo thành [cũ ... mới]
  const recent = history
    .slice(0, 15)
    .map(h => Number(h.resultType))
    .filter(v => v === 0 || v === 1)
    .reverse();

  if (recent.length < 3) return { du_doan: 'TÀI', tin_cay: 55 };

  const taiCount = recent.filter(v => v === 1).length;
  const xiuCount = recent.length - taiCount;

  // Đếm streak ở cuối (mới nhất)
  let streak = 1;
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i] === recent[i - 1]) streak++;
    else break;
  }
  const last = recent[recent.length - 1];

  let predict = '';
  let confidence = 0;

  if (streak >= 5) {
    // Cầu quá dài → theo cầu (không bẻ)
    predict = last === 1 ? 'TÀI' : 'XỈU';
    confidence = 65 + Math.min(streak * 2, 15); // max 80
  } else if (streak === 3 || streak === 4) {
    // Bẻ cầu 1-1
    predict = last === 1 ? 'XỈU' : 'TÀI';
    confidence = 60 + streak * 2;
  } else if (recent.length >= 4) {
    // Cầu 1-1 (alternating)
    const a = recent[recent.length - 1];
    const b = recent[recent.length - 2];
    const c = recent[recent.length - 3];
    const d = recent[recent.length - 4];
    if (a !== b && b !== c && c !== d) {
      predict = a === 1 ? 'XỈU' : 'TÀI';
      confidence = 65;
    }
    // Cầu 1-1-2
    else if (c === d && a === b && a !== c) {
      predict = a === 1 ? 'XỈU' : 'TÀI';
      confidence = 60;
    }
  }

  // Fallback: đa số + random tie-break
  if (!predict) {
    if (taiCount === xiuCount) {
      predict = crypto.randomInt(0, 2) === 1 ? 'TÀI' : 'XỈU';
      confidence = 50;
    } else {
      predict = taiCount > xiuCount ? 'TÀI' : 'XỈU';
      confidence = 50 + Math.abs(taiCount - xiuCount) * 2;
    }
  }

  confidence = Math.min(85, Math.max(50, Math.round(confidence)));
  return { du_doan: predict, tin_cay: confidence };
}

// ============================================================
// TOKEN ROTATION (HMAC-based, hỗ trợ SECRET_KEY_PREV)
// ============================================================
let TOKEN_MAP = {};
let TOKEN_MAP_PREV = {};
let CURRENT_BUCKET = -1;

const hourBucket = () => Math.floor(Date.now() / TOKEN_ROTATE_MS);

function signWith(game, bucket, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${game}:${bucket}`)
    .digest('base64url')
    .slice(0, 16);
}

function rebuildTokenMap() {
  const bucket = hourBucket();
  if (bucket === CURRENT_BUCKET) return;
  CURRENT_BUCKET = bucket;

  TOKEN_MAP = {};
  TOKEN_MAP_PREV = {};

  for (const game of Object.keys(API_GAME_RAW)) {
    TOKEN_MAP[signWith(game, bucket, SECRET_KEY)] = game;
    if (SECRET_KEY_PREV) {
      TOKEN_MAP[signWith(game, bucket, SECRET_KEY_PREV)] = game;
    }
    // Token của bucket trước (grace period)
    TOKEN_MAP_PREV[signWith(game, bucket - 1, SECRET_KEY)] = game;
    if (SECRET_KEY_PREV) {
      TOKEN_MAP_PREV[signWith(game, bucket - 1, SECRET_KEY_PREV)] = game;
    }
  }
}

function tokenToGame(token) {
  if (!token) return null;
  if (TOKEN_MAP[token]) return TOKEN_MAP[token];
  if (TOKEN_MAP_PREV[token]) return TOKEN_MAP_PREV[token];
  return null;
}

function gameToToken(game) {
  for (const [t, g] of Object.entries(TOKEN_MAP)) {
    if (g === game) return t;
  }
  return null;
}

rebuildTokenMap();

// ============================================================
// RATE LIMITER (với cleanup định kỳ)
// ============================================================
const RATE_BUCKETS = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    let rec = RATE_BUCKETS.get(ip);
    if (!rec || now > rec.reset) {
      rec = { count: 0, reset: now + windowMs };
      RATE_BUCKETS.set(ip, rec);
    }
    rec.count++;
    if (rec.count > max) {
      return res.status(429).json({ ok: false, error: 'Quá nhiều request, thử lại sau' });
    }
    next();
  };
}

// Dọn bucket quá hạn mỗi 5 phút (chống memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of RATE_BUCKETS.entries()) {
    if (now > rec.reset) RATE_BUCKETS.delete(ip);
  }
}, 5 * 60_000).unref();

// ============================================================
// CIRCUIT BREAKER cho API bên thứ 3
// ============================================================
const CIRCUIT = new Map(); // gameId -> { fails, openUntil }

function circuitOpen(gameId) {
  const c = CIRCUIT.get(gameId);
  return c && c.openUntil && Date.now() < c.openUntil;
}

function circuitSuccess(gameId) {
  CIRCUIT.set(gameId, { fails: 0, openUntil: 0 });
}

function circuitFail(gameId) {
  const c = CIRCUIT.get(gameId) || { fails: 0, openUntil: 0 };
  c.fails++;
  if (c.fails >= CIRCUIT_FAIL_THRESH) {
    c.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    c.fails = 0;
    console.warn(`⚡ Circuit OPEN cho ${gameId} trong ${CIRCUIT_OPEN_MS / 1000}s`);
  }
  CIRCUIT.set(gameId, c);
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/kho.html', (req, res) => res.sendFile(path.join(__dirname, 'kho.html')));

// Middleware xác thực key
async function requireValidKey(req, res, next) {
  try {
    let rawKey = req.headers['x-kairo-key'];
    if (!rawKey && req.headers.authorization?.startsWith('Bearer ')) {
      rawKey = req.headers.authorization.slice(7);
    }
    const key = String(rawKey || '').trim().toUpperCase();
    if (!key) return res.status(401).json({ ok: false, error: 'Thiếu key xác thực' });

    const result = await pool.query(
      'SELECT key, plan, duration_days, activated_at, expires_at, is_active FROM keys WHERE key = $1',
      [key]
    );
    const row = result.rows[0];
    if (!row || row.is_active !== 1) {
      return res.status(401).json({ ok: false, error: 'Key không hợp lệ hoặc chưa kích hoạt' });
    }
    const nowSec = Date.now() / 1000;
    if (row.expires_at != null && nowSec > row.expires_at) {
      return res.status(401).json({ ok: false, error: 'Key đã hết hạn' });
    }
    req.keyRow = row;
    next();
  } catch (e) {
    console.error('requireValidKey:', e.message);
    return res.status(500).json({ ok: false, error: 'Lỗi xác thực key' });
  }
}

// Runtime history cho sicbo
const RUNTIME_HISTORY = { md5: [], hu: [], luckywin: [], sumclub: [] };

// ============================================================
// API ROUTES
// ============================================================
app.get('/api/key/verify', rateLimit(), requireValidKey, (req, res) => {
  res.json({ ok: true, plan: req.keyRow.plan, expires_at: req.keyRow.expires_at });
});

app.get('/api/games', rateLimit(), requireValidKey, (req, res) => {
  rebuildTokenMap();
  const meta = {
    md5:      { name: 'LC79 MD5',        icon: 'fa-fingerprint', tagline: 'Phân tích mã băm',              badge: 'V3'  },
    hu:       { name: 'LC79 Hũ',         icon: 'fa-coins',       tagline: 'Dự đoán realtime',              badge: 'V3'  },
    luckywin: { name: 'Sicbo LuckyWin',  icon: 'fa-dice',        tagline: 'Thuật toán Sicbo độc quyền',    badge: 'PRO' },
    sumclub:  { name: 'Sicbo SumClub',   icon: 'fa-dice-d6',     tagline: 'Thuật toán Sicbo độc quyền',    badge: 'PRO' },
  };
  const games = [];
  for (const [k, m] of Object.entries(meta)) {
    const t = gameToToken(k);
    if (t) games.push({ id: k, token: t, ...m });
  }
  res.json({
    games,
    expires_in: Math.ceil((TOKEN_ROTATE_MS - (Date.now() % TOKEN_ROTATE_MS)) / 1000),
  });
});

// Helper: gọi API gốc có retry + timeout
async function fetchGameApi(gameId) {
  const url = API_GAME_RAW[gameId];
  let lastErr;
  for (let attempt = 0; attempt <= API_RETRY; attempt++) {
    try {
      const r = await axios.get(url, {
        timeout: API_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (KairoTool)' },
        validateStatus: s => s >= 200 && s < 500,
      });
      if (r.status >= 400) throw new Error(`API HTTP ${r.status}`);
      return r.data;
    } catch (e) {
      lastErr = e;
      if (attempt < API_RETRY) {
        await new Promise(rs => setTimeout(rs, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

app.get('/api/predict/:token', rateLimit(), requireValidKey, async (req, res) => {
  rebuildTokenMap();

  const gameId = tokenToGame(req.params.token);
  if (!gameId) {
    return res.status(403).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
  }

  if (circuitOpen(gameId)) {
    return res.status(503).json({
      error: 'Hệ thống tạm bảo trì, thử lại sau 30s',
      status: 'BẢO TRÌ',
      game: gameId,
    });
  }

  try {
    const raw = (await fetchGameApi(gameId)) || {};
    circuitSuccess(gameId);

    let data = {};

    if (gameId === 'md5' || gameId === 'hu') {
      const phien     = String(raw.phien_hien_tai || '');
      const du_doan   = String(raw.du_doan || '').toUpperCase();
      const tin_cay   = parseInt(raw.do_tin_cay, 10) || 50;

      const historyArr = [];
      if (Array.isArray(raw.lossHistory)) {
        for (const h of raw.lossHistory) {
          historyArr.push({ phien: h.phien, du_doan: h.predicted, ket_qua: h.actual, danh_gia: 'LOSE' });
        }
      }
      if (Array.isArray(raw.winHistory)) {
        for (const h of raw.winHistory) {
          historyArr.push({ phien: h.phien, du_doan: h.predicted, ket_qua: h.actual, danh_gia: 'WIN' });
        }
      }
      historyArr.sort((a, b) => parseInt(b.phien, 10) - parseInt(a.phien, 10));
      historyArr.unshift({ phien, du_doan, ket_qua: null, danh_gia: null });

      data = { phien, du_doan, tin_cay, status: 'LIVE', history: historyArr.slice(0, 20) };
    } else {
      const history = Array.isArray(raw) ? raw : (raw.data || []);
      if (!Array.isArray(history) || history.length === 0) {
        throw new Error('API trả dữ liệu rỗng');
      }
      const phien = String(history[0].gameNum ?? '');
      const pred  = predictSicbo(history);

      data = { phien, du_doan: pred.du_doan, tin_cay: pred.tin_cay, status: 'LIVE' };

      const historyArr = RUNTIME_HISTORY[gameId];
      const lastRecord = historyArr[0];
      if (lastRecord && lastRecord.phien !== phien && lastRecord.ket_qua === null) {
        lastRecord.ket_qua = Number(history[0].resultType) === 1 ? 'TÀI' : 'XỈU';
        lastRecord.danh_gia = lastRecord.du_doan === lastRecord.ket_qua ? 'WIN' : 'LOSE';
      }
      if (!lastRecord || lastRecord.phien !== phien) {
        historyArr.unshift({ phien, du_doan: pred.du_doan, ket_qua: null, danh_gia: null });
        if (historyArr.length > 20) historyArr.pop();
      }
      data.history = historyArr;
    }

    return res.json(data);
  } catch (e) {
    circuitFail(gameId);
    console.error(`[predict ${gameId}]`, e.message);

    // KHÔNG ghi kết quả giả vào history — chỉ trả trạng thái bảo trì
    return res.json({
      phien: '',
      du_doan: '',
      tin_cay: 0,
      status: 'BẢO TRÌ',
      message: 'Server game đang bảo trì hoặc kết nối chậm, vui lòng thử lại sau.',
      history: RUNTIME_HISTORY[gameId] || [],
    });
  }
});

app.post('/api/key/activate', rateLimit(10, 60_000), async (req, res) => {
  try {
    const key = String(req.body?.key || '').trim().toUpperCase();
    if (!key) return res.status(400).json({ ok: false, error: 'Thiếu key' });

    const result = await pool.query(
      'SELECT plan, duration_days, activated_at, expires_at FROM keys WHERE key = $1',
      [key]
    );
    const row = result.rows[0];
    if (!row) return res.json({ ok: false, error: 'Key không tồn tại' });

    const nowSec = Date.now() / 1000;

    if (row.activated_at == null) {
      const finalExp = row.duration_days == null ? null : nowSec + row.duration_days * 86400;
      // Atomic update: chỉ set nếu activated_at vẫn null (chống race)
      const upd = await pool.query(
        `UPDATE keys SET activated_at = $1, expires_at = $2, is_active = 1
         WHERE key = $3 AND activated_at IS NULL`,
        [nowSec, finalExp, key]
      );
      if (upd.rowCount === 0) {
        return res.json({ ok: false, error: 'Key vừa được kích hoạt bởi phiên khác' });
      }
      return res.json({
        ok: true, first_time: true, plan: row.plan,
        expires_at: finalExp,
        expires_str: finalExp ? new Date(finalExp * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn',
      });
    }

    if (row.duration_days != null && row.expires_at && nowSec > row.expires_at) {
      return res.json({ ok: false, error: 'Key đã hết hạn' });
    }
    return res.json({ ok: true, first_time: false, plan: row.plan, expires_at: row.expires_at });
  } catch (e) {
    console.error('activate:', e.message);
    res.status(500).json({ ok: false, error: 'Lỗi server: ' + e.message });
  }
});

// ============================================================
// TELEGRAM BOT
// ============================================================
let bot = null;

if (!BOT_TOKEN) {
  console.warn('⚠️  TELEGRAM_TOKEN chưa cấu hình — Bot Telegram tắt.');
} else {
  try {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });
    bot = new TelegramBot(BOT_TOKEN, {
      polling: { autoStart: false, interval: 1000, params: { timeout: 10 } },
      request: { agent: httpsAgent },
    });

    bot.deleteWebHook()
      .then(() => {
        bot.startPolling();
        console.log('🤖 Bot Telegram đã khởi động (đã xóa webhook cũ).');
      })
      .catch(err => console.error('Lỗi xóa webhook:', err.message));

    bot.on('polling_error', err => console.error('⚠️ Bot polling:', err.message));
  } catch (err) {
    console.error('❌ Lỗi khởi động Bot:', err.message);
  }
}

// ---------- HELPERS ----------
const userState = {};

function genKey(plan) {
  const pref = { '1d': 'HT1D', '4d': 'HT4D', '1w': 'HT1W', '1m': 'HT1M', '3m': 'HT3M', 'life': 'HTLIFE' }[plan] || 'HTX';
  return `${pref}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function isAdmin(user) {
  if (!user) return false;
  if (ADMIN_ID !== null && user.id === ADMIN_ID) return true;
  if (ADMIN_USER && user.username && user.username.toLowerCase() === ADMIN_USER) return true;
  return false;
}

// Safe send helpers
function safeSend(chatId, text, opts) {
  return bot.sendMessage(chatId, text, opts).catch(e => console.error('sendMessage:', e.message));
}
function safeEdit(chatId, msgId, text, opts) {
  return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts })
    .catch(e => { if (!/message is not modified/i.test(e.message)) console.error('editMessage:', e.message); });
}
function safeEditCaption(chatId, msgId, caption, opts) {
  return bot.editMessageCaption(caption, { chat_id: chatId, message_id: msgId, ...opts })
    .catch(e => { if (!/message is not modified/i.test(e.message)) console.error('editCaption:', e.message); });
}
function safeDelete(chatId, msgId) {
  return bot.deleteMessage(chatId, msgId).catch(() => {});
}

// ---------- UI BUILDERS ----------
function mainMenuKeyboard(user) {
  const rows = [
    [{ text: '🛒 Mua Key', callback_data: 'buy_menu' }],
    [{ text: '🔑 Nhập Key', callback_data: 'enter_key' }],
  ];
  if (isAdmin(user)) rows.push([{ text: '👑 Admin Panel', callback_data: 'admin_panel' }]);
  return { inline_keyboard: rows };
}

async function showStart(chatId, user) {
  if (!bot) return;
  const text =
    `🦁 <b>KAIRO TOOL</b>\n` +
    `Chào <b>${user.first_name || 'bạn'}</b>!\n\n` +
    `💰 <b>BẢNG GIÁ KEY</b>\n` +
    `• 20k → 1 ngày\n• 30k → 4 ngày\n• 60k → 1 tuần\n` +
    `• 120k → 1 tháng\n• 150k → 3 tháng\n• 220k → Vĩnh viễn\n\n` +
    `👇 Chọn thao tác`;
  safeSend(chatId, text, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(user) });
}

// ---------- ADMIN: XEM & XÓA KEY ----------
async function showKeyList(chatId, msgId, page = 0) {
  const PAGE_SIZE = 8;
  const offset = page * PAGE_SIZE;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT key, plan, is_active, expires_at FROM keys
       ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset]
    ).catch(() => ({ rows: [] })),
    pool.query('SELECT COUNT(*) FROM keys').catch(() => ({ rows: [{ count: 0 }] })),
  ]);

  const total = Number(countRes.rows[0].count) || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = rowsRes.rows;

  if (rows.length === 0) {
    return safeEdit(chatId, msgId, '📭 Không có key nào.', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại', callback_data: 'admin_panel' }]] },
    });
  }

  const buttons = [];
  let listText = `📋 <b>DANH SÁCH KEY</b> (trang ${page + 1}/${totalPages})\n\n`;
  for (const r of rows) {
    const status = r.is_active === 1 ? '✅' : '⏳';
    const exp = r.expires_at ? new Date(r.expires_at * 1000).toLocaleDateString('vi-VN') : '∞';
    listText += `${status} <code>${r.key}</code> — ${r.plan} — hạn: ${exp}\n`;
    buttons.push([{ text: `🗑 Xóa ${r.key}`, callback_data: `delkey_confirm_${r.key}` }]);
  }

  const nav = [];
  if (page > 0) nav.push({ text: '⬅️', callback_data: `keylist_${page - 1}` });
  nav.push({ text: '🔙 Menu', callback_data: 'admin_panel' });
  if (page < totalPages - 1) nav.push({ text: '➡️', callback_data: `keylist_${page + 1}` });
  buttons.push(nav);

  safeEdit(chatId, msgId, listText, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function confirmDeleteKey(chatId, msgId, key) {
  safeEdit(chatId, msgId,
    `⚠️ <b>XÓA KEY?</b>\n\nKey: <code>${key}</code>\n\nHành động này <b>không thể hoàn tác</b>.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Xóa', callback_data: `delkey_do_${key}` }, { text: '❌ Hủy', callback_data: 'keylist_0' }],
        ],
      },
    });
}

async function doDeleteKey(chatId, msgId, key) {
  try {
    const r = await pool.query('DELETE FROM keys WHERE key = $1', [key]);
    if (r.rowCount === 0) {
      return safeEdit(chatId, msgId, `ℹ️ Key <code>${key}</code> không tồn tại.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại', callback_data: 'keylist_0' }]] },
      });
    }
    safeEdit(chatId, msgId, `✅ Đã xóa key <code>${key}</code>.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Danh sách', callback_data: 'keylist_0' }]] },
    });
  } catch (e) {
    console.error('doDeleteKey:', e.message);
    safeEdit(chatId, msgId, `❌ Lỗi khi xóa: ${e.message}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại', callback_data: 'keylist_0' }]] },
    });
  }
}

// ---------- BOT EVENTS ----------
if (bot) {
  bot.onText(/\/start/, msg => showStart(msg.chat.id, msg.from));

  bot.on('callback_query', async query => {
    try {
      const chatId = query.message.chat.id;
      const msgId  = query.message.message_id;
      const data   = query.data;
      const user   = query.from;
      const hasCaption = !!query.message.caption;

      // ------ START ------
      if (data === 'back_start') {
        safeDelete(chatId, msgId);
        await showStart(chatId, user);
      }

      // ------ BUY ------
      else if (data === 'buy_menu') {
        const rows = Object.entries(PRICES).map(([pid, cfg]) => [
          { text: `💎 ${cfg.label} — ${cfg.price.toLocaleString('vi-VN')}đ`, callback_data: `buy_${pid}` },
        ]);
        rows.push([{ text: '🔙 Quay lại', callback_data: 'back_start' }]);
        safeEdit(chatId, msgId, '🛒 <b>Chọn gói key:</b>', {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: rows },
        });
      }

      else if (data.startsWith('buy_')) {
        const plan = data.replace('buy_', '');
        const cfg  = PRICES[plan];
        if (!cfg) return;

        const orderId = crypto.randomBytes(4).toString('hex').toUpperCase();
        const content = `HT${orderId}`;

        await pool.query(
          `INSERT INTO orders (id, user_id, username, full_name, plan, amount, content, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orderId, user.id, user.username || '', user.first_name || '', plan, cfg.price, content, Date.now() / 1000]
        ).catch(() => {});

        const qrUrl = `https://vietqr.app/img?bank=${BANK_CODE}&acc=${BANK_ACC}&amount=${cfg.price}&addInfo=${content}&template=compact&showinfo=true&holder=${encodeURIComponent(BANK_HOLDER)}`;
        const text =
          `🧾 <b>ĐƠN #${orderId}</b>\n\n` +
          `📦 Gói: <b>${cfg.label}</b>\n` +
          `💵 Số tiền: <b>${cfg.price.toLocaleString('vi-VN')}đ</b>\n` +
          `🏦 Ngân hàng: <b>${BANK_CODE}</b>\n` +
          `👤 Chủ TK: <b>${BANK_HOLDER}</b>\n` +
          `💳 Số TK: <code>${BANK_ACC}</code>\n\n` +
          `📝 <b>NỘI DUNG CK (bắt buộc):</b>\n<code>${content}</code>\n\n` +
          `⚠️ Chuyển <b>đúng nội dung & đúng số tiền</b>.\nSau khi CK, nhấn nút bên dưới.`;
        const kb = {
          inline_keyboard: [
            [{ text: '✅ Tôi đã chuyển khoản', callback_data: `paid_${orderId}` }],
            [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }],
          ],
        };

        try {
          await bot.sendPhoto(chatId, qrUrl, { caption: text, parse_mode: 'HTML', reply_markup: kb });
          safeDelete(chatId, msgId);
        } catch {
          safeEdit(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: kb });
        }
      }

      // ------ PAYMENT CHECK ------
      else if (data.startsWith('paid_')) {
        const orderId = data.replace('paid_', '');
        const res = await pool.query(
          'SELECT plan, amount, content, status FROM orders WHERE id=$1',
          [orderId]
        ).catch(() => ({ rows: [] }));
        const order = res.rows[0];
        if (!order || order.status === 'paid') {
          return bot.answerCallbackQuery(query.id, { text: 'Đơn không tồn tại hoặc đã xử lý', show_alert: true }).catch(() => {});
        }

        const baseCaption = hasCaption ? query.message.caption.split('⏳')[0].trim() : '⏳ Đang kiểm tra giao dịch...';
        if (hasCaption) {
          safeEditCaption(chatId, msgId, baseCaption + '\n\n⏳ <b>Đang kiểm tra giao dịch...</b>', { parse_mode: 'HTML' });
        }

        let tx = null;
        for (let i = 0; i < 5; i++) {
          try {
            const r = await axios.get(API_BANK, { timeout: API_TIMEOUT_MS });
            const txs = Array.isArray(r.data) ? r.data : (r.data.data || r.data.transactions || []);
            tx = txs.find(t =>
              t.content && t.content.toUpperCase().includes(order.content.toUpperCase()) &&
              (t.amount || 0) >= order.amount
            );
            if (tx) break;
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 2000));
        }

        if (!tx) {
          const msg = baseCaption + '\n\n❌ <b>CHƯA CHUYỂN KHOẢN!</b>\nBot chưa thấy giao dịch khớp.';
          const kb = {
            inline_keyboard: [
              [{ text: '🔄 Kiểm tra lại', callback_data: `paid_${orderId}` }],
              [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }],
            ],
          };
          if (hasCaption) safeEditCaption(chatId, msgId, msg, { parse_mode: 'HTML', reply_markup: kb });
          else safeEdit(chatId, msgId, msg, { parse_mode: 'HTML', reply_markup: kb });
          return;
        }

        const key = genKey(order.plan);
        const cfg = PRICES[order.plan];
        await pool.query('UPDATE orders SET status=$1, paid_at=$2, key_issued=$3 WHERE id=$4',
          ['paid', Date.now() / 1000, key, orderId]).catch(() => {});
        await pool.query(
          'INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)',
          [key, order.plan, cfg.days, Date.now() / 1000]
        ).catch(() => {});

        const successText =
          `✅ <b>THANH TOÁN THÀNH CÔNG!</b>\n\n` +
          `🔑 <b>KEY CỦA BẠN:</b>\n<code>${key}</code>\n\n` +
          `📦 Gói: <b>${cfg.label}</b>\n\n` +
          `⚠️ Key chỉ kích hoạt được 1 lần.\nNhập lại <b>KHÔNG cộng thêm</b> thời gian.`;
        if (hasCaption) safeEditCaption(chatId, msgId, successText, { parse_mode: 'HTML' });
        else safeEdit(chatId, msgId, successText, { parse_mode: 'HTML' });

        if (ADMIN_ID) {
          safeSend(ADMIN_ID,
            `💰 <b>ĐƠN MỚI</b>\nUser: ${user.first_name} (@${user.username || 'no_username'})\n` +
            `Gói: ${cfg.label}\nKey: <code>${key}</code>`,
            { parse_mode: 'HTML' });
        }
      }

      // ------ ENTER KEY ------
      else if (data === 'enter_key') {
        userState[user.id] = 'WAITING_KEY';
        safeSend(chatId, '🔑 <b>Nhập key của bạn</b>\n\nGửi key vào chat để kích hoạt.', { parse_mode: 'HTML' });
      }

      // ------ ADMIN PANEL ------
      else if (data === 'admin_panel' && isAdmin(user)) {
        const [totalRes, activeRes, revRes] = await Promise.all([
          pool.query('SELECT COUNT(*) FROM keys').catch(() => ({ rows: [{ count: 0 }] })),
          pool.query('SELECT COUNT(*) FROM keys WHERE is_active=1').catch(() => ({ rows: [{ count: 0 }] })),
          pool.query("SELECT SUM(amount) FROM orders WHERE status='paid'").catch(() => ({ rows: [{ sum: 0 }] })),
        ]);
        const rev = Number(revRes.rows[0].sum) || 0;
        safeEdit(chatId, msgId,
          `👑 <b>ADMIN PANEL</b>\n\n` +
          `🔑 Tổng key: <b>${totalRes.rows[0].count}</b>\n` +
          `✅ Active: <b>${activeRes.rows[0].count}</b>\n` +
          `💰 Doanh thu: <b>${rev.toLocaleString('vi-VN')}đ</b>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎁 Tạo key tay', callback_data: 'admin_genkey' }],
                [{ text: '📋 Quản lý / Xóa Key', callback_data: 'keylist_0' }],
                [{ text: '🔙 Quay lại', callback_data: 'back_start' }],
              ],
            },
          });
      }

      // ------ ADMIN: KEY LIST / DELETE ------
      else if (data.startsWith('keylist_') && isAdmin(user)) {
        const page = parseInt(data.replace('keylist_', ''), 10) || 0;
        await showKeyList(chatId, msgId, page);
      }

      else if (data.startsWith('delkey_confirm_') && isAdmin(user)) {
        const key = data.replace('delkey_confirm_', '');
        await confirmDeleteKey(chatId, msgId, key);
      }

      else if (data.startsWith('delkey_do_') && isAdmin(user)) {
        const key = data.replace('delkey_do_', '');
        await doDeleteKey(chatId, msgId, key);
      }

      // ------ ADMIN: GENERATE KEY ------
      else if (data === 'admin_genkey' && isAdmin(user)) {
        const rows = Object.entries(PRICES).map(([pid, cfg]) => [
          { text: cfg.label, callback_data: `genkey_${pid}` },
        ]);
        rows.push([{ text: '🔙 Quay lại', callback_data: 'admin_panel' }]);
        safeEdit(chatId, msgId, '🎁 <b>Chọn gói để tạo key:</b>', {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: rows },
        });
      }

      else if (data.startsWith('genkey_') && isAdmin(user)) {
        const plan = data.replace('genkey_', '');
        const cfg = PRICES[plan];
        if (!cfg) return;
        const key = genKey(plan);
        await pool.query(
          'INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)',
          [key, plan, cfg.days, Date.now() / 1000]
        ).catch(() => {});
        safeEdit(chatId, msgId,
          `✅ <b>ĐÃ TẠO KEY</b>\n\nGói: ${cfg.label}\n🔑 <code>${key}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎁 Tạo thêm', callback_data: 'admin_genkey' }],
                [{ text: '🔙 Quay lại', callback_data: 'admin_panel' }],
              ],
            },
          });
      }

      bot.answerCallbackQuery(query.id).catch(() => {});
    } catch (e) {
      console.error('callback_query:', e.message);
      bot.answerCallbackQuery(query.id, { text: 'Có lỗi xảy ra' }).catch(() => {});
    }
  });

  // ------ TEXT MESSAGE HANDLER (nhập key) ------
  bot.on('message', async msg => {
    try {
      if (!msg.text || msg.text.startsWith('/')) return;
      const userId = msg.from?.id;
      const chatId = msg.chat.id;

      if (userState[userId] === 'WAITING_KEY') {
        delete userState[userId];
        const key = msg.text.trim().toUpperCase();
        const res = await pool.query(
          'SELECT plan, duration_days, activated_at, expires_at FROM keys WHERE key=$1',
          [key]
        );
        const row = res.rows[0];
        if (!row) return safeSend(chatId, '❌ Key không tồn tại.');

        const cfg = PRICES[row.plan] || { label: row.plan };
        const nowSec = Date.now() / 1000;

        if (row.activated_at == null) {
          const exp = row.duration_days == null ? null : nowSec + row.duration_days * 86400;
          const upd = await pool.query(
            `UPDATE keys SET activated_at=$1, expires_at=$2, is_active=1
             WHERE key=$3 AND activated_at IS NULL`,
            [nowSec, exp, key]
          );
          if (upd.rowCount === 0) {
            return safeSend(chatId, '⚠️ Key vừa được kích hoạt bởi phiên khác, thử lại.');
          }
          const expStr = exp ? new Date(exp * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn';
          return safeSend(chatId,
            `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n` +
            `🔑 Key: <code>${key}</code>\n` +
            `📦 Gói: <b>${cfg.label}</b>\n` +
            `⏰ Hạn dùng: <b>${expStr}</b>`,
            { parse_mode: 'HTML' });
        }

        if (row.duration_days != null && row.expires_at && nowSec > row.expires_at) {
          return safeSend(chatId,
            `❌ Key đã <b>hết hạn</b> từ ${new Date(row.expires_at * 1000).toLocaleString('vi-VN')}.`,
            { parse_mode: 'HTML' });
        }

        const expStr = row.expires_at
          ? new Date(row.expires_at * 1000).toLocaleString('vi-VN')
          : 'Vĩnh viễn';
        return safeSend(chatId,
          `ℹ️ Key này <b>đã được kích hoạt trước đó</b>.\n\n` +
          `🔑 Key: <code>${key}</code>\n` +
          `📦 Gói: <b>${cfg.label}</b>\n` +
          `⏰ Hạn: <b>${expStr}</b>`,
          { parse_mode: 'HTML' });
      }
    } catch (e) {
      console.error('message handler:', e.message);
      safeSend(msg.chat.id, 'Lỗi Server!');
    }
  });
}

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  try { bot?.stopPolling(); } catch {}
  pool.end().finally(() => process.exit(0));
});
