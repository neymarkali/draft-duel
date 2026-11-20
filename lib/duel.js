'use strict';
const crypto = require('node:crypto');
const { tx } = require('./db');
const { scoreRow, simulateStats, COUNTRIES } = require('./scoring');

const PICKS = 5, TOTAL = 10, PICK_MS = 20000, GRACE_MS = 2500, CAPTAIN_MS = 30000, BOT_WAIT_MS = 8000;
const SNAKE = [0, 1, 1, 0, 0, 1, 1, 0, 0, 1]; // index into [first, second]
const BOT_NAMES = ['Zizo_10','NapoliKing','LaMasia_9','TacticoAli','Dribbler7','Il_Capitano','Bernabeu_Boy','Falcon_SA','Atlas_Lion','Cedar_FC','Samba_Nine','GolHunter','NorthStand','FalseNine','LastMinute90'];
const rid = () => crypto.randomBytes(6).toString('hex');
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

// pick rate in percent, with a prior so new players start in a sensible range
function pickRate(p) {
  const prior = 0.3 + 0.4 * Math.min(60, p.weight) / 60;
  const k = 10;
  return Math.round(100 * (p.picked + prior * k) / (p.appear + k));
}

function weightedSample(list, n) {
  const pool = list.slice(), out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((a, p) => a + Math.max(1, p.weight), 0);
    let r = Math.random() * total, i = 0;
    for (; i < pool.length; i++) { r -= Math.max(1, pool[i].weight); if (r <= 0) break; }
    out.push(pool.splice(Math.min(i, pool.length - 1), 1)[0]);
  }
  return out;
}

function createDuel(ctx, p1, p2, now) {
  const { db } = ctx;
  const md = db.prepare("SELECT v FROM meta WHERE k='open_md'").get()?.v || 'DEMO';
  const act = db.prepare('SELECT * FROM players WHERE active=1').all();
  const take = (pos, n) => weightedSample(act.filter(p => p.pos === pos), n);
  const pool = [...take('GK', 2), ...take('DEF', 3), ...take('MID', 4), ...take('FWD', 5)];
  const flip = Math.random() < 0.5;
  const order = SNAKE.map(i => (i === 0) === flip ? 'p1' : 'p2');
  const data = { pool: pool.map(p => p.id), order, picks: { p1: [], p2: [] }, turn: 0, deadline: now + PICK_MS + GRACE_MS, botAt: now + 1500, captain: { p1: null, p2: null }, result: null };
  const id = rid();
  const bot = p2 === null;
  db.prepare('INSERT INTO duels(id,p1,p2,bot_name,bot_country,md,status,data,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, p1, p2, bot ? rnd(BOT_NAMES) : null, bot ? rnd(COUNTRIES) : null, md, 'drafting', JSON.stringify(data), now, now);
  const upd = db.prepare('UPDATE players SET appear=appear+1 WHERE id=?');
  for (const p of pool) upd.run(p.id);
  return id;
}

function load(ctx, id) {
  const r = ctx.db.prepare('SELECT * FROM duels WHERE id=?').get(id);
  if (!r) return null;
  r.data = JSON.parse(r.data);
  return r;
}
function save(ctx, d, now) {
  ctx.db.prepare('UPDATE duels SET status=?, data=?, updated=? WHERE id=?').run(d.status, JSON.stringify(d.data), now, d.id);
}

function playersById(ctx, ids) {
  const q = ctx.db.prepare('SELECT * FROM players WHERE id=?');
  return ids.map(i => q.get(i)).filter(Boolean);
}

function doPick(ctx, d, who, pid, now) {
  const D = d.data;
  if (d.status !== 'drafting' || D.order[D.turn] !== who) return false;
  if (!D.pool.includes(pid) || D.picks.p1.includes(pid) || D.picks.p2.includes(pid)) return false;
  D.picks[who].push(pid);
  D.turn++;
  ctx.db.prepare('UPDATE players SET picked=picked+1 WHERE id=?').run(pid);
  D.deadline = now + PICK_MS + GRACE_MS;
  D.botAt = now + 1100 + Math.random() * 1400;
  if (D.turn >= TOTAL) { d.status = 'captain'; D.deadline = now + CAPTAIN_MS; autoBotCaptain(ctx, d); }
  return true;
}

function available(ctx, d) {
  const D = d.data, taken = new Set([...D.picks.p1, ...D.picks.p2]);
  return playersById(ctx, D.pool.filter(i => !taken.has(i)));
}

function botChoice(ctx, d, who) {
  const av = available(ctx, d);
  const mine = playersById(ctx, d.data.picks[who]);
  const has = {}; mine.forEach(p => { has[p.pos] = (has[p.pos] || 0) + 1; });
  const bold = Math.random() < 0.3;
  let best = null, bw = -1;
  for (const p of av) {
    const rate = pickRate(p);
    let w = bold ? (100 - rate) * (0.5 + Math.random()) : Math.pow(rate, 1.1) * (0.6 + Math.random() * 0.8);
    if (p.pos === 'GK' && has.GK) w *= 0.15;
    if (p.pos === 'DEF' && has.DEF >= 2) w *= 0.5;
    if (w > bw) { bw = w; best = p; }
  }
  return best;
}

function topByRate(ctx, ids) {
  return playersById(ctx, ids).sort((a, b) => pickRate(b) - pickRate(a));
}

function autoBotCaptain(ctx, d) {
  if (d.p2 !== null) return;
  const s = topByRate(ctx, d.data.picks.p2);
  d.data.captain.p2 = (Math.random() < 0.7 ? s[0] : s[1] || s[0]).id;
}

// Moves a duel forward based on time. Called on every read, so no background timer is needed.
function advance(ctx, d, now) {
  const D = d.data;
  let changed = false;
  while (d.status === 'drafting' && D.turn < TOTAL) {
    const who = D.order[D.turn];
    const isBot = who === 'p2' && d.p2 === null;
    if (isBot && now >= D.botAt) {
      const p = botChoice(ctx, d, who);
      if (!p || !doPick(ctx, d, who, p.id, now)) break;
      changed = true; continue;
    }
    if (!isBot && now > D.deadline) {
      const av = available(ctx, d).sort((a, b) => pickRate(b) - pickRate(a));
      if (!av.length || !doPick(ctx, d, who, av[0].id, now)) break;
      changed = true; continue;
    }
    break;
  }
  if (d.status === 'captain') {
    if (now > D.deadline) {
      for (const w of ['p1', 'p2']) if (!D.captain[w]) { D.captain[w] = topByRate(ctx, D.picks[w])[0].id; changed = true; }
    }
    if (D.captain.p1 && D.captain.p2) { d.status = 'live'; changed = true; }
  }
  if (d.status === 'live') {
    const demo = ctx.demo || d.md === 'DEMO';
    const fin = ctx.db.prepare('SELECT finished FROM matchdays WHERE md=?').get(d.md)?.finished;
    if (demo || fin) { settle(ctx, d, now); changed = true; }
  }
  if (changed) save(ctx, d, now);
  return d;
}

function settle(ctx, d, now) {
  const D = d.data;
  const rows = {};
  if (d.md === 'DEMO' || ctx.demo) {
    // demo mode: invent stats for the players in this duel, once, and keep them so both sides share a result
    for (const p of playersById(ctx, [...D.picks.p1, ...D.picks.p2])) rows[p.id] = simulateStats(p);
  } else {
    const q = ctx.db.prepare('SELECT * FROM stats WHERE md=? AND player_id=?');
    for (const id of [...D.picks.p1, ...D.picks.p2]) rows[id] = q.get(d.md, id);
  }
  const res = {};
  for (const w of ['p1', 'p2']) {
    res[w] = playersById(ctx, D.picks[w]).map(p => scoreRow(p, rows[p.id], D.captain[w] === p.id, pickRate(p)));
  }
  const a = res.p1.reduce((s, r) => s + r.total, 0), b = res.p2.reduce((s, r) => s + r.total, 0);
  D.result = { p1: res.p1, p2: res.p2, a, b };
  d.status = 'done';
  const bump = ctx.db.prepare('INSERT INTO war(country,pts) VALUES(?,?) ON CONFLICT(country) DO UPDATE SET pts=pts+excluded.pts');
  const rec = ctx.db.prepare('INSERT OR IGNORE INTO results(duel_id,user_id,opp_name,opp_country,mine,theirs,outcome,md,ts,bold_n,best_pts,best_player) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const name = (id) => ctx.db.prepare('SELECT name,country FROM users WHERE id=?').get(id);
  const best = (side) => res[side].slice().sort((x, y) => y.total - x.total)[0];
  const addFor = (uid, side, mine, theirs, oppSide) => {
    if (!uid) return;
    const u = name(uid);
    if (!u) return;
    const outcome = mine > theirs ? 'win' : mine === theirs ? 'draw' : 'loss';
    bump.run(u.country, outcome === 'win' ? 10 : outcome === 'draw' ? 5 : 2);
    const o = d[oppSide] ? name(d[oppSide]) : { name: d.bot_name, country: d.bot_country };
    const bp = best(side), bpl = ctx.db.prepare('SELECT last FROM players WHERE id=?').get(bp.id);
    rec.run(d.id, uid, o.name, o.country, mine, theirs, outcome, d.md, now, res[side].filter(r => r.bold).length, bp.total, bpl ? bpl.last : null);
  };
  addFor(d.p1, 'p1', a, b, 'p2'); addFor(d.p2, 'p2', b, a, 'p1');
}

function view(ctx, d, uid) {
  const D = d.data;
  const me = d.p1 === uid ? 'p1' : 'p2', opp = me === 'p1' ? 'p2' : 'p1';
  const ids = D.pool;
  const taken = {};
  D.picks.p1.forEach(i => taken[i] = me === 'p1' ? 'me' : 'opp');
  D.picks.p2.forEach(i => taken[i] = me === 'p2' ? 'me' : 'opp');
  const pool = playersById(ctx, ids).map(p => ({ id: p.id, f: p.first, s: p.last, p: p.pos, c: p.club, l: p.league, o: pickRate(p), t: taken[p.id] || null }));
  const user = id => id ? ctx.db.prepare('SELECT name,country FROM users WHERE id=?').get(id) : null;
  const meU = user(uid), oppId = d[opp];
  const oppU = oppId ? user(oppId) : { name: d.bot_name, country: d.bot_country };
  const rel = x => (x === me ? 'me' : 'opp');
  const out = {
    id: d.id, status: d.status, md: d.md, now: Date.now(),
    me: meU, opp: oppU, pool, turn: D.turn, total: TOTAL, picksPer: PICKS,
    order: D.order.map(rel), deadline: D.deadline,
    picks: { me: D.picks[me], opp: D.picks[opp] },
    captain: { me: D.captain[me], opp: d.status === 'drafting' || d.status === 'captain' ? null : D.captain[opp] }
  };
  if (d.status === 'done') {
    const R = D.result;
    out.result = { me: R[me], opp: R[opp], a: me === 'p1' ? R.a : R.b, b: me === 'p1' ? R.b : R.a };
  }
  return out;
}

function currentFor(ctx, uid) {
  return ctx.db.prepare("SELECT id FROM duels WHERE (p1=? OR p2=?) ORDER BY created DESC LIMIT 1").get(uid, uid)?.id || null;
}

// matchmaking
function joinQueue(ctx, uid, now) {
  return tx(ctx.db, () => {
    let mine = ctx.db.prepare('SELECT * FROM queue WHERE user_id=?').get(uid);
    if (mine && now - mine.since > 120000) { ctx.db.prepare('DELETE FROM queue WHERE user_id=?').run(uid); mine = null; }
    if (mine && mine.duel) return { status: 'matched', duel: mine.duel };
    if (mine) return { status: 'waiting' };
    const other = ctx.db.prepare('SELECT * FROM queue WHERE duel IS NULL AND user_id<>? AND since>? ORDER BY since LIMIT 1').get(uid, now - 60000);
    if (other) {
      const id = createDuel(ctx, other.user_id, uid, now);
      ctx.db.prepare('UPDATE queue SET duel=? WHERE user_id=?').run(id, other.user_id);
      ctx.db.prepare('INSERT INTO queue(user_id,since,duel) VALUES(?,?,?)').run(uid, now, id);
      return { status: 'matched', duel: id };
    }
    ctx.db.prepare('INSERT INTO queue(user_id,since) VALUES(?,?)').run(uid, now);
    return { status: 'waiting' };
  });
}
function pollQueue(ctx, uid, now) {
  return tx(ctx.db, () => {
    const mine = ctx.db.prepare('SELECT * FROM queue WHERE user_id=?').get(uid);
    if (!mine) return { status: 'idle' };
    if (mine.duel) { ctx.db.prepare('DELETE FROM queue WHERE user_id=?').run(uid); return { status: 'matched', duel: mine.duel }; }
    if (now - mine.since >= BOT_WAIT_MS) {
      const id = createDuel(ctx, uid, null, now);
      ctx.db.prepare('DELETE FROM queue WHERE user_id=?').run(uid);
      return { status: 'matched', duel: id, bot: true };
    }
    return { status: 'waiting' };
  });
}
function leaveQueue(ctx, uid) { ctx.db.prepare('DELETE FROM queue WHERE user_id=? AND duel IS NULL').run(uid); }

function pick(ctx, duelId, uid, pid, now) {
  return tx(ctx.db, () => {
    const d = load(ctx, duelId);
    if (!d || (d.p1 !== uid && d.p2 !== uid)) return { error: 'not_found', code: 404 };
    advance(ctx, d, now);
    const who = d.p1 === uid ? 'p1' : 'p2';
    const ok = doPick(ctx, d, who, pid, now);
    advance(ctx, d, now);
    save(ctx, d, now);
    return ok ? { ok: true } : { error: 'cannot_pick', code: 409 };
  });
}
function setCaptain(ctx, duelId, uid, pid, now) {
  return tx(ctx.db, () => {
    const d = load(ctx, duelId);
    if (!d || (d.p1 !== uid && d.p2 !== uid)) return { error: 'not_found', code: 404 };
    advance(ctx, d, now);
    const who = d.p1 === uid ? 'p1' : 'p2';
    if (d.status !== 'captain' || !d.data.picks[who].includes(pid) || d.data.captain[who]) return { error: 'cannot_set', code: 409 };
    d.data.captain[who] = pid;
    advance(ctx, d, now);
    save(ctx, d, now);
    return { ok: true };
  });
}
function getDuel(ctx, duelId, uid, now) {
  return tx(ctx.db, () => {
    const d = load(ctx, duelId);
    if (!d || (d.p1 !== uid && d.p2 !== uid)) return null;
    advance(ctx, d, now);
    return view(ctx, d, uid);
  });
}

module.exports = { joinQueue, pollQueue, leaveQueue, pick, setCaptain, getDuel, currentFor, pickRate, advance, load, PICKS, TOTAL, PICK_MS };
