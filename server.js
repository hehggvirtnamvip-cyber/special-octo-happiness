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

const BANK_CODE = "BIDV";
const BANK_ACC = "96247V4IWI";
const BANK_HOLDER = "TRAN NHAT HOANG";

const API_BANK = "https://reimagined-spork-bu28.onrender.com/lich-su";
const PORT = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL;

const SECRET_KEY = 'kairo-secret-2026-DO-NOT-SHARE-CHANGE-ME';
const TOKEN_ROTATE_MS = 3600000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60000;

const _k1 = "aHR0cHM6Ly9nYW1lLWxvbi01";
const _k2 = "c2tzLm9ucmVuZGVyLmNvbS9q";
const _k3 = "c29uLXByZWRpY3Qv";
const API_GAME_RAW = {
  md5: Buffer.from(_k1 + _k2 + _k3 + "bGM3OS9tZDU=").toString('ascii'), 
  hu: Buffer.from(_k1 + _k2 + _k3 + "bGM3OS9odQ==").toString('ascii'), 
  luckywin: Buffer.from(_k1 + _k2 + _k3 + "c2ljYm8vbHVja3l3aW4=").toString('ascii'), 
  sumclub: Buffer.from(_k1 + _k2 + _k3 + "c2ljYm8vc3VtY2x1Yg==").toString('ascii'),
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
  if (!DATABASE_URL) return console.error("❌ THIẾU DATABASE_URL!");
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, plan TEXT NOT NULL, duration_days INTEGER, created_at DOUBLE PRECISION NOT NULL, activated_at DOUBLE PRECISION, expires_at DOUBLE PRECISION, is_active INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id BIGINT, username TEXT, full_name TEXT, plan TEXT, amount INTEGER, content TEXT, status TEXT DEFAULT 'pending', created_at DOUBLE PRECISION, paid_at DOUBLE PRECISION, key_issued TEXT);
    `);
    console.log('✅ Database OK!');
  } catch (err) { console.error('❌ DB Error:', err.message); }
}
initDB();

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

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

const RATE_BUCKETS = new Map();
app.use('/api', (req, res, next) => { rebuildTokenMap(); next(); });

let RUNTIME_HISTORY = { md5: [], hu: [], luckywin: [], sumclub: [] };

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

  const gameId = tokenToGame(req.params.token);
  
  if (!gameId) {
    return res.status(403).json({ error: "ĐỒ NGU + ÓC CẶC CŨNG ĐÒI CRACK. TOOL NÀY KHÔNG CÓ SERVER ĐỂ CHẠY ĐÂU!" });
  }

  let raw = null;
  let apiStatus = "OK";

  try {
    const r = await axios.get(API_GAME_RAW[gameId], { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    raw = r.data;
  } catch (e) {
    console.error("⚠️ API Gốc sập, dùng Fallback:", e.message);
    apiStatus = "OFFLINE_FALLBACK";
  }

  let data = {};

  if (apiStatus === "OK" && raw) {
    if (gameId === 'md5' || gameId === 'hu') {
      const phien = String(raw.phien_hien_tai || '');
      const du_doan = (raw.du_doan || '').toUpperCase();
      const tin_cay = parseInt(raw.do_tin_cay) || 50;
      data = { phien, du_doan, tin_cay, status: "LIVE" };
    } else {
      let history = Array.isArray(raw) ? raw : (raw.data || []);
      let phien = history.length > 0 ? String(history[0].gameNum) : '';
      let pred = predictSicbo(history);
      data = { phien, du_doan: pred.du_doan, tin_cay: pred.tin_cay, status: "LIVE" };
    }
  } else {
    const phien = String(Math.floor(Date.now() / 10000)); 
    const pred = predictSicbo(RUNTIME_HISTORY[gameId]); 
    data = { phien: phien, du_doan: pred.du_doan, tin_cay: pred.tin_cay, status: "BẢO TRÌ" };
  }

  let historyArr = RUNTIME_HISTORY[gameId];
  let lastRecord = historyArr.length > 0 ? historyArr[0] : null;
  
  if (lastRecord && lastRecord.phien !== data.phien && lastRecord.ket_qua === null) {
      lastRecord.ket_qua = data.du_doan;
      lastRecord.danh_gia = (lastRecord.du_doan === data.du_doan) ? 'WIN' : 'LOSE';
  }
  
  if (!lastRecord || lastRecord.phien !== data.phien) {
      historyArr.unshift({ phien: data.phien, du_doan: data.du_doan, ket_qua: null, danh_gia: null });
      if (historyArr.length > 30) historyArr.pop();
  }
  data.history = historyArr;

  res.json(data);
});

app.post('/api/key/activate', async (req, res) => {
  try {
    const key = String(req.body.key || '').trim().toUpperCase();
    if (!key) return res.status(400).json({ ok: false, error: 'Thiếu key' });
    const result = await pool.query('SELECT plan, duration_days, activated_at, expires_at FROM keys WHERE key = $1', [key]);
    const row = result.rows[0];
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
    res.status(500).json({ ok: false, error: 'Lỗi server: ' + e.message });
  }
});

// ========== TELEGRAM BOT ==========
let bot = null;
try {
  const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });
  bot = new TelegramBot(BOT_TOKEN, { polling: true, request: { agent: httpsAgent } });
  bot.on('polling_error', (error) => console.error('⚠️ Lỗi Bot:', error.message));
} catch (err) { console.error('❌ Lỗi khởi động Bot:', err.message); }

const userState = {};
function genKey(plan) { const pref = { '1d': 'HT1D', '4d': 'HT4D', '1w': 'HT1W', '1m': 'HT1M', '3m': 'HT3M', 'life': 'HTLIFE' }[plan]; return `${pref}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function isAdmin(user) { return user.id === ADMIN_ID || (user.username && user.username.toLowerCase() === ADMIN_USER); }

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
  await bot.sendMessage(chatId, `🦁 <b>KAIRO TOOL</b>\nChào <b>${user.first_name}</b>!\n\n💰 <b>BẢNG GIÁ KEY</b>\n• 20k → 1 ngày\n• 30k → 4 ngày\n• 60k → 1 tuần\n• 120k → 1 tháng\n• 150k → 3 tháng\n• 220k → Vĩnh viễn\n\n👇 Chọn thao tác`, opts).catch(()=>{});
}

if (bot) {
  bot.onText(/\/start/, (msg) => showStart(msg.chat.id, msg.from));

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id; const msgId = query.message.message_id; const data = query.data; const user = query.from;
    if (data === 'back_start') { bot.deleteMessage(chatId, msgId).catch(()=>{}); showStart(chatId, user); }
    else if (data === 'buy_menu') {
      const keys = Object.entries(PRICES).map(([pid, cfg]) => [{ text: `💎 ${cfg.label} — ${cfg.price.toLocaleString('vi-VN')}đ`, callback_data: `buy_${pid}` }]);
      keys.push([{ text: '🔙 Quay lại', callback_data: 'back_start' }]);
      bot.editMessageText('🛒 <b>Chọn gói key:</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keys } }).catch(()=>{});
    } 
    else if (data.startsWith('buy_')) {
      const plan = data.replace('buy_', ''); const cfg = PRICES[plan]; if (!cfg) return;
      const orderId = crypto.randomBytes(4).toString('hex').toUpperCase(); const content = `HT${orderId}`;
      await pool.query('INSERT INTO orders (id, user_id, username, full_name, plan, amount, content, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [orderId, user.id, user.username || '', user.first_name || '', plan, cfg.price, content, Date.now() / 1000]).catch(()=>{});
      const qrUrl = `https://vietqr.app/img?bank=${BANK_CODE}&acc=${BANK_ACC}&amount=${cfg.price}&addInfo=${content}&template=compact&showinfo=true&holder=${encodeURIComponent(BANK_HOLDER)}`;
      const text = `🧾 <b>ĐƠN #${orderId}</b>\n\n📦 Gói: <b>${cfg.label}</b>\n💵 Số tiền: <b>${cfg.price.toLocaleString('vi-VN')}đ</b>\n🏦 Ngân hàng: <b>${BANK_CODE}</b>\n👤 Chủ TK: <b>${BANK_HOLDER}</b>\n💳 Số TK: <code>${BANK_ACC}</code>\n\n📝 <b>NỘI DUNG CK (bắt buộc):</b>\n<code>${content}</code>\n\n⚠️ Chuyển <b>đúng nội dung & đúng số tiền</b>.\nSau khi CK, nhấn nút bên dưới.`;
      try {
        await bot.sendPhoto(chatId, qrUrl, { caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Tôi đã chuyển khoản', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] } });
        bot.deleteMessage(chatId, msgId).catch(()=>{});
      } catch (e) {
        bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Tôi đã chuyển khoản', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] } }).catch(()=>{});
      }
    }
    else if (data.startsWith('paid_')) {
      const orderId = data.replace('paid_', '');
      const res = await pool.query('SELECT plan, amount, content, status FROM orders WHERE id=$1', [orderId]).catch(()=>({rows:[]}));
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
      if (!tx) return bot.editMessageCaption(query.message.caption.split('⏳')[0] + '\n\n❌ <b>CHƯA CHUYỂN KHOẢN!!</b>\nBot chưa thấy giao dịch khớp.', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Kiểm tra lại', callback_data: `paid_${orderId}` }], [{ text: '🔙 Quay lại', callback_data: 'buy_menu' }]] } }).catch(()=>{});
      const key = genKey(order.plan); const cfg = PRICES[order.plan];
      await pool.query('UPDATE orders SET status=$1, paid_at=$2, key_issued=$3 WHERE id=$4', ['paid', Date.now() / 1000, key, orderId]).catch(()=>{});
      await pool.query('INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)', [key, order.plan, cfg.days, Date.now() / 1000]).catch(()=>{});
      bot.editMessageCaption(`✅ <b>THANH TOÁN THÀNH CÔNG!</b>\n\n🔑 <b>KEY CỦA BẠN:</b>\n<code>${key}</code>\n\n📦 Gói: <b>${cfg.label}</b>\n\n⚠️ Key chỉ kích hoạt được 1 lần.\nNhập lại <b>KHÔNG cộng thêm</b> thời gian.`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(()=>{});
      bot.sendMessage(ADMIN_ID, `💰 <b>ĐƠN MỚI</b>\nUser: ${user.first_name} (@${user.username || 'no_username'})\nGói: ${cfg.label}\nKey: <code>${key}</code>`, { parse_mode: 'HTML' }).catch(()=>{});
    }
    else if (data === 'enter_key') { userState[user.id] = 'WAITING_KEY'; bot.sendMessage(chatId, '🔑 <b>Nhập key của bạn</b>\n\nGửi key vào chat để kích hoạt.', { parse_mode: 'HTML' }).catch(()=>{}); }
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
      const plan = data.replace('genkey_', ''); const cfg = PRICES[plan]; const key = genKey(plan);
      await pool.query('INSERT INTO keys (key, plan, duration_days, created_at, is_active) VALUES ($1,$2,$3,$4,0)', [key, plan, cfg.days, Date.now() / 1000]).catch(()=>{});
      bot.editMessageText(`✅ <b>ĐÃ TẠO KEY</b>\n\nGói: ${cfg.label}\n🔑 <code>${key}</code>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại', callback_data: 'admin_panel' }]] } }).catch(()=>{});
    }
    bot.answerCallbackQuery(query.id).catch(()=>{});
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = msg.from.id; const chatId = msg.chat.id;
    if (userState[userId] === 'WAITING_KEY') {
      delete userState[userId]; const key = msg.text.trim().toUpperCase();
      try {
        const res = await pool.query('SELECT plan, duration_days, activated_at, expires_at FROM keys WHERE key=$1', [key]);
        const row = res.rows[0];
        if (!row) return bot.sendMessage(chatId, '❌ Key không tồn tại.').catch(()=>{});
        const now = Date.now() / 1000; const cfg = PRICES[row.plan] || { label: row.plan };
        if (row.activated_at === null || row.activated_at === undefined) {
          const exp = row.duration_days === null ? null : now + row.duration_days * 86400;
          await pool.query('UPDATE keys SET activated_at=$1, expires_at=$2, is_active=1 WHERE key=$3', [now, exp, key]).catch(()=>{});
          const expStr = exp ? new Date(exp * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn';
          bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 Key: <code>${key}</code>\n📦 Gói: <b>${cfg.label}</b>\n⏰ Hạn dùng: <b>${expStr}</b>`, { parse_mode: 'HTML' }).catch(()=>{});
        } else if (row.duration_days !== null && row.expires_at && now > row.expires_at) {
          bot.sendMessage(chatId, `❌ Key đã <b>hết hạn</b> từ ${new Date(row.expires_at * 1000).toLocaleString('vi-VN')}.`, { parse_mode: 'HTML' }).catch(()=>{});
        } else {
          const expStr = row.expires_at ? new Date(row.expires_at * 1000).toLocaleString('vi-VN') : 'Vĩnh viễn';
          bot.sendMessage(chatId, `ℹ️ Key này <b>đã được kích hoạt trước đó</b>.\n\n🔑 Key: <code>${key}</code>\n📦 Gói: <b>${cfg.label}</b>\n⏰ Hạn: <b>${expStr}</b>`, { parse_mode: 'HTML' }).catch(()=>{});
        }
      } catch (e) { bot.sendMessage(chatId, 'Lỗi Server!').catch(()=>{}); }
    }
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web Server running on port ${PORT}`);
});
