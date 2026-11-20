'use strict';
const crypto = require('node:crypto');
const { COUNTRIES } = require('./scoring');

const SESSION_MS = 60 * 24 * 3600 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(6).toString('hex');
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 18);
const normEmail = (s) => String(s || '').trim().toLowerCase();
const okEmail = (e) => e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

function newSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
  db.prepare('INSERT INTO sessions(hash,user_id,created,expires) VALUES(?,?,?,?)').run(sha(token), userId, now, now + SESSION_MS);
  return token;
}
function userFromToken(db, token) {
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(sha(token), Date.now()) || null;
}
function logout(db, token) { db.prepare('DELETE FROM sessions WHERE hash=?').run(sha(token || '')); }

const fails = new Map(); // email -> [timestamps]; slows down password guessing
function tooManyFails(key) {
  const now = Date.now(), w = (fails.get(key) || []).filter(t => now - t < 15 * 60000);
  fails.set(key, w);
  return w.length >= 6;
}
function noteFail(key) { const w = fails.get(key) || []; w.push(Date.now()); fails.set(key, w); }
setInterval(() => { const n = Date.now(); for (const [k, v] of fails) if (!v.some(t => n - t < 900000)) fails.delete(k); }, 600000).unref();

function pub(u) { return { id: u.id, name: u.name, country: u.country, email: u.email || null }; }

function register(db, b) {
  const email = normEmail(b.email), name = cleanName(b.name), pw = String(b.password || '');
  if (!name) return { code: 400, error: 'name_required' };
  if (!COUNTRIES.includes(b.country)) return { code: 400, error: 'bad_country' };
  if (!okEmail(email)) return { code: 400, error: 'bad_email' };
  if (pw.length < 8 || pw.length > 200) return { code: 400, error: 'weak_password' };
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return { code: 409, error: 'email_taken' };
  const id = rid();
  db.prepare('INSERT INTO users(id,name,country,email,pass_hash,created) VALUES(?,?,?,?,?,?)').run(id, name, b.country, email, hashPassword(pw), Date.now());
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  return { code: 200, token: newSession(db, id), user: pub(u) };
}

function login(db, b) {
  const email = normEmail(b.email), pw = String(b.password || '');
  if (tooManyFails(email)) return { code: 429, error: 'too_many_attempts' };
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  // run a hash even for unknown emails so response time does not reveal which emails exist
  const ok = u && u.pass_hash ? checkPassword(pw, u.pass_hash) : (checkPassword(pw, 'scrypt$00$00'), false);
  if (!ok) { noteFail(email); return { code: 401, error: 'bad_credentials' }; }
  return { code: 200, token: newSession(db, u.id), user: pub(u) };
}

// Google Sign-In: the browser sends an ID token, we ask Google to validate it.
async function google(db, b, clientId) {
  if (!clientId) return { code: 400, error: 'google_disabled' };
  const cred = String(b.credential || '');
  if (!cred || cred.length > 4000) return { code: 400, error: 'bad_token' };
  let info;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
    if (!r.ok) return { code: 401, error: 'bad_token' };
    info = await r.json();
  } catch (e) { return { code: 502, error: 'google_unreachable' }; }
  if (info.aud !== clientId || String(info.email_verified) !== 'true' || !info.sub) return { code: 401, error: 'bad_token' };
  const email = normEmail(info.email);
  let u = db.prepare('SELECT * FROM users WHERE google_sub=?').get(info.sub) || db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (u) {
    if (!u.google_sub) db.prepare('UPDATE users SET google_sub=? WHERE id=?').run(info.sub, u.id);
  } else {
    if (!COUNTRIES.includes(b.country)) return { code: 400, error: 'bad_country' };
    const id = rid();
    db.prepare('INSERT INTO users(id,name,country,email,google_sub,created) VALUES(?,?,?,?,?,?)').run(id, cleanName(b.name || info.given_name || info.name || email.split('@')[0]) || 'لاعب', b.country, email, info.sub, Date.now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  return { code: 200, token: newSession(db, u.id), user: pub(u) };
}

async function sendMail(to, subject, text, log) {
  const key = process.env.RESEND_KEY;
  if (!key) { log('[mail disabled] to=' + to + ' subject=' + subject + '\n' + text); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'Draft Duel <onboarding@resend.dev>', to: [to], subject, text })
    });
    if (!r.ok) log('mail error HTTP ' + r.status);
    return r.ok;
  } catch (e) { log('mail error ' + e.message); return false; }
}

async function forgot(db, b, baseUrl, log) {
  const email = normEmail(b.email);
  const u = okEmail(email) && db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (u) {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO resets(hash,user_id,expires) VALUES(?,?,?)').run(sha(token), u.id, Date.now() + 3600000);
    await sendMail(email, 'استعادة كلمة السر - دراف دويل', 'اضغط الرابط لتعيين كلمة سر جديدة (صالح ساعة):\n' + baseUrl + '/#reset=' + token + '\n\nإذا لم تطلب ذلك تجاهل الرسالة.', log);
  }
  return { code: 200, ok: true }; // same answer whether or not the email exists
}
function reset(db, b) {
  const pw = String(b.password || '');
  if (pw.length < 8 || pw.length > 200) return { code: 400, error: 'weak_password' };
  const r = db.prepare('SELECT * FROM resets WHERE hash=? AND expires>?').get(sha(String(b.token || '')), Date.now());
  if (!r) return { code: 400, error: 'bad_or_expired' };
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(pw), r.user_id);
  db.prepare('DELETE FROM resets WHERE user_id=?').run(r.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id); // sign out everywhere
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.user_id);
  return { code: 200, token: newSession(db, u.id), user: pub(u) };
}

module.exports = { register, login, google, forgot, reset, userFromToken, logout, pub, cleanName };
