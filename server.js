'use strict';
// Draft Duel server. No npm dependencies: Node 22+ only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('./lib/db');
const duel = require('./lib/duel');
const { COUNTRIES, BOLD_RATE } = require('./lib/scoring');
const sync = require('./lib/sync');
const auth_ = require('./lib/auth');
const prof = require('./lib/profile');

try { // tiny .env loader
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (_) {}

const PORT = +process.env.PORT || 3000;
const KEY = process.env.FOOTBALL_DATA_KEY || '';
const LEAGUES = (process.env.LEAGUES || 'PD,SA').split(',');
const ADMIN = process.env.ADMIN_KEY || '';
const DEMO = process.env.DEMO ? process.env.DEMO === '1' : !KEY;
const db = open(process.env.DB_PATH || path.join(__dirname, 'data', 'draft-duel.db'));
const ctx = { db, demo: DEMO };
const log = (m) => console.log(new Date().toISOString() + ' ' + m);

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const hits = new Map(); // naive per-IP rate limit
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 10000); recent.push(now); hits.set(ip, recent);
  return recent.length > 80;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 10000)) hits.delete(k); }, 60000).unref();

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}
function body(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 10000) { no(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } });
    req.on('error', no);
  });
}
function bearer(req) { return (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function auth(req) { return auth_.userFromToken(db, bearer(req)); }
const BASE_URL = process.env.BASE_URL || ('http://localhost:' + PORT);
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || '';

function warBoard() {
  const rows = db.prepare('SELECT country,pts FROM war').all();
  const m = Object.fromEntries(rows.map(r => [r.country, r.pts]));
  return COUNTRIES.map(c => ({ c, v: m[c] || 0 })).sort((a, b) => b.v - a.v);
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/config' && m === 'GET') return json(res, 200, { googleClientId: GOOGLE_ID, countries: COUNTRIES, boldRate: BOLD_RATE, demo: DEMO, picks: duel.PICKS, total: duel.TOTAL, pickMs: duel.PICK_MS, now: Date.now() });
  if (p === '/api/war' && m === 'GET') return json(res, 200, { war: warBoard() });

  const send = (r) => { const { code, ...rest } = r; return json(res, code || 200, rest); };
  if (p === '/api/register' && m === 'POST') return send(auth_.register(db, await body(req)));
  if (p === '/api/login' && m === 'POST') return send(auth_.login(db, await body(req)));
  if (p === '/api/google' && m === 'POST') return send(await auth_.google(db, await body(req), GOOGLE_ID));
  if (p === '/api/forgot' && m === 'POST') return send(await auth_.forgot(db, await body(req), BASE_URL, log));
  if (p === '/api/reset' && m === 'POST') return send(auth_.reset(db, await body(req)));
  if (p === '/api/leaderboard' && m === 'GET') return json(res, 200, { top: prof.leaderboard(db, 20) });
  let pm = p.match(/^\/api\/player\/([a-f0-9]+)$/);
  if (pm && m === 'GET') { const o = prof.profile(db, pm[1], false); return o ? json(res, 200, o) : json(res, 404, { error: 'not_found' }); }

  if (p.startsWith('/api/admin/')) {
    if (!ADMIN || url.searchParams.get('key') !== ADMIN) return json(res, 403, { error: 'forbidden' });
    if (!KEY) return json(res, 400, { error: 'FOOTBALL_DATA_KEY not set' });
    const out = [];
    const L = (x) => { out.push(x); log(x); };
    try {
      if (p === '/api/admin/sync') await sync.syncSquads(ctx, KEY, LEAGUES, L);
      else if (p === '/api/admin/results') await sync.syncResults(ctx, KEY, L);
      else return json(res, 404, { error: 'not_found' });
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { error: String(e.message), log: out }); }
  }

  const u = auth(req);
  if (!u) return json(res, 401, { error: 'unauthorized' });
  const now = Date.now();

  if (p === '/api/me' && m === 'GET') return json(res, 200, { ...auth_.pub(u), current: duel.currentFor(ctx, u.id), now });
  if (p === '/api/logout' && m === 'POST') { auth_.logout(db, bearer(req)); return json(res, 200, { ok: true }); }
  if (p === '/api/profile' && m === 'GET') return json(res, 200, prof.profile(db, u.id, true));
  if (p === '/api/profile' && m === 'POST') {
    const b = await body(req), nm = auth_.cleanName(b.name);
    if (!nm) return json(res, 400, { error: 'name_required' });
    const c = COUNTRIES.includes(b.country) ? b.country : u.country;
    db.prepare('UPDATE users SET name=?, country=? WHERE id=?').run(nm, c, u.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/queue' && m === 'POST') return json(res, 200, duel.joinQueue(ctx, u.id, now));
  if (p === '/api/queue' && m === 'GET') return json(res, 200, duel.pollQueue(ctx, u.id, now));
  if (p === '/api/queue' && m === 'DELETE') { duel.leaveQueue(ctx, u.id); return json(res, 200, { ok: true }); }

  let mm = p.match(/^\/api\/duel\/([a-f0-9]+)$/);
  if (mm && m === 'GET') {
    const v = duel.getDuel(ctx, mm[1], u.id, now);
    return v ? json(res, 200, v) : json(res, 404, { error: 'not_found' });
  }
  mm = p.match(/^\/api\/duel\/([a-f0-9]+)\/(pick|captain)$/);
  if (mm && m === 'POST') {
    const b = await body(req);
    const r = mm[2] === 'pick' ? duel.pick(ctx, mm[1], u.id, String(b.player || ''), now) : duel.setCaptain(ctx, mm[1], u.id, String(b.player || ''), now);
    return json(res, r.code || 200, r);
  }
  return json(res, 404, { error: 'not_found' });
}

function staticFile(req, res, url) {
  let f = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUB, f));
  if (!full.startsWith(PUB + path.sep) && full !== PUB) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress;
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (limited((req.headers['x-forwarded-for'] || ip || '').split(',')[0])) return json(res, 429, { error: 'slow_down' });
      return await api(req, res, url);
    }
    return staticFile(req, res, url);
  } catch (e) {
    log('error ' + (e && e.stack || e));
    if (!res.headersSent) json(res, 500, { error: 'server_error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => log(`Draft Duel on http://localhost:${PORT}  mode=${DEMO ? 'DEMO (simulated results)' : 'LIVE (football-data.org)'}`));
  if (!DEMO && KEY) {
    const tick = async () => {
      try {
        const open = db.prepare("SELECT v FROM meta WHERE k='open_md'").get();
        if (!open) { await sync.syncSquads(ctx, KEY, LEAGUES, log); return; }
        const r = await sync.syncResults(ctx, KEY, log);
        if (r.finished) await sync.syncSquads(ctx, KEY, LEAGUES, log);
      } catch (e) { log('sync error: ' + e.message); }
    };
    tick();
    setInterval(tick, 30 * 60 * 1000).unref();
  }
}
module.exports = { server, ctx };
