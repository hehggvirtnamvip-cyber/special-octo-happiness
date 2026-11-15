const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_TOKEN || "9027713238:AAEic04yZItSl5UhnNnXGDz_0kAnlreElVA";
const ADMIN_ID = 7757046138;
const ADMIN_USER = "tranhoang2286";
const API_BANK = "https://reimagined-spork-bu28.onrender.com/lich-su";
const PORT = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL;

const SECRET_KEY = 'hoangtool-secret-2026-DO-NOT-SHARE-CHANGE-ME';
const TOKEN_ROTATE_MS = 3600000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60000;

const API_GAME_RAW = {
  md5:      'https://game-lon-5sks.onrender.com/json-predict/lc79/md5',
  hu:       'https://game-lon-5sks.onrender.com/json-predict/lc79/hu',
  luckywin: 'https://game-lon-5sks.onrender.com/json-predict/sicbo/luckywin',
  sumclub:  'https://game-lon-5sks.onrender.com/json-predict/sicbo/sumclub',
};

const PRICES = {
  '1d':   { price: 20000,  days: 1,    label: '1 Ngày' },
  '4d':   { price: 30000,  days: 4,    label: '4 Ngày' },
  '1w':   { price: 60000,  days: 7,    label: '1 Tuần' },
  '1m':   { price: 120000, days: 30,   label: '1 Tháng' },
  '3m':   { price: 150000, days: 90,   label: '3 Tháng' },
  'life': { price: 220000, days: null, label: 'Vĩnh Viễn' },
};

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  if (!DATABASE_URL) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, plan TEXT NOT NULL, duration_days INTEGER, created_at DOUBLE PRECISION NOT NULL, activated_at DOUBLE PRECISION, expires_at DOUBLE PRECISION, is_active INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id BIGINT, username TEXT, full_name TEXT, plan TEXT, amount INTEGER, content TEXT, status TEXT DEFAULT 'pending', created_at DOUBLE PRECISION, paid_at DOUBLE PRECISION, key_issued TEXT);
    `);
    console.log('✅ Database OK!');
  } catch (err) { console.error('❌ DB Error:', err.message); }
}
initDB();

// THUẬT TOÁN SICBO (Giữ nguyên)
function predictSicbo(history) {
  if (!history || history.length < 3) return { du_doan: 'TÀI', tin_cay: 55 };
  const recent = history.slice(0, 15).map(h => h.resultType).reverse(); 
  let taiCount = recent.filter(x => x === 1).length;
  let xiuCount = recent.filter(x => x === 0).length;
  let predict = '', confidence = 0;
  let streak = 1;
  for (let i = 1; i < recent.length; i++) { if (recent[i] === recent[i-1]) streak++; else break; }
  if (streak >= 3) { predict = recent[recent.length-1] === 1 ? 'XỈU' : 'TÀI'; confidence = 60 + (streak * 2); } 
  else if (recent.length >= 4 && recent[recent.length-1] !== recent[recent.length-2] && recent[recent.length-2] !== recent[recent.length-3]) { predict = recent[recent.length-1] === 1 ? 'XỈU' : 'TÀI'; confidence = 65; }
  else if (recent.length >= 5) { const last3 = recent.slice(-3); if (last3[0] === last3[1] && last3[2] !== last3[1]) { predict = last3[0] === 1 ? 'XỈU' : 'TÀI'; confidence = 60; } }
  if (!predict) { predict = taiCount >= xiuCount ? 'TÀI' : 'XỈU'; confidence = 50 + Math.abs(taiCount - xiuCount) * 2; }
  confidence = Math.min(85, Math.max(50, confidence));
  return { du_doan: predict, tin_cay: confidence };
}

// TOKEN MAP (Bảo mật API)
let TOKEN_MAP = {};
let CURRENT_BUCKET = -1;
function hourBucket() { return Math.floor(Date.now() / TOKEN_ROTATE_MS); }
function signWithBucket(game, bucket) { return crypto.createHmac('sha256', SECRET_KEY).update(game + ':' + bucket).digest('base64url').slice(0, 16); }
function rebuildTokenMap() {
  const bucket = hourBucket();
  if (bucket === CURRENT_BUCKET) return;
  CURRENT_BUCKET = bucket;
  TOKEN_MAP = {};
  for (const k of Object.keys(API_GAME_RAW)) TOKEN_MAP[signWithBucket(k, bucket)] = k;
}
function tokenToGame(t) { if (TOKEN_MAP[t]) return TOKEN_MAP[t]; const prevBucket = hourBucket() - 1; for (const k of Object.keys(API_GAME_RAW)) { if (signWithBucket(k, prevBucket) === t) return k; } return null; }
function gameToToken(g) { for (const [t, k] of Object.entries(TOKEN_MAP)) if (k === g) return t; return null; }
rebuildTokenMap();

// WEB API
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const cache = new Map();
const RATE_BUCKETS = new Map();
app.use('/api', (req, res, next) => { rebuildTokenMap(); next(); });

app.get('/api/games', (req, res) => {
  const meta = {
    md5:      { name: 'LC79 MD5', icon: 'fa-fingerprint', tagline: 'Phân tích mã băm', badge: 'V3' },
    hu:       { name: 'LC79 Hũ', icon: 'fa-coins', tagline: 'Dự đoán realtime', badge: 'V3' },
    luckywin: { name: 'Sicbo LuckyWin', icon: 'fa-dice', tagline: 'Thuật toán Sicbo độc quyền', badge: 'PRO' },
    sumclub:  { name: 'Sicbo SumClub', icon: 'fa-dice-d6', tagline: 'Thuật toán Sicbo độc quyền', badge: 'PRO' },
  };
  const games = [];
  for (const [k, m] of Object.entries(meta)) {
    const t = gameToToken(k);
    if (t) games.push({ id: k, token: t, ...m });
  }
  res.json({ games, expires_in: Math.ceil((TOKEN_ROTATE_MS - (Date.now() % TOKEN_ROTATE_MS)) / 1000) });
});

app.get('/api/predict/:token', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let rec = RATE_BUCKETS.get(ip);
  const now = Date.now();
  if (!rec || now > rec.reset) { rec = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS }; RATE_BUCKETS.set(ip, rec); }
  rec.count++;
  if (rec.count > RATE_LIMIT_MAX) return res.status(429).json({ error: 'Quá nhiều request' });

  const game = tokenToGame(req.params.token);
  if (!game) return res.status(404).json({ error: 'Invalid token' });

  const cached = cache.get('p:' + game);
  if (cached && Date.now() - cached.t < 5000) return res.json(cached.v);

  try {
    const r = await axios.get(API_GAME_RAW[game], { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    let raw = r.data || {};
    let data = {};

    if (game === 'md5' || game === 'hu') {
      let src = raw.data || raw;
      data = { phien: String(src.phien_hien_tai || src.phien || ''), du_doan: (src.du_doan || '').toUpperCase(), tin_cay: parseInt(src.do_tin_cay) || 50 };
    } else {
      let history = Array.isArray(raw) ? raw : (raw.data || []);
      let phien = history.length > 0 ? history[0].gameNum : '';
      let pred = predictSicbo(history);
      data = { phien: String(phien), du_doan: pred.du_doan, tin_cay: pred.tin_cay };
    }

    cache.set('p:' + game, { v: data, t: Date.now() });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Game tạm không phản hồi' });
  }
});

// FIX LỖI API ACTIVATE KEY TRẢ VỀ ĐÚNG JSON
app.post('/api/key/activate', async (req, res) => {
  try {
    const key = String(req.body.key || '').trim().toUpperCase();
    if (!key) return res.status(400).json({ ok: false, error: 'Thiếu key' });

    const result = await pool.query('SELECT plan, duration_days, activated_at, expires_at FROM keys WHERE key = $1', [key]);
    const row = result.rows[0];
    
    // Bắt buộc trả về ok: false nếu không tìm thấy
    if (!row) return res.json({ ok: false, error: 'Key không tồn tại' });

    const now = Date.now() / 1000;
    let finalExp = row.expires_at;

    if (row.activated_at === null || row.activated_at === undefined) {
      finalExp = row.duration_days === null ? null : now + row.duration_days * 86400;
      await pool.query('UPDATE keys SET activated_at=$1, expires_at=$2, is_active=1 WHERE key=$3', [now, finalExp, key]);
      return res.json({ ok: true, first_time: true, plan: row.plan, expires_at: finalExp, expires_str: finalExp ? new Date(finalExp * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn' });
    }
    if (row.duration_days !== null && row.expires_at && now > row.expires_at) {
      return res.json({ ok: false, error: 'Key đã hết hạn' });
    }
    return res.json({ ok: true, first_time: false, plan: row.plan, expires_at: finalExp });
  } catch (e) {
    // Trả về lỗi JSON thay vì HTML để web không bị crash
    res.status(500).json({ ok: false, error: 'Lỗi server: ' + e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// TELEGRAM BOT
let bot = null;
try {
  const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });
  bot = new TelegramBot(BOT_TOKEN, { polling: true, request: { agent: httpsAgent } });
  bot.on('polling_error', (error) => console.error('⚠️ Lỗi Bot:', error.message));
} catch (err) { console.error('❌ Lỗi khởi động Bot:', err.message); }

// (Các hàm xử lý bot giữ nguyên như file server.js cũ của bạn)
// ...

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web Server running on port ${PORT}`);
});
