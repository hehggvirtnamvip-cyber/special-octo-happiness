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
    
    // Nếu bảng cũ chưa có cột device_id thì thêm vào
    await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS device_id TEXT`).catch(() => {});
    console.log('✅ Database Ready!');
  } catch (err) {
    console.error('❌ DB Error:', err.message);
  }
}
initDB();

// ============================================================
// UTILS & TOKENS
// ============================================================
function predictSicbo(history) {
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
    if (taiCount === xiuCount) { predict = crypto.randomInt(0, 2) === 1 ? 'TÀI' : 'XỈU'; confidence = 50; }
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
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
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
// DEVICE LOCK MIDDLEWARE (CHẶN NẾU KHÔNG CÓ DEVICE_ID)
// ============================================================
async function requireValidKey(req, res, next) {
  try {
    let rawKey = req.headers['x-kairo-key'];
    if (!rawKey && req.headers.authorization?.startsWith('Bearer ')) rawKey = req.headers.authorization.slice(7);
    const key = String(rawKey || '').trim().toUpperCase();
    if (!key) return res.status(401).json({ ok: false, error: 'Thiếu key xác thực' });

    const deviceId = String(req.headers['x-device-id'] || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Lỗi: Không tìm thấy Device ID từ trình duyệt' });

    const result = await pool.query('SELECT * FROM keys WHERE key = $1', [key]);
    const row = result.rows[0];
    if (!row || row.is_active !== 1) return res.status(401).json({ ok: false, error: 'Key không hợp lệ hoặc chưa kích hoạt' });
    if (row.expires_at != null && (Date.now() / 1000) > row.expires_at) return res.status(401).json({ ok: false, error: 'Key đã hết hạn' });

    // KIỂM TRA THIẾT BỊ
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
  res.json({ games });
});

app.get('/api/predict/:token', rateLimit(), requireValidKey, async (req, res) => {
  rebuildTokenMap();
  const gameId = tokenToGame(req.params.token);
  if (!gameId) return res.status(403).json({ error: 'Token không hợp lệ' });

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
      const pred = predictSicbo(history);
      data = { phien: String(history[0].gameNum), du_doan: pred.du_doan, tin_cay: pred.tin_cay, history };
    }
    res.json(data);
  } catch (e) {
    res.json({ du_doan: 'BẢO TRÌ', tin_cay: 0, history: [] });
  }
});

// ============================================================
// API KÍCH HOẠT KEY
// ============================================================
app.post('/api/key/activate', rateLimit(10, 60_000), async (req, res) => {
  try {
    const key = String(req.body?.key || '').trim().toUpperCase();
    // Nhận device_id: Frontend gửi lên qua Body hoặc Header
    const deviceId = String(req.body?.device_id || req.headers['x-device-id'] || '').trim();
    
    if (!key) return res.status(400).json({ ok: false, error: 'Thiếu key' });
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Thiếu Device ID' });

    const result = await pool.query('SELECT * FROM keys WHERE key = $1', [key]);
    const row = result.rows[0];
    if (!row) return res.json({ ok: false, error: 'Key không tồn tại' });

    const nowSec = Date.now() / 1000;

    if (row.activated_at == null) {
      const finalExp = row.duration_days == null ? null : nowSec + row.duration_days * 86400;
      const upd = await pool.query(
        `UPDATE keys SET activated_at = $1, expires_at = $2, is_active = 1, device_id = $3 WHERE key = $4`,
        [nowSec, finalExp, deviceId, key]
      );
      if (upd.rowCount === 0) return res.json({ ok: false, error: 'Key đang bị thao tác' });
      return res.json({ ok: true, first_time: true, message: 'Kích hoạt thành công' });
    }

    if (row.device_id && row.device_id !== deviceId) {
      return res.status(403).json({ ok: false, error: 'Key này đã được kích hoạt trên thiết bị khác!' });
    }

    if (row.duration_days != null && row.expires_at && nowSec > row.expires_at) {
      return res.json({ ok: false, error: 'Key đã hết hạn' });
    }
    return res.json({ ok: true, first_time: false, message: 'Kích hoạt thành công' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
});

// ============================================================
// TELEGRAM BOT (Chống delay / 409)
// ============================================================
let bot = null;
if (BOT_TOKEN) {
  const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });
  bot = new TelegramBot(BOT_TOKEN, {
    polling: { 
      autoStart: false, 
      interval: 1000, 
      params: { timeout: 10 },
      conflictRetryDelayMs: 3000 // Tự động thử lại sau 3s nếu mạng lag
    },
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

// CÁC HÀM XỬ LÝ BOT CƠ BẢN
const userState = {};
function genKey(plan) { return `HT${plan.toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function safeSend(chatId, text, opts) { return bot.sendMessage(chatId, text, opts).catch(() => {}); }

if (bot) {
  bot.onText(/\/start/, msg => {
    const text = `🦁 <b>KAIRO TOOL</b>\nChào <b>${msg.from.first_name}</b>!\n\n👇 Chọn thao tác:`;
    const kb = { inline_keyboard: [[{ text: '🛒 Mua Key', callback_data: 'buy_menu' }], [{ text: '🔑 Nhập Key', callback_data: 'enter_key' }]] };
    safeSend(msg.chat.id, text, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    bot.answerCallbackQuery(query.id).catch(()=>{});

    if (data === 'buy_menu') {
      const rows = Object.entries(PRICES).map(([pid, cfg]) => [{ text: `${cfg.label} - ${cfg.price.toLocaleString('vi-VN')}đ`, callback_data: `buy_${pid}` }]);
      bot.editMessageText('🛒 <b>Chọn gói key:</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }).catch(()=>{});
    } else if (data.startsWith('buy_')) {
      const plan = data.replace('buy_', '');
      const cfg = PRICES[plan];
      const orderId = crypto.randomBytes(4).toString('hex').toUpperCase();
      const content = `HT${orderId}`;
      
      await pool.query(`INSERT INTO orders (id, user_id, username, full_name, plan, amount, content, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [orderId, query.from.id, query.from.username || '', query.from.first_name || '', plan, cfg.price, content, Date.now()/1000]).catch(()=>{});
      
      const text = `🧾 <b>ĐƠN #${orderId}</b>\n\n📦 Gói: <b>${cfg.label}</b>\n💵 Số tiền: <b>${cfg.price.toLocaleString('vi-VN')}đ</b>\n🏦 Ngân hàng: <b>${BANK_CODE}</b>\n💳 Số TK: <code>${BANK_ACC}</code>\n\n📝 <b>NỘI DUNG CK:</b>\n<code>${content}</code>`;
      const kb = { inline_keyboard: [[{ text: '✅ Tôi đã chuyển khoản', callback_data: `paid_${orderId}` }]] };
      bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb }).catch(()=>{});
    } else if (data.startsWith('paid_')) {
      const orderId = data.replace('paid_', '');
      bot.editMessageText('⏳ Đang kiểm tra giao dịch...', { chat_id: chatId, message_id: msgId }).catch(()=>{});
      
      try {
        const r = await axios.get(API_BANK, { timeout: 6000 });
        const txs = Array.isArray(r.data) ? r.data : (r.data.data || []);
        const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
        const order = orderRes.rows[0];
        
        const tx = txs.find(t => t.content && t.content.toUpperCase().includes(order.content.toUpperCase()) && (t.amount || 0) >= order.amount);
        if (!tx) {
          return bot.editMessageText('❌ <b>Chưa thấy giao dịch!</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(()=>{});
        }

        const key = genKey(order.plan);
        await pool.query('UPDATE orders SET status=$1, key_issued=$2 WHERE id=$3', ['paid', key, orderId]);
        await pool.query('INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)', [key, order.plan, PRICES[order.plan].days, Date.now()/1000]);
        
        bot.editMessageText(`✅ <b>THÀNH CÔNG!</b>\n\n🔑 Key: <code>${key}</code>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText('❌ Lỗi kiểm tra giao dịch!', { chat_id: chatId, message_id: msgId }).catch(()=>{});
      }
    } else if (data === 'enter_key') {
      userState[query.from.id] = 'WAITING_KEY';
      safeSend(chatId, '🔑 Vui lòng gửi Key của bạn vào chat:');
    }
  });

  bot.on('message', async msg => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (userState[msg.from.id] === 'WAITING_KEY') {
      delete userState[msg.from.id];
      const key = msg.text.trim().toUpperCase();
      const res = await pool.query('SELECT * FROM keys WHERE key=$1', [key]);
      const row = res.rows[0];
      if (!row) return safeSend(msg.chat.id, '❌ Key không tồn tại.');

      const tgDeviceId = `tg:${msg.from.id}`;
      const nowSec = Date.now() / 1000;

      if (row.activated_at == null) {
        const exp = row.duration_days == null ? null : nowSec + row.duration_days * 86400;
        await pool.query(`UPDATE keys SET activated_at=$1, expires_at=$2, is_active=1, device_id=$3 WHERE key=$4`, [nowSec, exp, tgDeviceId, key]);
        safeSend(msg.chat.id, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\nHạn dùng: ${exp ? new Date(exp*1000).toLocaleString('vi-VN') : 'Vĩnh viễn'}`, { parse_mode: 'HTML' });
      } else if (row.device_id && row.device_id !== tgDeviceId) {
        safeSend(msg.chat.id, '❌ Key đã được sử dụng trên thiết bị khác!');
      } else {
        safeSend(msg.chat.id, 'ℹ️ Key đã được kích hoạt trước đó.');
      }
    }
  });
}

app.listen(PORT, '0.0.0.0', () => { console.log(`🌐 Web Server running on port ${PORT}`); });
