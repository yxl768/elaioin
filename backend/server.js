/*
 * Olive Tree local API server. Run with: node backend/server.js
 * Data and uploaded avatars stay in backend/data and backend/uploads.
 */
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const port = Number(process.env.PORT || 3000);
const root = path.resolve(__dirname);
// 测试使用隔离目录，避免写入真实账户数据。
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const uploadDir = path.join(root, 'uploads');
const dbPath = path.join(dataDir, 'db.json');
const blankDb = () => ({ users: [], tokens: [], codes: [], payments: [], appointments: [], favorites: [], exchangers: [], messages: [] });
let db = blankDb();

async function boot() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(uploadDir, { recursive: true });
  try { db = { ...blankDb(), ...JSON.parse(await fs.readFile(dbPath, 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; await save(); }
}
let saveQueue = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(db, null, 2);
  const write = saveQueue.then(async () => { await fs.writeFile(dbPath + '.tmp', snapshot, 'utf8'); await fs.rename(dbPath + '.tmp', dbPath); });
  saveQueue = write.catch(() => {});
  return write;
}
function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' });
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { send(res, status, { ok: false, message }); }
async function body(req) {
  let raw = ''; for await (const part of req) { raw += part; if (raw.length > 6 * 1024 * 1024) throw new Error('请求体过大'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('请求格式错误'); }
}
function phoneValid(phone) { return /^1\d{10}$/.test(String(phone || '')); }
function tokenFor(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function currentUser(req) {
  const record = db.tokens.find(item => item.token === tokenFor(req) && Date.parse(item.createdAt) + 7 * 86400000 > Date.now());
  return record && db.users.find(user => user.id === record.userId);
}
function publicUser(user) { return { id: user.id, nickname: user.nickname, phone: user.phone, avatarUrl: user.avatarUrl || '', createdAt: user.createdAt }; }
function requireUser(req, res) { const user = currentUser(req); if (!user) { fail(res, 401, '请先登录'); return null; } return user; }
function listFor(collection, user) { return db[collection].filter(item => item.userId === user.id); }
function issueToken(user) {
  db.tokens = db.tokens.filter(item => item.userId !== user.id);
  const token = crypto.randomBytes(32).toString('hex');
  db.tokens.push({ token, userId:user.id, createdAt:now() });
  return token;
}
function requireWechatConfig() {
  if (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET) throw new Error('微信登录尚未配置，请在服务器环境变量设置 WECHAT_APP_ID 与 WECHAT_APP_SECRET');
  const originalId = process.env.WECHAT_APP_ID;
  process.env.WECHAT_APP_ID = originalId.trim();
  process.env.WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET.trim();
  if (originalId !== process.env.WECHAT_APP_ID) console.warn('[微信配置] 已移除 AppID 首尾空白');
  if (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET) throw new Error('微信登录配置为空，请检查启动后端的环境变量');
}
async function wechatJson(url, options) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) }); }
  catch { throw new Error('服务器连接微信超时或失败，请检查服务器网络'); }
  const result = await response.json();
  if (!response.ok || result.errcode) {
    const messages = {40029:'微信登录凭证无效，请重新点击登录，并检查 AppID 是否一致',40163:'微信凭证已使用，请重新点击登录',40013:'服务器 AppID 不正确',40125:'服务器 AppSecret 不正确，请更新后重启后端',48001:'当前小程序未获得该接口权限'};
    // 不记录完整 URL/errmsg，避免泄露其中可能携带的 secret、code 或会话信息。
    const requestPath = new URL(url).pathname;
    const rawCode = String(result.errcode || response.status);
    const safeCode = /^-?\d{1,10}$/.test(rawCode) ? rawCode : 'unknown';
    const rid = typeof result.errmsg === 'string' && result.errmsg.match(/\brid:\s*([a-zA-Z0-9_-]{1,100})/);
    console.warn('[微信接口]', JSON.stringify({path:requestPath,errcode:safeCode,...(rid?{rid:rid[1]}:{})}));
    throw new Error(`${messages[result.errcode] || '微信接口调用失败'}（微信错误码 ${safeCode}）`);
  }
  return result;
}
async function wechatAccessToken() {
  requireWechatConfig();
  return wechatJson(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(process.env.WECHAT_APP_ID)}&secret=${encodeURIComponent(process.env.WECHAT_APP_SECRET)}`);
}
function userForWechat(openId, phone = '') {
  let user = db.users.find(item => item.wechatOpenId === openId) || (phone && db.users.find(item => item.phone === phone));
  if (!user) { user = { id:id('user'), phone, wechatOpenId:openId, nickname:'微信用户', avatarUrl:'', createdAt:now() }; db.users.push(user); }
  if (phone) user.phone = phone;
  if (!user.wechatOpenId) user.wechatOpenId = openId;
  return user;
}

async function sendCode(phone) {
  if (!process.env.SMS_SEND_URL || !process.env.SMS_API_KEY) throw new Error('短信服务尚未开通，请使用微信快捷登录');
  if (db.codes.some(item => item.phone === phone && item.sentAt > Date.now() - 60000)) throw new Error('请在60秒后重新获取验证码');
  const code = String(crypto.randomInt(100000, 1000000));
  db.codes = db.codes.filter(item => item.phone !== phone);
  db.codes.push({ phone, code, sentAt:Date.now(), expiresAt: Date.now() + 5 * 60 * 1000 });
  await save();
  if (process.env.SMS_SEND_URL && process.env.SMS_API_KEY) {
    const response = await fetch(process.env.SMS_SEND_URL, { method: 'POST', signal:AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SMS_API_KEY}` }, body: JSON.stringify({ phone, code }) });
    if (!response.ok) throw new Error('短信发送失败');
    return {};
  }
  console.log(`[开发验证码] ${phone}: ${code}`);
  return process.env.NODE_ENV === 'production' ? {} : { debugCode: code };
}

const features = require('./features');
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (await features({req,res,url,db,save,send,fail,body,requireUser,id,now})) return;
    if (url.pathname.startsWith('/uploads/') && req.method === 'GET') {
      const safeName = path.basename(url.pathname); const file = path.join(uploadDir, safeName);
      const ext = path.extname(file).toLowerCase(); const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'content-type': mime, 'access-control-allow-origin': '*' }); res.end(await fs.readFile(file)); return;
    }
    if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true }); return; }
    if (req.method === 'POST' && url.pathname === '/api/auth/code') {
      const { phone } = await body(req); if (!phoneValid(phone)) return fail(res, 400, '请输入正确手机号');
      send(res, 200, { ok: true, message: '验证码已发送', ...(await sendCode(phone)) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { phone, code, nickname } = await body(req); if (!phoneValid(phone) || !String(nickname || '').trim()) return fail(res, 400, '请完整填写登录信息');
      const match = db.codes.find(item => item.phone === phone && item.code === String(code) && item.expiresAt > Date.now());
      if (!match) return fail(res, 400, '验证码无效或已过期');
      db.codes = db.codes.filter(item => item !== match);
      let user = db.users.find(item => item.phone === phone);
      if (!user) { user = { id: id('user'), phone, nickname: String(nickname).trim(), avatarUrl: '', createdAt: now() }; db.users.push(user); }
      else user.nickname = String(nickname).trim();
      db.tokens = db.tokens.filter(item => item.userId !== user.id); const token = crypto.randomBytes(32).toString('hex'); db.tokens.push({ token, userId: user.id, createdAt: now() }); await save();
      send(res, 200, { ok: true, token, user: publicUser(user) }); return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/wechat') {
      const { code, agreed } = await body(req); if (agreed !== true) return fail(res, 400, '请先阅读并同意协议'); if (typeof code !== 'string' || !code || code.length > 256) return fail(res, 400, '缺少或无效的微信登录凭证');
      requireWechatConfig();
      let projectAppId;
      try { projectAppId = JSON.parse(await fs.readFile(path.join(root, '..', 'project.config.json'), 'utf8')).appid; } catch (_) {}
      console.info('[微信登录配置]', JSON.stringify({pid:process.pid,appId:process.env.WECHAT_APP_ID,length:process.env.WECHAT_APP_ID.length,matchesProject:projectAppId ? projectAppId === process.env.WECHAT_APP_ID : null}));
      const session = await wechatJson(`https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(process.env.WECHAT_APP_ID)}&secret=${encodeURIComponent(process.env.WECHAT_APP_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`);
      if (!session.openid) return fail(res, 502, '微信未返回有效用户标识，请重试');
      const user = userForWechat(session.openid); user.agreementVersion = 'demo-2026-09'; const token = issueToken(user); await save(); send(res, 200, { ok:true, token, user:publicUser(user) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/phone') {
      const { code, agreed } = await body(req); if (agreed !== true) return fail(res, 400, '请先阅读并同意协议'); if (!code) return fail(res, 400, '未获得手机号授权凭证');
      const tokenInfo = await wechatAccessToken();
      const phoneResult = await wechatJson(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(tokenInfo.access_token)}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ code }) });
      const phone = phoneResult.phone_info && phoneResult.phone_info.purePhoneNumber;
      if (!phoneValid(phone)) return fail(res, 400, '未能获取有效手机号');
      let user = db.users.find(item => item.phone === phone);
      if (!user) { user = { id:id('user'), phone, nickname:`用户${phone.slice(-4)}`, avatarUrl:'', createdAt:now() }; db.users.push(user); }
      const token = issueToken(user); await save(); send(res, 200, { ok:true, token, user:publicUser(user) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { db.tokens = db.tokens.filter(item => item.token !== tokenFor(req)); await save(); send(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && url.pathname === '/api/me') { const user = requireUser(req, res); if (user) send(res, 200, { ok: true, user: publicUser(user) }); return; }
    if (req.method === 'PATCH' && url.pathname === '/api/me') {
      const user = requireUser(req, res); if (!user) return; const { nickname } = await body(req); if (!String(nickname || '').trim()) return fail(res, 400, '昵称不能为空'); user.nickname = String(nickname).trim(); await save(); send(res, 200, { ok: true, user: publicUser(user) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/me/avatar') {
      const user = requireUser(req, res); if (!user) return; const { data, fileName = 'avatar.jpg' } = await body(req);
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(String(data || ''))) return fail(res, 400, '请选择图片头像');
      const extension = path.extname(fileName).toLowerCase().match(/^\.(jpg|jpeg|png|webp)$/) ? path.extname(fileName).toLowerCase() : '.jpg';
      const name = `${user.id}-${Date.now()}${extension}`; await fs.writeFile(path.join(uploadDir, name), Buffer.from(data.split(',')[1], 'base64'));
      user.avatarUrl = `/uploads/${name}`; await save(); send(res, 200, { ok: true, user: publicUser(user) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/payments') { const user = requireUser(req, res); if (user) send(res, 200, { ok: true, items: listFor('payments', user) }); return; }
    if (req.method === 'POST' && url.pathname === '/api/payments') { const user = requireUser(req, res); if (!user) return; const { amount, title = '学习服务' } = await body(req); if (!(Number(amount) > 0)) return fail(res, 400, '请输入正确金额'); const item = { id: id('pay'), userId: user.id, title: String(title), amount: Number(amount), status: '沙箱演示已支付', createdAt: now() }; db.payments.unshift(item); await save(); send(res, 201, { ok: true, item }); return; }
    if (req.method === 'GET' && url.pathname === '/api/appointments') { const user = requireUser(req, res); if (user) send(res, 200, { ok: true, items: listFor('appointments', user) }); return; }
    if (req.method === 'POST' && url.pathname === '/api/appointments') { const user = requireUser(req, res); if (!user) return; const { teacherName, note = '' } = await body(req); if (!String(teacherName || '').trim()) return fail(res, 400, '请选择交流者'); const item = { id: id('appointment'), userId: user.id, teacherName: String(teacherName), note: String(note), status: '待确认', createdAt: now() }; db.appointments.unshift(item); await save(); send(res, 201, { ok: true, item }); return; }
    if (req.method === 'GET' && url.pathname === '/api/favorites') { const user = requireUser(req, res); if (user) send(res, 200, { ok: true, items: listFor('favorites', user) }); return; }
    if (req.method === 'POST' && url.pathname === '/api/favorites/toggle') { const user = requireUser(req, res); if (!user) return; const { teacherName } = await body(req); if (!String(teacherName || '').trim()) return fail(res, 400, '请选择交流者'); const old = db.favorites.find(item => item.userId === user.id && item.teacherName === teacherName); if (old) db.favorites = db.favorites.filter(item => item !== old); else db.favorites.unshift({ id: id('favorite'), userId: user.id, teacherName: String(teacherName), createdAt: now() }); await save(); send(res, 200, { ok: true, active: !old }); return; }
    if (req.method === 'POST' && url.pathname === '/api/exchangers') { const user = requireUser(req, res); if (!user) return; const { idCardName, studentIdName, phone } = await body(req); if (!phoneValid(phone) || !idCardName || !studentIdName) return fail(res, 400, '请完整填写认证信息'); const old = db.exchangers.find(item => item.userId === user.id); const item = { id: old?.id || id('exchanger'), userId: user.id, idCardName, studentIdName, phone, status: '已提交', updatedAt: now() }; db.exchangers = old ? db.exchangers.map(entry => entry === old ? item : entry) : [item, ...db.exchangers]; await save(); send(res, 201, { ok: true, item }); return; }
    fail(res, 404, '接口不存在');
  } catch (error) { console.error('[API]', error.message); fail(res, 500, error.message || '服务器错误'); }
});

if (require.main === module) boot().then(() => server.listen(port, () => console.log(`Olive Tree API running at http://127.0.0.1:${port}`))).catch(error => { console.error('启动失败：', error.message); process.exitCode = 1; });
module.exports = { server, boot };
