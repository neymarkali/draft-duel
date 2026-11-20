'use strict';
// Free data from football-data.org (https://www.football-data.org). Needs a free API key.
// Free tier: 10 requests/minute, top competitions including PD (LaLiga) and SA (Serie A).
// IMPORTANT: this module was written against the public v4 docs and has not been run
// against the live API. Fields the free tier does not return are handled defensively.
const { tx } = require('./db');
const BASE = 'https://api.football-data.org/v4';

function posOf(s) {
  s = String(s || '').toLowerCase();
  if (s.includes('goal')) return 'GK';
  if (s.includes('back') || s.includes('defen')) return 'DEF';
  if (s.includes('mid')) return 'MID';
  if (s.includes('forward') || s.includes('offen') || s.includes('winger') || s.includes('striker')) return 'FWD';
  return null;
}

function makeClient(key, log) {
  let last = 0;
  return async function get(path) {
    const wait = Math.max(0, last + 6500 - Date.now()); // stay under 10 requests/minute
    if (wait) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(BASE + path, { headers: { 'X-Auth-Token': key } });
    if (res.status === 429) throw new Error('rate limited by football-data.org, try again in a minute');
    if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
    return res.json();
  };
}

// Squads, current matchday and top scorers (used as selection weight).
async function syncSquads(ctx, key, leagues, log) {
  const get = makeClient(key);
  const { db } = ctx;
  const up = db.prepare(`INSERT INTO players(id,first,last,pos,club,league,weight,active) VALUES(?,?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET club=excluded.club,pos=excluded.pos,league=excluded.league,weight=excluded.weight,active=1`);
  let count = 0;
  const openClubs = new Set();
  let openMd = null;
  for (const lg of leagues) {
    const comp = await get(`/competitions/${lg}`);
    const md = comp.currentSeason && comp.currentSeason.currentMatchday;
    const teams = await get(`/competitions/${lg}/teams`);
    let scorers = {};
    try {
      const s = await get(`/competitions/${lg}/scorers?limit=60`);
      (s.scorers || []).forEach(x => { scorers[x.player.id] = (x.goals || 0) + (x.assists || 0) * 0.6; });
    } catch (e) { log('scorers skipped: ' + e.message); }
    tx(db, () => {
      for (const t of teams.teams || []) {
        for (const p of t.squad || []) {
          const pos = posOf(p.position);
          if (!pos) continue;
          const parts = String(p.name || '').split(' ');
          const last = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
          const w = 8 + (scorers[p.id] || 0) * 3;
          up.run('fd' + p.id, parts.length > 1 ? parts[0] : '', last, pos, t.shortName || t.name, lg, w);
          count++;
        }
      }
    });
    if (md) {
      const ms = await get(`/competitions/${lg}/matches?matchday=${md}`);
      const upcoming = (ms.matches || []).filter(m => m.status === 'TIMED' || m.status === 'SCHEDULED');
      if (upcoming.length) {
        upcoming.forEach(m => { openClubs.add(m.homeTeam.shortName || m.homeTeam.name); openClubs.add(m.awayTeam.shortName || m.awayTeam.name); });
        openMd = openMd || {};
        openMd[lg] = md;
      }
    }
  }
  if (openMd) {
    const mdKey = Object.keys(openMd).sort().map(k => k + openMd[k]).join('-');
    tx(db, () => {
      db.prepare('UPDATE players SET active=0 WHERE league IN (' + leagues.map(() => '?').join(',') + ')').run(...leagues);
      const on = db.prepare('UPDATE players SET active=1 WHERE club=?');
      openClubs.forEach(c => on.run(c));
      db.prepare("INSERT INTO meta(k,v) VALUES('open_md',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(mdKey);
      db.prepare('INSERT OR IGNORE INTO matchdays(md,finished) VALUES(?,0)').run(mdKey);
      db.prepare("INSERT INTO meta(k,v) VALUES('open_md_parts',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(openMd));
    });
    log('open matchday ' + mdKey);
  }
  log('synced ' + count + ' players');
  return count;
}

// Reads finished matches of the open matchday and writes one stats row per player who took part.
async function syncResults(ctx, key, log) {
  const { db } = ctx;
  const mdKey = db.prepare("SELECT v FROM meta WHERE k='open_md'").get()?.v;
  const parts = JSON.parse(db.prepare("SELECT v FROM meta WHERE k='open_md_parts'").get()?.v || 'null');
  if (!mdKey || !parts) return { finished: false, reason: 'no open matchday' };
  const get = makeClient(key);
  let allFinished = true;
  const byId = (id) => db.prepare('SELECT * FROM players WHERE id=?').get('fd' + id);
  const row = new Map();
  const R = (pid) => { if (!row.has(pid)) row.set(pid, { minutes: 0, goals: 0, assists: 0, cs: 0, saves: 0, yellow: 0, red: 0 }); return row.get(pid); };
  for (const lg of Object.keys(parts)) {
    const ms = await get(`/competitions/${lg}/matches?matchday=${parts[lg]}`);
    for (const m of ms.matches || []) {
      if (m.status !== 'FINISHED') { allFinished = false; continue; }
      let d;
      try { d = await get(`/matches/${m.id}`); } catch (e) { log('match ' + m.id + ': ' + e.message); allFinished = false; continue; }
      const hs = d.score && d.score.fullTime ? d.score.fullTime : {};
      const sides = [
        { t: d.homeTeam, conceded: hs.away },
        { t: d.awayTeam, conceded: hs.home }
      ];
      for (const s of sides) {
        const lineup = (s.t && s.t.lineup) || [];
        const bench = (s.t && s.t.bench) || [];
        lineup.forEach(p => { const r = R('fd' + p.id); r.minutes = 70; if (s.conceded === 0) r.cs = 1; });
        // substitutes who came on count as played, if the free tier returns substitutions
        (d.substitutions || []).forEach(x => { if (x.playerIn && x.team && s.t && x.team.id === s.t.id) { const r = R('fd' + x.playerIn.id); r.minutes = Math.max(r.minutes, 25); if (s.conceded === 0) r.cs = 1; } });
        void bench;
      }
      (d.goals || []).forEach(g => {
        if (g.type === 'OWN') return;
        if (g.scorer) { const r = R('fd' + g.scorer.id); r.goals++; r.minutes = Math.max(r.minutes, 1); }
        if (g.assist) { const r = R('fd' + g.assist.id); r.assists++; r.minutes = Math.max(r.minutes, 1); }
      });
      (d.bookings || []).forEach(b => {
        if (!b.player) return;
        const r = R('fd' + b.player.id);
        if (b.card === 'RED' || b.card === 'YELLOW_RED') r.red = 1; else r.yellow = 1;
      });
    }
  }
  tx(db, () => {
    const ins = db.prepare('INSERT OR REPLACE INTO stats(md,player_id,minutes,goals,assists,cs,saves,yellow,red) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const [pid, r] of row) if (db.prepare('SELECT 1 FROM players WHERE id=?').get(pid)) ins.run(mdKey, pid, r.minutes, r.goals, r.assists, r.cs, r.saves, r.yellow, r.red);
    if (allFinished) db.prepare('UPDATE matchdays SET finished=1 WHERE md=?').run(mdKey);
  });
  void byId;
  log('results for ' + mdKey + ': ' + (allFinished ? 'complete' : 'some matches still playing'));
  return { finished: allFinished, rows: row.size };
}

module.exports = { syncSquads, syncResults };
