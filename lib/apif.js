'use strict';
// Data provider: API-Football (https://www.api-football.com, v3). Leagues: Premier League 39, LaLiga 140, Serie A 135.
// Free plan: 100 requests/day, seasons 2022-2024 only. Paid plans unlock the current season: only SEASON/REPLAY change.
// Written against the v3 docs; every response shape is covered by test-apif.js with mocked responses,
// but it has not been run against the live service from the build environment (no internet there).
const { tx } = require('./db');
const BASE = 'https://v3.football.api-sports.io';
const LEAGUE_ID = { PL: 39, PD: 140, SA: 135 };
const DAILY_LIMIT = 95;          // keep a few requests spare on the 100/day free plan
const MATCHES_PER_LEAGUE = 3;    // best matches of the round per league
const KEEP = { GK: 1, DEF: 4, MID: 4, FWD: 3 }; // players kept per club, best first (keeps bench fillers out)

const POS = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Attacker: 'FWD' };
const today = () => new Date().toISOString().slice(0, 10);

function makeClient(ctx, key, fetchImpl) {
  const f = fetchImpl || fetch;
  let last = 0;
  const metaGet = (k) => ctx.db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v;
  const metaSet = (k, v) => ctx.db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
  return async function get(path) {
    const [day, n] = String(metaGet('apif_day') || '').split(':');
    const used = day === today() ? +n || 0 : 0;
    if (used >= DAILY_LIMIT) throw new Error('daily request budget used (' + used + '). Resumes tomorrow.');
    metaSet('apif_day', today() + ':' + (used + 1));
    const wait = Math.max(0, last + 6500 - Date.now()); // 10 requests/minute on the free plan
    if (wait && !ctx.noWait) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const res = await f(BASE + path, { headers: { 'x-apisports-key': key } });
    if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
    const j = await res.json();
    const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
    if (errs && errs.length) throw new Error(path + ' -> ' + errs.join('; '));
    return j.response || [];
  };
}

// Which round is "this week" for a league. Live: the current round. Replay (free plan, old season): meta replay_round.
async function roundName(ctx, get, lg, season, replay) {
  if (replay) {
    const n = +(ctx.db.prepare("SELECT v FROM meta WHERE k='replay_round'").get()?.v || process.env.REPLAY_START || 10);
    return { name: 'Regular Season - ' + n, num: n };
  }
  const r = await get(`/fixtures/rounds?league=${LEAGUE_ID[lg]}&season=${season}&current=true`);
  const name = r[0];
  return { name, num: +String(name).replace(/\D+/g, '') || 0 };
}

// Picks the strongest matches of the round using the league table, loads squads and who started last time,
// and opens the round. Players of clubs that are not in the chosen matches are switched off.
async function syncRound(ctx, key, leagues, opts, log, fetchImpl) {
  const { season, replay } = opts;
  const get = makeClient(ctx, key, fetchImpl);
  const { db } = ctx;
  const parts = {}, chosen = []; // chosen: {lg, fix}
  const rank = {};
  for (const lg of leagues) {
    const rn = await roundName(ctx, get, lg, season, replay);
    const fx = await get(`/fixtures?league=${LEAGUE_ID[lg]}&season=${season}&round=${encodeURIComponent(rn.name)}`);
    const open = fx.filter(x => replay || ['NS', 'TBD'].includes(x.fixture.status.short));
    if (open.length < 2) { log(lg + ': fewer than 2 open matches, skipped'); continue; }
    const st = await get(`/standings?league=${LEAGUE_ID[lg]}&season=${season}`);
    const table = (st[0] && st[0].league && st[0].league.standings && st[0].league.standings[0]) || [];
    table.forEach(r => { rank[r.team.id] = r.rank; });
    const size = table.length || 20;
    const score = (x) => (size + 1 - (rank[x.teams.home.id] || size)) + (size + 1 - (rank[x.teams.away.id] || size));
    open.sort((a, b) => score(b) - score(a));
    open.slice(0, MATCHES_PER_LEAGUE).forEach(x => chosen.push({ lg, fix: x }));
    parts[lg] = rn.num;
  }
  if (!chosen.length) return { opened: false };

  const teams = new Map(); // teamId -> {name, lg}
  chosen.forEach(({ lg, fix }) => { teams.set(fix.teams.home.id, { name: fix.teams.home.name, lg }); teams.set(fix.teams.away.id, { name: fix.teams.away.name, lg }); });

  const up = db.prepare(`INSERT INTO players(id,first,last,pos,club,league,weight,active) VALUES(?,?,?,?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET club=excluded.club,pos=excluded.pos,league=excluded.league,weight=excluded.weight`);
  const scorers = {};
  for (const lg of leagues) {
    if (!parts[lg]) continue;
    try {
      const ts = await get(`/players/topscorers?league=${LEAGUE_ID[lg]}&season=${season}`);
      ts.forEach(x => { const s = x.statistics && x.statistics[0]; scorers[x.player.id] = ((s && s.goals && s.goals.total) || 0) + (((s && s.goals && s.goals.assists) || 0) * 0.6); });
    } catch (e) { log('topscorers ' + lg + ' skipped: ' + e.message); }
  }
  const keepIds = new Set();
  for (const [tid, t] of teams) {
    const sq = await get(`/players/squads?team=${tid}`);
    const list = (sq[0] && sq[0].players) || [];
    let started = new Set();
    try { // starters in the team's latest finished match: marks real regulars
      const last = await get(`/fixtures?team=${tid}&season=${season}&last=1`);
      if (last[0]) {
        const lu = await get(`/fixtures/lineups?fixture=${last[0].fixture.id}`);
        const mine = lu.find(l => l.team && l.team.id === tid);
        (mine && mine.startXI || []).forEach(p => started.add(p.player.id));
      }
    } catch (e) { log('lineup ' + t.name + ' skipped: ' + e.message); }
    const rows = list.map(p => {
      const pos = POS[p.position]; if (!pos) return null;
      const w = (started.has(p.id) ? 14 : 4) + (scorers[p.id] || 0) * 3;
      return { p, pos, w };
    }).filter(Boolean);
    const per = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    rows.sort((a, b) => b.w - a.w);
    tx(db, () => {
      for (const r of rows) {
        if (per[r.pos] >= KEEP[r.pos]) continue;
        per[r.pos]++;
        const parts2 = String(r.p.name || '').split(' ');
        const last = parts2.length > 1 ? parts2.slice(1).join(' ') : parts2[0];
        up.run('af' + r.p.id, parts2.length > 1 ? parts2[0] : '', last, r.pos, t.name, t.lg, r.w);
        keepIds.add('af' + r.p.id);
      }
    });
  }
  const mdKey = Object.keys(parts).sort().map(k => k + parts[k]).join('-') + (replay ? 'r' + season : '');
  const fixtures = chosen.map(c => ({ lg: c.lg, id: c.fix.fixture.id, home: c.fix.teams.home.id, away: c.fix.teams.away.id }));
  tx(db, () => {
    db.prepare("UPDATE players SET active=0 WHERE id LIKE 'af%'").run();
    const on = db.prepare('UPDATE players SET active=1 WHERE id=?');
    keepIds.forEach(id => on.run(id));
    const put = (k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
    put('open_md', mdKey); put('open_md_parts', JSON.stringify(parts)); put('open_fixtures', JSON.stringify(fixtures));
    db.prepare('INSERT OR IGNORE INTO matchdays(md,finished) VALUES(?,0)').run(mdKey);
  });
  log('open round ' + mdKey + ': ' + chosen.length + ' matches, ' + keepIds.size + ' players');
  return { opened: true, md: mdKey, matches: chosen.length, players: keepIds.size };
}

// Reads per-player stats and events of the chosen matches. Own goals and cards come from events, minutes/saves/assists from players.
async function syncResults(ctx, key, opts, log, fetchImpl) {
  const { db } = ctx;
  const mdKey = db.prepare("SELECT v FROM meta WHERE k='open_md'").get()?.v;
  const fixtures = JSON.parse(db.prepare("SELECT v FROM meta WHERE k='open_fixtures'").get()?.v || 'null');
  if (!mdKey || !fixtures) return { finished: false, reason: 'no open round' };
  const get = makeClient(ctx, key, fetchImpl);
  const done = JSON.parse(db.prepare("SELECT v FROM meta WHERE k='done_fixtures'").get()?.v || '{}');
  const row = new Map();
  const R = (id) => { if (!row.has(id)) row.set(id, { minutes: 0, goals: 0, assists: 0, cs: 0, saves: 0, yellow: 0, red: 0, owng: 0 }); return row.get(id); };
  let all = true;
  for (const f of fixtures) {
    if (done[mdKey + ':' + f.id]) continue;
    const head = await get(`/fixtures?id=${f.id}`);
    const st = head[0] && head[0].fixture.status.short;
    if (!['FT', 'AET', 'PEN'].includes(st)) { all = false; continue; }
    const conceded = { [head[0].teams.home.id]: head[0].goals.away, [head[0].teams.away.id]: head[0].goals.home };
    const pl = await get(`/fixtures/players?fixture=${f.id}`);
    for (const t of pl) {
      for (const x of t.players || []) {
        const s = x.statistics && x.statistics[0]; if (!s) continue;
        const min = (s.games && s.games.minutes) || 0; if (!min) continue;
        const r = R('af' + x.player.id);
        r.minutes = min; r.goals = (s.goals && s.goals.total) || 0; r.assists = (s.goals && s.goals.assists) || 0;
        r.saves = (s.goals && s.goals.saves) || 0;
        r.cs = conceded[t.team.id] === 0 && min >= 60 ? 1 : 0;
        r.yellow = (s.cards && s.cards.yellow) || 0; r.red = (s.cards && s.cards.red) || 0;
      }
    }
    const ev = await get(`/fixtures/events?fixture=${f.id}`);
    for (const e of ev) {
      if (e.type === 'Goal' && e.detail === 'Own Goal' && e.player) { const r = R('af' + e.player.id); r.owng++; r.minutes = Math.max(r.minutes, 1); }
    }
    done[mdKey + ':' + f.id] = 1;
  }
  tx(db, () => {
    const has = db.prepare('SELECT 1 FROM players WHERE id=?');
    const ins = db.prepare('INSERT INTO stats(md,player_id,minutes,goals,assists,cs,saves,yellow,red,owng) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(md,player_id) DO UPDATE SET minutes=excluded.minutes,goals=excluded.goals,assists=excluded.assists,cs=excluded.cs,saves=excluded.saves,yellow=excluded.yellow,red=excluded.red,owng=excluded.owng');
    for (const [pid, r] of row) if (has.get(pid)) ins.run(mdKey, pid, r.minutes, r.goals, r.assists, r.cs, r.saves, r.yellow, r.red, r.owng);
    db.prepare("INSERT INTO meta(k,v) VALUES('done_fixtures',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(done));
    if (all) db.prepare('UPDATE matchdays SET finished=1 WHERE md=?').run(mdKey);
  });
  if (all && opts && opts.replay) { // replay: next real round becomes the new open round
    const n = +(db.prepare("SELECT v FROM meta WHERE k='replay_round'").get()?.v || process.env.REPLAY_START || 10) + 1;
    db.prepare("INSERT INTO meta(k,v) VALUES('replay_round',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(n));
  }
  log('results for ' + mdKey + ': ' + (all ? 'complete' : 'some matches not finished'));
  return { finished: all, rows: row.size };
}

module.exports = { syncRound, syncResults, LEAGUE_ID };
