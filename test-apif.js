'use strict';
// Offline test of lib/apif.js with mocked API-Football responses (shapes follow the v3 docs).
const assert = require('node:assert');
const { open } = require('./lib/db');
const apif = require('./lib/apif');
const { scoreRow } = require('./lib/scoring');

const LG = { 39: [1, 2, 3, 4, 5, 6], 140: [11, 12, 13, 14, 15, 16], 135: [21, 22, 23, 24] };
const fixtures = []; let fid = 1000;
for (const [lg, ids] of Object.entries(LG)) for (let i = 0; i + 1 < ids.length; i += 2) fixtures.push({ lg: +lg, id: fid++, home: ids[i], away: ids[i + 1] });
const POSN = ['Goalkeeper', 'Goalkeeper', 'Defender', 'Defender', 'Defender', 'Defender', 'Defender', 'Defender', 'Midfielder', 'Midfielder', 'Midfielder', 'Midfielder', 'Midfielder', 'Midfielder', 'Attacker', 'Attacker', 'Attacker', 'Attacker', 'Attacker'];
const squad = (t) => POSN.map((p, i) => ({ id: t * 100 + i, name: 'Name' + t + ' Surname' + i, position: p }));
const fx = (f, st) => ({ fixture: { id: f.id, status: { short: st } }, league: { id: f.lg }, teams: { home: { id: f.home, name: 'T' + f.home }, away: { id: f.away, name: 'T' + f.away } }, goals: { home: 2, away: 0 } });
let calls = 0;
const mock = async (url) => {
  calls++;
  const u = new URL(url); const q = u.searchParams; const p = u.pathname; let r = [];
  if (p === '/fixtures' && q.get('round')) r = fixtures.filter(f => f.lg === +q.get('league')).map(f => fx(f, 'FT'));
  else if (p === '/standings') r = [{ league: { standings: [LG[q.get('league')].map((id, i) => ({ rank: i + 1, team: { id, name: 'T' + id } }))] } }];
  else if (p === '/players/topscorers') r = [];
  else if (p === '/players/squads') r = [{ team: { id: +q.get('team') }, players: squad(+q.get('team')) }];
  else if (p === '/fixtures' && q.get('team')) r = [{ fixture: { id: 1 } }];
  else if (p === '/fixtures/lineups') r = [1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 21, 22, 23, 24].map(t => ({ team: { id: t }, startXI: [0, 2, 3, 8, 9, 14, 15].map(i => ({ player: { id: t * 100 + i } })) }));
  else if (p === '/fixtures' && q.get('id')) r = [fx(fixtures.find(f => f.id === +q.get('id')), 'FT')];
  else if (p === '/fixtures/players') {
    const f = fixtures.find(x => x.id === +q.get('fixture'));
    r = [f.home, f.away].map(t => ({ team: { id: t }, players: [0, 2, 14].map(i => ({ player: { id: t * 100 + i }, statistics: [{ games: { minutes: 90 }, goals: { total: i === 14 && t === f.home ? 1 : 0, assists: 0, saves: i === 0 ? 4 : null }, cards: { yellow: i === 2 ? 1 : 0, red: 0 } }] })) }));
  } else if (p === '/fixtures/events') {
    const f = fixtures.find(x => x.id === +q.get('fixture'));
    r = [{ type: 'Goal', detail: 'Own Goal', player: { id: f.away * 100 + 2 } }];
  }
  return { ok: true, json: async () => ({ errors: [], response: r }) };
};

(async () => {
  const db = open(':memory:'); const ctx = { db, noWait: true }; const logs = [];
  const L = (x) => logs.push(x);
  const o = await apif.syncRound(ctx, 'k', ['PL', 'PD', 'SA'], { season: 2023, replay: true }, L, mock);
  assert.ok(o.opened, 'round opened');
  const act = db.prepare("SELECT * FROM players WHERE active=1 AND id LIKE 'af%'").all();
  const perClub = {}; act.forEach(p => { perClub[p.club] = (perClub[p.club] || 0) + 1; });
  assert.ok(Math.max(...Object.values(perClub)) <= 12, 'max 12 players per club');
  assert.ok(act.length > 100, 'pool size ' + act.length);
  assert.ok(act.some(p => p.pos === 'GK') && act.some(p => p.pos === 'FWD'));
  const gk = act.filter(p => p.club === act[0].club && p.pos === 'GK');
  assert.strictEqual(gk.length, 1, 'one keeper per club kept');
  const md = db.prepare("SELECT v FROM meta WHERE k='open_md'").get().v;
  assert.ok(/PD10-PL10-SA10r2023/.test(md), md);
  const r = await apif.syncResults(ctx, 'k', { replay: true }, L, mock);
  assert.ok(r.finished, 'results complete');
  const own = db.prepare('SELECT * FROM stats WHERE owng>0').all();
  assert.ok(own.length > 0, 'own goal stored');
  const cs = db.prepare('SELECT * FROM stats WHERE cs=1').all(); assert.ok(cs.length > 0, 'clean sheet stored');
  const s = scoreRow({ id: 'x', pos: 'DEF' }, { minutes: 90, goals: 0, assists: 0, cs: 0, saves: 0, yellow: 1, red: 0, owng: 1 }, false, 50);
  assert.strictEqual(s.total, 2 - 2 - 1, 'own goal -2, yellow -1 on 2 appearance points');
  assert.strictEqual(db.prepare("SELECT finished f FROM matchdays WHERE md=?").get(md).f, 1);
  assert.strictEqual(db.prepare("SELECT v FROM meta WHERE k='replay_round'").get().v, '11', 'replay advances');
  console.log('APIF OK  players=' + act.length + '  requests=' + calls);
  console.log(logs.join('\n'));
})().catch(e => { console.error('FAIL', e); process.exit(1); });
