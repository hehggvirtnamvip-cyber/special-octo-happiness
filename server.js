const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

// ========== CONFIG ==========
const BOT_TOKEN = process.env.TELEGRAM_TOKEN || "9027713238:AAEic04yZItSl5UhnNnXGDz_0kAnlreElVA";
const ADMIN_ID = 7757046138;
const ADMIN_USER = "tranhoang2286";
const NOTIFY_CHAT = -1001234567890;

const BANK_CODE = "BIDV";
const BANK_ACC = "96247V4IWI";
const BANK_HOLDER = "TRAN NHAT HOANG";

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

// ========== DATABASE SETUP ==========
if (!DATABASE_URL) {
  console.error("❌ LỖI: Chưa có biến môi trường DATABASE_URL trên Render!");
  console.error("👉 Hãy vào Tab Environment của Web Service và thêm DATABASE_URL.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  if (!DATABASE_URL) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY, plan TEXT NOT NULL, duration_days INTEGER,
        created_at DOUBLE PRECISION NOT NULL, activated_at DOUBLE PRECISION, 
        expires_at DOUBLE PRECISION, is_active INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, user_id BIGINT, username TEXT, full_name TEXT,
        plan TEXT, amount INTEGER, content TEXT, status TEXT DEFAULT 'pending',
        created_at DOUBLE PRECISION, paid_at DOUBLE PRECISION, key_issued TEXT
      );
    `);
    console.log('✅ Kết nối Database thành công!');
  } catch (err) {
    console.error('❌ Lỗi khởi tạo DB:', err.message);
  }
}
initDB();

// ========== TOKEN MAP ==========
let TOKEN_MAP = {};
let CURRENT_BUCKET = -1;

function hourBucket() { return Math.floor(Date.now() / TOKEN_ROTATE_MS); }
function signWithBucket(game, bucket) {
  return crypto.createHmac('sha256', SECRET_KEY).update(game + ':' + bucket).digest('base64url').slice(0, 16);
}
function rebuildTokenMap() {
  const bucket = hourBucket();
  if (bucket === CURRENT_BUCKET) return;
  CURRENT_BUCKET = bucket;
  TOKEN_MAP = {};
  for (const k of Object.keys(API_GAME_RAW)) TOKEN_MAP[signWithBucket(k, bucket)] = k;
}
function tokenToGame(t) {
  if (TOKEN_MAP[t]) return TOKEN_MAP[t];
  const prevBucket = hourBucket() - 1;
  for (const k of Object.keys(API_GAME_RAW)) {
    if (signWithBucket(k, prevBucket) === t) return k;
  }
  return null;
}
function gameToToken(g) {
  for (const [t, k] of Object.entries(TOKEN_MAP)) if (k === g) return t;
  return null;
}
rebuildTokenMap();

// ========== EXPRESS WEB SERVER ==========
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const cache = new Map();
const RATE_BUCKETS = new Map();

app.use('/api', (req, res, next) => { rebuildTokenMap(); next(); });

app.get('/api/games', (req, res) => {
  const meta = {
    md5:      { name: 'LC79 MD5', icon: 'fa-fingerprint', tagline: 'Tool MD5 — Phân tích mã băm', badge: 'V3' },
    hu:       { name: 'LC79 Hũ', icon: 'fa-coins', tagline: 'Tool Hũ — Dự đoán realtime', badge: 'V3' },
    luckywin: { name: 'Sicbo LuckyWin', icon: 'fa-dice', tagline: 'Tài Xỉu LuckyWin — AI dự đoán', badge: 'V3' },
    sumclub:  { name: 'Sicbo SumClub', icon: 'fa-dice-d6', tagline: 'Tài Xỉu SumClub — AI dự đoán', badge: 'V3' },
  };
  const games = [];
  for (const [k, m] of Object.entries(meta)) {
    const t = gameToToken(k);
    if (t) games.push({ id: k, token: t, ...m });
  }
  const expires_in = Math.ceil((TOKEN_ROTATE_MS - (Date.now() % TOKEN_ROTATE_MS)) / 1000);
  res.json({ games, expires_in });
});

app.get('/api/predict/:token', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let rec = RATE_BUCKETS.get(ip);
  const now = Date.now();
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
    RATE_BUCKETS.set(ip, rec);
  }
  rec.count++;
  if (rec.count > RATE_LIMIT_MAX) return res.status(429).json({ error: 'Quá nhiều request' });

  const game = tokenToGame(req.params.token);
  if (!game) return res.status(404).json({ error: 'Invalid token' });

  const cached = cache.get('p:' + game);
  if (cached && Date.now() - cached.t < 5000) return res.json(cached.v);

  try {
    const r = await axios.get(API_GAME_RAW[game], { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    let raw = r.data || {};
    let src = raw;
    for (const k of ['data', 'result', 'prediction', 'predict']) {
      if (raw[k] && typeof raw[k] === 'object') { src = raw[k]; break; }
    }
    let phien = src.phien || src.session || src.issue || src.id || src.ky || src.period || '';
    let du_doan = src.du_doan || src.prediction || src.predict || src.result || src.ket_qua || src.bet || src.duDoan || '';
    let tin_cay = src.tin_cay || src.confidence || src.rate || src.ti_le || src.prob || src.probability || src.win_rate || src.tyle || 0;
    
    tin_cay = parseFloat(String(tin_cay).replace('%', '').trim()) || 0;
    if (tin_cay > 0 && tin_cay <= 1) tin_cay = Math.round(tin_cay * 100);
    else tin_cay = Math.round(tin_cay);

    if (typeof du_doan === 'string') {
      du_doan = du_doan.toUpperCase().trim();
      const map = { BIG: 'TÀI', TAI: 'TÀI', 'TÀI': 'TÀI', SMALL: 'XỈU', XIU: 'XỈU', 'XỈU': 'XỈU', EVEN: 'CHẴN', CHAN: 'CHẴN', 'CHẴN': 'CHẴN', ODD: 'LẺ', LE: 'LẺ', 'LẺ': 'LẺ' };
      du_doan = map[du_doan] || du_doan;
    }
    const data = { phien: String(phien), du_doan: du_doan || '—', tin_cay };
    cache.set('p:' + game, { v: data, t: Date.now() });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Game tạm không phản hồi' });
  }
});

app.post('/api/key/activate', async (req, res) => {
  try {
    const key = String(req.body.key || '').trim().toUpperCase();
    if (!key) return res.status(400).json({ ok: false, error: 'Thiếu key' });

    const result = await pool.query('SELECT plan, duration_days, activated_at, expires_at FROM keys WHERE key = $1', [key]);
    const row = result.rows[0];
    if (!row) return res.json({ ok: false, error: 'Key không tồn tại' });

    const now = Date.now() / 1000;
    if (row.activated_at === null || row.activated_at === undefined) {
      const exp = row.duration_days === null ? null : now + row.duration_days * 86400;
      await pool.query('UPDATE keys SET activated_at=$1, expires_at=$2, is_active=1 WHERE key=$3', [now, exp, key]);
      return res.json({ ok: true, first_time: true, plan: row.plan, expires_str: exp ? new Date(exp * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn' });
    }
    if (row.duration_days !== null && row.expires_at && now > row.expires_at) {
      return res.json({ ok: false, error: 'Key đã hết hạn', expires_str: new Date(row.expires_at * 1000).toLocaleString('vi-VN') });
    }
    return res.json({ ok: true, first_time: false, plan: row.plan, expires_str: row.expires_at ? new Date(row.expires_at * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ========== TELEGRAM BOT (FIX LỖI & CHỐNG CRASH) ==========
let bot = null;
try {
  const httpsAgent = new https.Agent({  
    rejectUnauthorized: false,
    family: 4 
  });

  bot = new TelegramBot(BOT_TOKEN, { 
    polling: true,
    request: { agent: httpsAgent }
  });

  bot.on('polling_error', (error) => {
    console.error('⚠️ Lỗi Polling (Bot có thể đang chạy ở nơi khác):', error.message);
    // Không throw error, để Web Server tiếp tục chạy
  });
  console.log('🤖 Bot Telegram đã khởi động!');
} catch (err) {
  console.error('❌ Không thể khởi động Bot Telegram:', err.message);
}

const userState = {};
function genKey(plan) {
  const pref = { '1d': 'HT1D', '4d': 'HT4D', '1w': 'HT1W', '1m': 'HT1M', '3m': 'HT3M', 'life': 'HTLIFE' }[plan];
  const r = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${pref}-${r.slice(0, 4)}-${r.slice(4, 8)}`;
}
function isAdmin(user) {
  return user.id === ADMIN_ID || (user.username && user.username.toLowerCase() === ADMIN_USER);
}

async function showStart(chatId, user) {
  if (!bot) return;
  const opts = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛒 Mua Key', callback_data: 'buy_menu' }],
        [{ text: '🔑 Nhập Key', callback_data: 'enter_key' }],
        ...(isAdmin(user) ? [[{ text: '👑 Admin Panel', callback_data: 'admin_panel' }]] : [])
      ]
    }
  };
  await bot.sendMessage(chatId, `🦁 <b>HOÀNG TOOL</b>\nChào <b>${user.first_name}</b>!\n\n💰 <b>BẢNG GIÁ KEY</b>\n• 20k → 1 ngày\n• 30k → 4 ngày\n• 60k → 1 tuần\n• 120k → 1 tháng\n• 150k → 3 tháng\n• 220k → Vĩnh viễn\n\n👇 Chọn thao tác`, opts).catch(e => console.error("Lỗi gửi tin nhắn start:", e.message));
}

if (bot) {
  bot.onText(/\/start/, (msg) => showStart(msg.chat.id, msg.from));

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    const user = query.from;

    if (data === 'back_start') {
      bot.deleteMessage(chatId, msgId).catch(()=>{});
      showStart(chatId, user);
    }
    else if (data === 'buy_menu') {
      const keys = Object.entries(PRICES).map(([pid, cfg]) => [{ text: `💎 ${cfg.label} — ${cfg.price.toLocaleString('vi-VN')}đ`, callback_data: `buy_${pid}` }]);
      keys.push([{ text: '🔙 Quay lại', callback_data: 'back_start' }]);
      bot.editMessageText('🛒 <b>Chọn gói key:</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keys } }).catch(e => console.error("Lỗi editMessage:", e.message));
    } 
    else if (data.startsWith('buy_')) {
      const plan = data.replace('buy_', '');
      const cfg = PRICES[plan];
      if (!cfg) return;
      const orderId = crypto.randomBytes(4).toString('hex').toUpperCase();
      const content = `HT${orderId}`;
      await pool.query('INSERT INTO orders (id, user_id, username, full_name, plan, amount, content, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [orderId, user.id, user.username || '', user.first_name || '', plan, cfg.price, content, Date.now() / 1000]).catch(e => console.error("Lỗi insert order:", e.message));
      
      const qrUrl = `https://vietqr.app/img?bank=${BANK_CODE}&acc=${BANK_ACC}&amount=${cfg.price}&addInfo=${content}&template=compact&showinfo=true&holder=${encodeURIComponent(BANK_HOLDER)}`;
      const text = `🧾 <b>ĐƠN #${orderId}</b>\n\n📦 Gói: <b>${cfg.label}</b>\n💵 Số tiền: <b>${cfg.price.toLocaleString('vi-VN')}đ</b>\n🏦 Ngân hàng: <b>${BANK_CODE}</b>\n👤 Chủ TK: <b>${BANK_HOLDER}</b>\n💳 Số TK: <code>${BANK_ACC}</code>\n\n📝 <b>NỘI DUNG CK (bắt buộc):</b>\n<code>${content}</code>\n\n⚠️ Chuyển <b>đúng nội dung & đúng số tiền</b>.\nSau khi CK, nhấn nút bên dưới.`;
      
      try {
        await bot.sendPhoto(chatId, qrUrl, { caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Tôi đã chuyển khoản', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] } });
        bot.deleteMessage(chatId, msgId).catch(()=>{});
      } catch (e) {
        bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Tôi đã chuyển khoản', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] } }).catch(e => console.error("Lỗi editMessage:", e.message));
      }
    }
    else if (data.startsWith('paid_')) {
      const orderId = data.replace('paid_', '');
      const res = await pool.query('SELECT plan, amount, content, status FROM orders WHERE id=$1', [orderId]);
      const order = res.rows[0];
      if (!order || order.status === 'paid') return bot.answerCallbackQuery(query.id, { text: 'Đơn không tồn tại hoặc đã xử lý', show_alert: true });
      
      bot.editMessageCaption(query.message.caption + '\n\n⏳ <b>Đang kiểm tra giao dịch...</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(()=>{});

      let tx = null;
      for (let i = 0; i < 5; i++) {
        try {
          const r = await axios.get(API_BANK);
          const txs = Array.isArray(r.data) ? r.data : (r.data.data || r.data.transactions || []);
          tx = txs.find(t => t.content && t.content.toUpperCase().includes(order.content.toUpperCase()) && (t.amount || 0) >= order.amount);
          if (tx) break;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!tx) {
        return bot.editMessageCaption(query.message.caption.split('⏳')[0] + '\n\n❌ <b>CHƯA CHUYỂN KHOẢN!!</b>\nBot chưa thấy giao dịch khớp.', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Kiểm tra lại', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] } }).catch(()=>{});
      }

      const key = genKey(order.plan);
      const cfg = PRICES[order.plan];
      await pool.query('UPDATE orders SET status=$1, paid_at=$2, key_issued=$3 WHERE id=$4', ['paid', Date.now() / 1000, key, orderId]).catch(()=>{});
      await pool.query('INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)', [key, order.plan, cfg.days, Date.now() / 1000]).catch(()=>{});

      bot.editMessageCaption(`✅ <b>THANH TOÁN THÀNH CÔNG!</b>\n\n🔑 <b>KEY CỦA BẠN:</b>\n<code>${key}</code>\n\n📦 Gói: <b>${cfg.label}</b>\n\n⚠️ Key chỉ kích hoạt được 1 lần.\nNhập lại <b>KHÔNG cộng thêm</b> thời gian.`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(()=>{});
      
      bot.sendMessage(ADMIN_ID, `💰 <b>ĐƠN MỚI</b>\nUser: ${user.first_name} (@${user.username || 'no_username'})\nGói: ${cfg.label}\nKey: <code>${key}</code>`, { parse_mode: 'HTML' }).catch(()=>{});
    }
    else if (data === 'enter_key') {
      userState[user.id] = 'WAITING_KEY';
      bot.sendMessage(chatId, '🔑 <b>Nhập key của bạn</b>\n\nGửi key vào chat để kích hoạt.\n⚠️ Key chỉ kích hoạt 1 lần.', { parse_mode: 'HTML' }).catch(()=>{});
    }
    else if (data === 'admin_panel' && isAdmin(user)) {
      const totalRes = await pool.query('SELECT COUNT(*) FROM keys').catch(()=>({rows:[{count:0}]}));
      const activeRes = await pool.query("SELECT COUNT(*) FROM keys WHERE is_active=1").catch(()=>({rows:[{count:0}]}));
      const revRes = await pool.query("SELECT SUM(amount) FROM orders WHERE status='paid'").catch(()=>({rows:[{sum:0}]}));
      const rev = revRes.rows[0].sum || 0;
      bot.editMessageText(`👑 <b>ADMIN PANEL</b>\n\n🔑 Tổng key: <b>${totalRes.rows[0].count}</b>\n✅ Active: <b>${activeRes.rows[0].count}</b>\n💰 Doanh thu: <b>${rev.toLocaleString('vi-VN')}đ</b>`, { 
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎁 Tạo key tay', callback_data: 'admin_genkey' }], [{ text: '🔙 Quay lại', callback_data: 'back_start' }]] }
      }).catch(()=>{});
    }
    else if (data === 'admin_genkey' && isAdmin(user)) {
      const keys = Object.entries(PRICES).map(([pid, cfg]) => [{ text: cfg.label, callback_data: `genkey_${pid}` }]);
      keys.push([{ text: '🔙 Quay lại', callback_data: 'admin_panel' }]);
      bot.editMessageText('🎁 <b>Chọn gói để tạo key:</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keys } }).catch(()=>{});
    }
    else if (data.startsWith('genkey_') && isAdmin(user)) {
      const plan = data.replace('genkey_', '');
      const cfg = PRICES[plan];
      const key = genKey(plan);
      await pool.query('INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)', [key, plan, cfg.days, Date.now() / 1000]).catch(()=>{});
      bot.editMessageText(`✅ <b>ĐÃ TẠO KEY</b>\n\nGói: ${cfg.label}\n🔑 <code>${key}</code>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại', callback_data: 'admin_panel' }]] } }).catch(()=>{});
    }

    bot.answerCallbackQuery(query.id).catch(()=>{});
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    if (userState[userId] === 'WAITING_KEY') {
      delete userState[userId];
      const key = msg.text.trim().toUpperCase();
      
      try {
        const res = await pool.query('SELECT plan, duration_days, activated_at, expires_at FROM keys WHERE key=$1', [key]);
        const row = res.rows[0];
        if (!row) return bot.sendMessage(chatId, '❌ Key không tồn tại.');
        
        const now = Date.now() / 1000;
        const cfg = PRICES[row.plan] || { label: row.plan };
        
        if (row.activated_at === null || row.activated_at === undefined) {
          const exp = row.duration_days === null ? null : now + row.duration_days * 86400;
          await pool.query('UPDATE keys SET activated_at=$1, expires_at=$2, is_active=1 WHERE key=$3', [now, exp, key]);
          const expStr = exp ? new Date(exp * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn';
          bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 Key: <code>${key}</code>\n📦 Gói: <b>${cfg.label}</b>\n⏰ Hạn dùng: <b>${expStr}</b>\n\n🌐 Vào web tool để sử dụng.`, { parse_mode: 'HTML' });
        } else if (row.duration_days !== null && row.expires_at && now > row.expires_at) {
          bot.sendMessage(chatId, `❌ Key đã <b>hết hạn</b> từ ${new Date(row.expires_at * 1000).toLocaleString('vi-VN')}.`, { parse_mode: 'HTML' });
        } else {
          const expStr = row.expires_at ? new Date(row.expires_at * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn';
          bot.sendMessage(chatId, `ℹ️ Key này <b>đã được kích hoạt trước đó</b>.\n\n🔑 Key: <code>${key}</code>\n📦 Gói: <b>${cfg.label}</b>\n⏰ Hạn: <b>${expStr}</b>\n\n⚠️ <b>KHÔNG cộng thêm thời gian</b> khi nhập lại.`, { parse_mode: 'HTML' });
        }
      } catch (e) {
        bot.sendMessage(chatId, 'Lỗi Server: ' + e.message).catch(()=>{});
      }
    }
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web Server chạy tại http://localhost:${PORT}`);
});
