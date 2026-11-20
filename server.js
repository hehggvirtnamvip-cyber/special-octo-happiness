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
const BOT_TOKEN   = process.env.TELEGRAM_TOKEN || '9027713238:AAEic04yZItSl5UhnNnXGDz_0kAnlreElVA';
const ADMIN_ID    = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : 7757046138;
const ADMIN_USER  = (process.env.ADMIN_USER || 'tranhoang2286').toLowerCase();
const NOTIFY_CHANNEL_ID = process.env.NOTIFY_CHANNEL_ID || '';

const BANK_CODE   = 'BIDV';
const BANK_ACC    = '96247V4IWI';
const BANK_HOLDER = 'TRAN NHAT HOANG';

const API_BANK = 'https://reimagined-spork-bu28.onrender.com/lich-su';
const PORT     = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL;

// Cờ xóa database (Set RESET_DATABASE=true trên Render để xóa sạch 1 lần)
const RESET_DATABASE = process.env.RESET_DATABASE === 'true';

const SECRET_KEY      = process.env.SECRET_KEY || crypto.randomBytes(32).toString('hex');
const SECRET_KEY_PREV = process.env.SECRET_KEY_PREV || '';

const TOKEN_ROTATE_MS       = 3_600_000;
const RATE_LIMIT_MAX        = 60;
const RATE_LIMIT_WINDOW_MS  = 60_000;
const API_TIMEOUT_MS        = 8_000;
const API_RETRY             = 1;
const CIRCUIT_FAIL_THRESH   = 5;
const CIRCUIT_OPEN_MS       = 30_000;

// ── FIX #14: Brute-force protection cho /api/key/activate
const ACTIVATE_FAIL_MAX     = 20;
const ACTIVATE_LOCK_MS      = 15 * 60_000;
const ACTIVATE_FAILS        = new Map(); // ip -> {count, lockUntil}

// ── FIX #5: Cache predict 3s/game để giảm spam API bên thứ 3
const PREDICT_CACHE_MS      = 3_000;
const PREDICT_CACHE         = new Map(); // gameId -> {data, at}

// ============================================================
// GAME API MAP & PRICES
// ============================================================
const API_GAME_RAW = {
  md5:         'https://game-lon-5sks.onrender.com/json-predict/lc79/md5',
  hu:          'https://game-lon-5sks.onrender.com/json-predict/lc79/hu',
  betvip_hu:   'https://game-lon-5sks.onrender.com/json-predict/betvip/hu',
  betvip_md5:  'https://game-lon-5sks.onrender.com/json-predict/betvip/md5',
  b52_hu:      'https://game-lon-5sks.onrender.com/json-predict/b52/hu',
  b52_md5:     'https://game-lon-5sks.onrender.com/json-predict/b52/md5',
  hitclub_hu:  'https://game-lon-5sks.onrender.com/json-predict/hitclub/hu',
  hitclub_md5: 'https://game-lon-5sks.onrender.com/json-predict/hitclub/md5',
  luckywin:    'https://game-lon-5sks.onrender.com/json-predict/sicbo/luckywin',
  sumclub:     'https://game-lon-5sks.onrender.com/json-predict/sicbo/sumclub',
};

const GAME_TYPE = {
  md5: 'md5hu', hu: 'md5hu', betvip_hu: 'md5hu', betvip_md5: 'md5hu',
  b52_hu: 'md5hu', b52_md5: 'md5hu', hitclub_hu: 'md5hu', hitclub_md5: 'md5hu',
  luckywin: 'sicbo', sumclub: 'sicbo',
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
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 10 })
  : new (require('pg-mem').newDb().adapters.createPg().Pool)();

async function initDB() {
  try {
    if (RESET_DATABASE) {
      console.log('⚠️ RESET_DATABASE=true — Đang xóa toàn bộ dữ liệu cũ...');
      await pool.query('DROP TABLE IF EXISTS keys');
      await pool.query('DROP TABLE IF EXISTS orders');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        duration_days INTEGER,
        created_at DOUBLE PRECISION NOT NULL,
        activated_at DOUBLE PRECISION,
        expires_at DOUBLE PRECISION,
        is_active INTEGER DEFAULT 0,
        device_id TEXT
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id BIGINT, username TEXT, full_name TEXT, plan TEXT,
        amount INTEGER, content TEXT, status TEXT DEFAULT 'pending',
        created_at DOUBLE PRECISION, paid_at DOUBLE PRECISION, key_issued TEXT
      );
    `);
    await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS device_id TEXT`).catch(() => {});
    console.log('✅ Database Ready!');
  } catch (err) {
    console.error('❌ DB Error:', err.message);
    // FIX #10: ném lỗi để chặn app.listen nếu DB không init được
    throw err;
  }
}
// FIX #10: bỏ initDB() gọi rời — chuyển xuống cuối file, chờ xong mới listen
// initDB();

// ============================================================
// UTILS & TOKENS
// ============================================================
// ── FIX #3: predictSicbo deterministic theo gameNum (không dùng randomInt)
function predictSicbo(history, gameNum = '') {
  if (!Array.isArray(history) || history.length < 3) return { du_doan: 'TÀI', tin_cay: 55 };
  const recent = history.slice(0, 15).map(h => Number(h.resultType)).filter(v => v === 0 || v === 1).reverse();
  if (recent.length < 3) return { du_doan: 'TÀI', tin_cay: 55 };
  const taiCount = recent.filter(v => v === 1).length;
  const xiuCount = recent.length - taiCount;
  let streak = 1;
  for (let i = recent.length - 1; i > 0; i--) { if (recent[i] === recent[i - 1]) streak++; else break; }
  const last = recent[recent.length - 1];
  let predict = ''; let confidence = 0;
  if (streak >= 5) { predict = last === 1 ? 'TÀI' : 'XỈU'; confidence = 65 + Math.min(streak * 2, 15); }
  else if (streak === 3 || streak === 4) { predict = last === 1 ? 'XỈU' : 'TÀI'; confidence = 60 + streak * 2; }
  else if (recent.length >= 4) {
    const a = recent[recent.length - 1], b = recent[recent.length - 2], c = recent[recent.length - 3], d = recent[recent.length - 4];
    if (a !== b && b !== c && c !== d) { predict = a === 1 ? 'XỈU' : 'TÀI'; confidence = 65; }
    else if (c === d && a === b && a !== c) { predict = a === 1 ? 'XỈU' : 'TÀI'; confidence = 60; }
  }
  if (!predict) {
    if (taiCount === xiuCount) {
      // FIX #3: thay crypto.randomInt bằng hash deterministic theo gameNum
      const h = crypto.createHash('sha256').update(String(gameNum || recent.join(''))).digest();
      predict = (h[0] & 1) === 1 ? 'TÀI' : 'XỈU';
      confidence = 50;
    }
    else { predict = taiCount > xiuCount ? 'TÀI' : 'XỈU'; confidence = 50 + Math.abs(taiCount - xiuCount) * 2; }
  }
  return { du_doan: predict, tin_cay: Math.min(85, Math.max(50, Math.round(confidence))) };
}

let TOKEN_MAP = {}, TOKEN_MAP_PREV = {}, CURRENT_BUCKET = -1;
const hourBucket = () => Math.floor(Date.now() / TOKEN_ROTATE_MS);
function signWith(game, bucket, secret) { return crypto.createHmac('sha256', secret).update(`${game}:${bucket}`).digest('base64url').slice(0, 16); }
function rebuildTokenMap() {
  const bucket = hourBucket();
  if (bucket === CURRENT_BUCKET) return;
  CURRENT_BUCKET = bucket;
  TOKEN_MAP = {}; TOKEN_MAP_PREV = {};
  for (const game of Object.keys(API_GAME_RAW)) {
    TOKEN_MAP[signWith(game, bucket, SECRET_KEY)] = game;
    if (SECRET_KEY_PREV) TOKEN_MAP[signWith(game, bucket, SECRET_KEY_PREV)] = game;
    TOKEN_MAP_PREV[signWith(game, bucket - 1, SECRET_KEY)] = game;
    if (SECRET_KEY_PREV) TOKEN_MAP_PREV[signWith(game, bucket - 1, SECRET_KEY_PREV)] = game;
  }
}
function tokenToGame(token) { return TOKEN_MAP[token] || TOKEN_MAP_PREV[token] || null; }
function gameToToken(game) { for (const [t, g] of Object.entries(TOKEN_MAP)) { if (g === game) return t; } return null; }
rebuildTokenMap();

const RATE_BUCKETS = new Map();
// ── FIX #6: dùng req.ip (đã trust proxy), KHÔNG tin x-forwarded-for thô
function clientIp(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }
function rateLimit(max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  return (req, res, next) => {
    const ip = clientIp(req); const now = Date.now();
    let rec = RATE_BUCKETS.get(ip);
    if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; RATE_BUCKETS.set(ip, rec); }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ ok: false, error: 'Quá nhiều request' });
    next();
  };
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-kairo-key, x-device-id, Authorization');
  next();
});

app.get('/healthz', (_, res) => res.status(200).send('ok'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/kho.html', (req, res) => res.sendFile(path.join(__dirname, 'kho.html')));

// ============================================================
// DEVICE LOCK MIDDLEWARE
// ============================================================
async function requireValidKey(req, res, next) {
  try {
    let rawKey = req.headers['x-kairo-key'];
    if (!rawKey && req.headers.authorization?.startsWith('Bearer ')) rawKey = req.headers.authorization.slice(7);
    const key = String(rawKey || '').trim().toUpperCase();
    if (!key) return res.status(401).json({ ok: false, error: 'Thiếu key xác thực' });

    const deviceId = String(req.headers['x-device-id'] || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Lỗi: Không tìm thấy Device ID' });

    const result = await pool.query('SELECT * FROM keys WHERE key = $1', [key]);
    const row = result.rows[0];
    if (!row || row.is_active !== 1) return res.status(401).json({ ok: false, error: 'Key không hợp lệ hoặc chưa kích hoạt' });
    if (row.expires_at != null && (Date.now() / 1000) > row.expires_at) return res.status(401).json({ ok: false, error: 'Key đã hết hạn' });

    if (row.device_id == null) {
      await pool.query(`UPDATE keys SET device_id = $1 WHERE key = $2 AND device_id IS NULL`, [deviceId, key]);
      row.device_id = deviceId;
    } else if (row.device_id !== deviceId) {
      return res.status(403).json({ ok: false, error: 'Key đã được sử dụng trên thiết bị khác' });
    }

    req.keyRow = row;
    next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

app.get('/api/key/verify', rateLimit(), requireValidKey, (req, res) => {
  res.json({ ok: true, plan: req.keyRow.plan, expires_at: req.keyRow.expires_at });
});

app.get('/api/games', rateLimit(), requireValidKey, (req, res) => {
  rebuildTokenMap();
  const meta = {
    md5: { name: 'LC79 MD5', icon: 'fa-fingerprint' }, hu: { name: 'LC79 Hũ', icon: 'fa-coins' },
    betvip_hu: { name: 'BetVIP Hũ', icon: 'fa-coins' }, betvip_md5: { name: 'BetVIP MD5', icon: 'fa-fingerprint' },
    b52_hu: { name: 'B52 Hũ', icon: 'fa-coins' }, b52_md5: { name: 'B52 MD5', icon: 'fa-fingerprint' },
    hitclub_hu: { name: 'HitClub Hũ', icon: 'fa-coins' }, hitclub_md5: { name: 'HitClub MD5', icon: 'fa-fingerprint' },
    luckywin: { name: 'Sicbo LuckyWin', icon: 'fa-dice' }, sumclub: { name: 'Sicbo SumClub', icon: 'fa-dice-d6' },
  };
  const games = [];
  for (const [k, m] of Object.entries(meta)) {
    const t = gameToToken(k);
    if (t) games.push({ id: k, token: t, ...m });
  }
  // FIX #2: trả thêm rotate_at để client biết khi nào token hết hạn
  const rotateAt = (hourBucket() + 1) * TOKEN_ROTATE_MS;
  res.json({ games, rotate_at: rotateAt });
});

app.get('/api/predict/:token', rateLimit(), requireValidKey, async (req, res) => {
  rebuildTokenMap();
  const gameId = tokenToGame(req.params.token);
  if (!gameId) return res.status(403).json({ error: 'Token không hợp lệ' });

  // FIX #5: cache 3s/game
  const cached = PREDICT_CACHE.get(gameId);
  if (cached && Date.now() - cached.at < PREDICT_CACHE_MS) {
    return res.json(cached.data);
  }

  try {
    const r = await axios.get(API_GAME_RAW[gameId], { timeout: API_TIMEOUT_MS });
    const raw = r.data || {};
    const type = GAME_TYPE[gameId] || 'sicbo';
    let data = {};

    if (type === 'md5hu') {
      const phien = String(raw.phien_hien_tai || '');
      const du_doan = String(raw.du_doan || '').toUpperCase();
      const tin_cay = parseInt(raw.do_tin_cay, 10) || 50;
      const historyArr = [];
      if (Array.isArray(raw.lossHistory)) for (const h of raw.lossHistory) historyArr.push({ phien: h.phien, du_doan: h.predicted, ket_qua: h.actual, danh_gia: 'LOSE' });
      if (Array.isArray(raw.winHistory)) for (const h of raw.winHistory) historyArr.push({ phien: h.phien, du_doan: h.predicted, ket_qua: h.actual, danh_gia: 'WIN' });
      historyArr.sort((a, b) => parseInt(b.phien, 10) - parseInt(a.phien, 10));
      data = { phien, du_doan, tin_cay, history: historyArr.slice(0, 20) };
    } else {
      const history = Array.isArray(raw) ? raw : (raw.data || []);
      if (!history.length) throw new Error('Rỗng');
      // FIX #3: lấy phien để truyền vào predictSicbo
      const phien = String(history[0].gameNum || '');
      const pred = predictSicbo(history, phien);
      data = { phien, du_doan: pred.du_doan, tin_cay: pred.tin_cay, history };
    }
    PREDICT_CACHE.set(gameId, { data, at: Date.now() });
    res.json(data);
  } catch (e) {
    res.json({ du_doan: 'BẢO TRÌ', tin_cay: 0, history: [] });
  }
});

app.post('/api/key/activate', rateLimit(10, 60_000), async (req, res) => {
  try {
    const ip = clientIp(req);

    // FIX #14: lock IP sau nhiều lần fail
    const fail = ACTIVATE_FAILS.get(ip);
    if (fail && fail.lockUntil && Date.now() < fail.lockUntil) {
      return res.status(429).json({ ok: false, error: 'Quá nhiều lần thử sai. Vui lòng đợi 15 phút.' });
    }

    const key = String(req.body?.key || '').trim().toUpperCase();
    const deviceId = String(req.body?.device_id || req.headers['x-device-id'] || '').trim();
    
    if (!key) return res.status(400).json({ ok: false, error: 'Thiếu key' });
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Thiếu Device ID' });

    const result = await pool.query('SELECT * FROM keys WHERE key = $1', [key]);
    const row = result.rows[0];
    if (!row) {
      // FIX #14: tăng đếm fail
      const rec = ACTIVATE_FAILS.get(ip) || { count: 0, lockUntil: 0 };
      rec.count++;
      if (rec.count >= ACTIVATE_FAIL_MAX) rec.lockUntil = Date.now() + ACTIVATE_LOCK_MS;
      ACTIVATE_FAILS.set(ip, rec);
      return res.json({ ok: false, error: 'Key không tồn tại' });
    }

    const nowSec = Date.now() / 1000;

    if (row.activated_at == null) {
      const finalExp = row.duration_days == null ? null : nowSec + row.duration_days * 86400;
      const upd = await pool.query(
        `UPDATE keys SET activated_at = $1, expires_at = $2, is_active = 1, device_id = $3 WHERE key = $4`,
        [nowSec, finalExp, deviceId, key]
      );
      if (upd.rowCount === 0) return res.json({ ok: false, error: 'Key đang bị thao tác' });
      ACTIVATE_FAILS.delete(ip);
      return res.json({ ok: true, first_time: true, message: 'Kích hoạt thành công' });
    }

    if (row.device_id && row.device_id !== deviceId) {
      return res.status(403).json({ ok: false, error: 'Key này đã được kích hoạt trên thiết bị khác!' });
    }

    if (row.duration_days != null && row.expires_at && nowSec > row.expires_at) {
      return res.json({ ok: false, error: 'Key đã hết hạn' });
    }
    ACTIVATE_FAILS.delete(ip);
    return res.json({ ok: true, first_time: false, message: 'Kích hoạt thành công' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
});

// ============================================================
// TELEGRAM BOT FULL ADMIN PANEL
// ============================================================
let bot = null;
if (BOT_TOKEN) {
  const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });
  bot = new TelegramBot(BOT_TOKEN, {
    polling: { autoStart: false, interval: 1000, params: { timeout: 10 }, conflictRetryDelayMs: 3000 },
    request: { agent: httpsAgent },
  });

  bot.deleteWebHook().then(() => {
    bot.startPolling();
    console.log('🤖 Bot Telegram đã khởi động');
  }).catch(e => console.error('Bot error:', e.message));

  bot.on('polling_error', err => {
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
      console.warn('⚠️ Cảnh báo: Có 2 Bot đang chạy cùng lúc (409 Conflict). Hãy tắt Bot dưới máy đi!');
    }
  });
}

const userState = {};
function genKey(plan) {
  const pref = { '1d': 'HT1D', '4d': 'HT4D', '1w': 'HT1W', '1m': 'HT1M', '3m': 'HT3M', 'life': 'HTLIFE' }[plan] || 'HTX';
  // FIX #15: tăng entropy 8 bytes (16 hex ký tự) thay vì 4 bytes
  return `${pref}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}
function isAdmin(user) {
  if (!user) return false;
  if (ADMIN_ID !== null && user.id === ADMIN_ID) return true;
  if (ADMIN_USER && user.username && user.username.toLowerCase() === ADMIN_USER) return true;
  return false;
}

function safeSend(chatId, text, opts) { return bot.sendMessage(chatId, text, opts).catch(() => {}); }
function safeEdit(chatId, msgId, text, opts) { return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {}); }
function safeEditCaption(chatId, msgId, caption, opts) { return bot.editMessageCaption(caption, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {}); }
function safeDelete(chatId, msgId) { return bot.deleteMessage(chatId, msgId).catch(() => {}); }

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
  const text = `🦁 <b>KAIRO TOOL</b>\nChào <b>${user.first_name || 'bạn'}</b>!\n\n👇 Chọn thao tác`;
  safeSend(chatId, text, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(user) });
}

async function showKeyList(chatId, msgId, page = 0) {
  const PAGE_SIZE = 8;
  const offset = page * PAGE_SIZE;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(`SELECT key, plan, is_active, expires_at FROM keys ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [PAGE_SIZE, offset]).catch(() => ({ rows: [] })),
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
    buttons.push([
      { text: `♻️ Reset Máy`, callback_data: `resetkey_${r.key}` },
      { text: `🗑 Xóa`, callback_data: `delkey_confirm_${r.key}` }
    ]);
  }

  const nav = [];
  if (page > 0) nav.push({ text: '⬅️', callback_data: `keylist_${page - 1}` });
  nav.push({ text: '🔙 Menu', callback_data: 'admin_panel' });
  if (page < totalPages - 1) nav.push({ text: '➡️', callback_data: `keylist_${page + 1}` });
  buttons.push(nav);

  safeEdit(chatId, msgId, listText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

if (bot) {
  bot.onText(/\/start/, msg => showStart(msg.chat.id, msg.from));

  bot.on('callback_query', async query => {
    let answered = false;
    const answer = (text, alert = false) => { if (!answered) { answered = true; bot.answerCallbackQuery(query.id, { text, show_alert: alert }).catch(() => {}); } };

    try {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;
      const user = query.from;
      const hasCaption = !!query.message.caption;

      if (data === 'back_start') {
        safeDelete(chatId, msgId);
        await showStart(chatId, user);
      }
      else if (data === 'buy_menu') {
        const rows = Object.entries(PRICES).map(([pid, cfg]) => [{ text: `💎 ${cfg.label} — ${cfg.price.toLocaleString('vi-VN')}đ`, callback_data: `buy_${pid}` }]);
        rows.push([{ text: '🔙 Quay lại', callback_data: 'back_start' }]);
        safeEdit(chatId, msgId, '🛒 <b>Chọn gói key:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
      }
      else if (data.startsWith('buy_')) {
        const plan = data.replace('buy_', '');
        const cfg = PRICES[plan];
        if (!cfg) return answer('Gói không tồn tại', true);

        const orderId = crypto.randomBytes(4).toString('hex').toUpperCase();
        const content = `HT${orderId}`;

        await pool.query(
          `INSERT INTO orders (id, user_id, username, full_name, plan, amount, content, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orderId, user.id, user.username || '', user.first_name || '', plan, cfg.price, content, Date.now() / 1000]
        ).catch(() => {});

        const qrUrl = `https://vietqr.app/img?bank=${BANK_CODE}&acc=${BANK_ACC}&amount=${cfg.price}&addInfo=${content}&template=compact&showinfo=true&holder=${encodeURIComponent(BANK_HOLDER)}`;
        const text = `🧾 <b>ĐƠN #${orderId}</b>\n\n📦 Gói: <b>${cfg.label}</b>\n💵 Số tiền: <b>${cfg.price.toLocaleString('vi-VN')}đ</b>\n🏦 Ngân hàng: <b>${BANK_CODE}</b>\n👤 Chủ TK: <b>${BANK_HOLDER}</b>\n💳 Số TK: <code>${BANK_ACC}</code>\n\n📝 <b>NỘI DUNG CK (bắt buộc):</b>\n<code>${content}</code>\n\n⚠️ Chuyển <b>đúng nội dung & đúng số tiền</b>.`;
        const kb = { inline_keyboard: [[{ text: '✅ Tôi đã chuyển khoản', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] };

        try { await bot.sendPhoto(chatId, qrUrl, { caption: text, parse_mode: 'HTML', reply_markup: kb }); safeDelete(chatId, msgId); }
        catch { safeEdit(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: kb }); }
      }
      else if (data.startsWith('paid_')) {
        const orderId = data.replace('paid_', '');
        // FIX #7: kiểm tra order thuộc về user hiện tại (chống claim trộm order)
        const claim = await pool.query(
          `UPDATE orders SET status='processing' WHERE id=$1 AND status='pending' AND user_id=$2 RETURNING plan, amount, content`,
          [orderId, user.id]
        ).catch(() => ({ rowCount: 0, rows: [] }));
        if (claim.rowCount === 0) return answer('Đơn không tồn tại hoặc đã xử lý', true);

        const order = claim.rows[0];
        const baseCaption = hasCaption ? (query.message.caption || '').split('⏳')[0].trim() : '';
        if (hasCaption && baseCaption) safeEditCaption(chatId, msgId, baseCaption + '\n\n⏳ <b>Đang kiểm tra...</b>', { parse_mode: 'HTML' });

        let tx = null;
        for (let i = 0; i < 3; i++) {
          try {
            const r = await axios.get(API_BANK, { timeout: 6000 });
            const txs = Array.isArray(r.data) ? r.data : (r.data.data || r.data.transactions || []);
            tx = txs.find(t => t.content && t.content.toUpperCase().includes(order.content.toUpperCase()) && (t.amount || 0) >= order.amount);
            if (tx) break;
          } catch { }
          await new Promise(r => setTimeout(r, 1500));
        }

        if (!tx) {
          await pool.query(`UPDATE orders SET status='pending' WHERE id=$1 AND status='processing'`, [orderId]).catch(() => {});
          const msg = (baseCaption || '🧾 Đơn hàng') + '\n\n❌ <b>CHƯA CHUYỂN KHOẢN!</b>';
          const kb = { inline_keyboard: [[{ text: '🔄 Kiểm tra lại', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] };
          if (hasCaption) safeEditCaption(chatId, msgId, msg, { parse_mode: 'HTML', reply_markup: kb });
          else safeEdit(chatId, msgId, msg, { parse_mode: 'HTML', reply_markup: kb });
          return answer('Chưa thấy giao dịch');
        }

        const key = genKey(order.plan);
        const cfg = PRICES[order.plan];

        // FIX #1: nếu INSERT key fail → rollback order về pending để user thử lại
        try {
          await pool.query('UPDATE orders SET status=$1, paid_at=$2, key_issued=$3 WHERE id=$4', ['paid', Date.now() / 1000, key, orderId]);
          await pool.query('INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)', [key, order.plan, cfg.days, Date.now() / 1000]);
        } catch (e) {
          await pool.query('UPDATE orders SET status=$1 WHERE id=$2', ['pending', orderId]).catch(() => {});
          return answer('Lỗi tạo key, vui lòng thử lại', true);
        }

        const successText = `✅ <b>THANH TOÁN THÀNH CÔNG!</b>\n\n🔑 <b>KEY CỦA BẠN:</b>\n<code>${key}</code>\n\n📦 Gói: <b>${cfg.label}</b>\n\n⚠️ Key chỉ kích hoạt được 1 lần.\n📱 Mỗi key chỉ dùng được trên <b>1 thiết bị duy nhất</b>.`;
        if (hasCaption) safeEditCaption(chatId, msgId, successText, { parse_mode: 'HTML' });
        else safeEdit(chatId, msgId, successText, { parse_mode: 'HTML' });

        safeSend(chatId, `🔑 <b>KEY CỦA BẠN ĐÂY:</b>\n<code>${key}</code>`, { parse_mode: 'HTML' });
        return answer('Thanh toán thành công!');
      }
      else if (data === 'enter_key') {
        userState[user.id] = 'WAITING_KEY';
        safeSend(chatId, '🔑 <b>Nhập key của bạn</b>\n\nGửi key vào chat để kích hoạt.', { parse_mode: 'HTML' });
      }
      else if (data === 'admin_panel' && isAdmin(user)) {
        const [totalRes, activeRes, revRes] = await Promise.all([
          pool.query('SELECT COUNT(*) FROM keys').catch(() => ({ rows: [{ count: 0 }] })),
          pool.query('SELECT COUNT(*) FROM keys WHERE is_active=1').catch(() => ({ rows: [{ count: 0 }] })),
          pool.query("SELECT SUM(amount) FROM orders WHERE status='paid'").catch(() => ({ rows: [{ sum: 0 }] })),
        ]);
        const rev = Number(revRes.rows[0].sum) || 0;
        safeEdit(chatId, msgId,
          `👑 <b>ADMIN PANEL</b>\n\n🔑 Tổng key: <b>${totalRes.rows[0].count}</b>\n✅ Active: <b>${activeRes.rows[0].count}</b>\n💰 Doanh thu: <b>${rev.toLocaleString('vi-VN')}đ</b>`,
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
      else if (data.startsWith('keylist_') && isAdmin(user)) {
        const page = parseInt(data.replace('keylist_', ''), 10) || 0;
        await showKeyList(chatId, msgId, page);
      }
      else if (data.startsWith('delkey_confirm_') && isAdmin(user)) {
        const key = data.replace('delkey_confirm_', '');
        safeEdit(chatId, msgId, `⚠️ <b>XÓA KEY?</b>\n\nKey: <code>${key}</code>\n\nHành động này <b>không thể hoàn tác</b>.`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '✅ Xóa', callback_data: `delkey_do_${key}` }, { text: '❌ Hủy', callback_data: 'keylist_0' }]] },
        });
      }
      else if (data.startsWith('delkey_do_') && isAdmin(user)) {
        const key = data.replace('delkey_do_', '');
        await pool.query('DELETE FROM keys WHERE key = $1', [key]).catch(() => {});
        safeEdit(chatId, msgId, `✅ Đã xóa key <code>${key}</code>.`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Danh sách', callback_data: 'keylist_0' }]] },
        });
      }
      else if (data.startsWith('resetkey_') && isAdmin(user)) {
        const key = data.replace('resetkey_', '');
        await pool.query('UPDATE keys SET device_id = NULL WHERE key = $1', [key]).catch(() => {});
        // FIX #4: ghi rõ chỉ reset thiết bị, không gia hạn
        safeEdit(chatId, msgId, `✅ Đã <b>Reset Thiết Bị</b> cho key <code>${key}</code>.\n\nKhách hàng có thể đăng nhập trên máy mới.\n⚠️ Lưu ý: chỉ reset thiết bị, <b>không gia hạn</b> thời gian sử dụng.`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Danh sách', callback_data: 'keylist_0' }]] },
        });
      }
      else if (data === 'admin_genkey' && isAdmin(user)) {
        const rows = Object.entries(PRICES).map(([pid, cfg]) => [{ text: cfg.label, callback_data: `genkey_${pid}` }]);
        rows.push([{ text: '🔙 Quay lại', callback_data: 'admin_panel' }]);
        safeEdit(chatId, msgId, '🎁 <b>Chọn gói để tạo key:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
      }
      else if (data.startsWith('genkey_') && isAdmin(user)) {
        const plan = data.replace('genkey_', '');
        const cfg = PRICES[plan];
        if (!cfg) return answer('Gói không tồn tại', true);
        const key = genKey(plan);
        await pool.query('INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)', [key, plan, cfg.days, Date.now() / 1000]).catch(() => {});
        safeEdit(chatId, msgId, `✅ <b>ĐÃ TẠO KEY</b>\n\nGói: ${cfg.label}\n🔑 <code>${key}</code>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🎁 Tạo thêm', callback_data: 'admin_genkey' }], [{ text: '🔙 Quay lại', callback_data: 'admin_panel' }]] },
        });
      }
      answer();
    } catch (e) {
      answer('Có lỗi xảy ra', true);
    }
  });

  bot.on('message', async msg => {
    try {
      if (!msg.text || msg.text.startsWith('/')) return;
      const userId = msg.from?.id;
      const chatId = msg.chat.id;

      if (userState[userId] === 'WAITING_KEY') {
        delete userState[userId];
        const key = msg.text.trim().toUpperCase();
        const res = await pool.query('SELECT * FROM keys WHERE key=$1', [key]);
        const row = res.rows[0];
        if (!row) return safeSend(chatId, '❌ Key không tồn tại.');

        const cfg = PRICES[row.plan] || { label: row.plan };
        const nowSec = Date.now() / 1000;
        const tgDeviceId = `tg:${userId}`;

        if (row.activated_at == null) {
          const exp = row.duration_days == null ? null : nowSec + row.duration_days * 86400;
          const upd = await pool.query(`UPDATE keys SET activated_at=$1, expires_at=$2, is_active=1, device_id=$3 WHERE key=$4 AND activated_at IS NULL`, [nowSec, exp, tgDeviceId, key]);
          if (upd.rowCount === 0) return safeSend(chatId, '⚠️ Key vừa được kích hoạt bởi phiên khác.');
          
          const expStr = exp ? new Date(exp * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn';
          return safeSend(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 Key: <code>${key}</code>\n📦 Gói: <b>${cfg.label}</b>\n⏰ Hạn dùng: <b>${expStr}</b>`, { parse_mode: 'HTML' });
        }
        
        if (row.device_id && row.device_id !== tgDeviceId) return safeSend(chatId, `❌ Key đã được kích hoạt trên thiết bị khác.`);
        
        if (row.duration_days != null && row.expires_at && nowSec > row.expires_at) {
          return safeSend(chatId, `❌ Key đã <b>hết hạn</b>.`, { parse_mode: 'HTML' });
        }
        
        const expStr = row.expires_at ? new Date(row.expires_at * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn';
        return safeSend(chatId, `ℹ️ Key này <b>đã được kích hoạt trước đó</b>.\n\n🔑 Key: <code>${key}</code>\n📦 Gói: <b>${cfg.label}</b>\n⏰ Hạn: <b>${expStr}</b>`, { parse_mode: 'HTML' });
      }
    } catch (e) { safeSend(msg.chat.id, 'Lỗi Server!'); }
  });
}

// ============================================================
// FIX #10: chờ initDB xong mới listen
// ============================================================
initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => { console.log(`🌐 Web Server running on port ${PORT}`); });
  })
  .catch(err => {
    console.error('❌ Không thể khởi động server vì lỗi DB:', err.message);
    process.exit(1);
  });
