'use strict';
// Player records, achievements and the all-time leaderboard. Everything is derived from the `results` table.

const TIERS = [ // by wins
  { min: 200, id: 'legend', name: 'أسطورة' },
  { min: 75, id: 'star', name: 'نجم' },
  { min: 25, id: 'pro', name: 'محترف' },
  { min: 5, id: 'regular', name: 'لاعب منتظم' },
  { min: 0, id: 'rookie', name: 'مبتدئ' }
];

function streaks(rows) { // rows oldest -> newest
  let cur = 0, best = 0;
  for (const r of rows) {
    if (r.outcome === 'win') { cur++; if (cur > best) best = cur; }
    else cur = 0; // a draw or loss resets the streak
  }
  return { current: cur, best };
}

function achievements(s) {
  const A = [ // [id, name, earned, rarity]
    ['first_duel', 'أول مبارزة', s.games >= 1, 'common'],
    ['first_win', 'أول فوز', s.wins >= 1, 'common'],
    ['wins_10', '10 انتصارات', s.wins >= 10, 'common'],
    ['wins_50', '50 انتصاراً', s.wins >= 50, 'rare'],
    ['wins_100', '100 انتصار', s.wins >= 100, 'rare'],
    ['games_100', '100 مبارزة', s.games >= 100, 'rare'],
    ['streak_5', 'سلسلة 5 انتصارات متتالية', s.bestStreak >= 5, 'rare'],
    ['streak_10', 'سلسلة 10 انتصارات متتالية', s.bestStreak >= 10, 'rare'],
    ['big_score', 'نتيجة 60 نقطة أو أكثر', s.bestScore >= 60, 'rare'],
    ['bold_10', 'صائد الجريئين: 10 اختيارات جريئة ناجحة', s.boldTotal >= 10, 'rare'],
    ['country_top3', 'من أول 3 في بلدك', !!s.countryRank && s.countryRank <= 3, 'epic'],
    ['wins_250', '250 انتصاراً', s.wins >= 250, 'epic'],
    ['games_500', '500 مبارزة', s.games >= 500, 'epic'],
    ['streak_15', 'سلسلة 15 انتصاراً متتالياً', s.bestStreak >= 15, 'epic'],
    ['big_score_90', 'نتيجة 90 نقطة أو أكثر', s.bestScore >= 90, 'epic'],
    ['bold_50', '50 اختياراً جريئاً ناجحاً', s.boldTotal >= 50, 'epic'],
    ['country_top1', 'الأول في بلدك', s.countryRank === 1, 'legendary'],
    ['global_top3', 'من أول 3 عالمياً', !!s.globalRank && s.globalRank <= 3, 'legendary'],
    ['global_top1', 'الأول عالمياً', s.globalRank === 1, 'legendary'],
    ['wins_1000', '1000 انتصار', s.wins >= 1000, 'legendary']
  ];
  return A.map(([id, name, got, rarity]) => ({ id, name, got, rarity }));
}

// Ranking = wins, then points, for players with 5+ duels (same rule as the leaderboard).
const FRAME_TIERS = ['diamond', 'gold', 'bronze'];
function rankOf(db, uid) {
  const rows = db.prepare(`SELECT r.user_id id, u.country, SUM(r.outcome='win') wins, SUM(r.mine) pts, COUNT(*) games
    FROM results r JOIN users u ON u.id=r.user_id GROUP BY r.user_id HAVING games>=5 ORDER BY wins DESC, pts DESC, r.user_id`).all();
  const gi = rows.findIndex(r => r.id === uid);
  if (gi < 0) return { global: null, country: null, frame: null };
  const mine = rows.filter(r => r.country === rows[gi].country);
  const g = gi + 1, c = mine.findIndex(r => r.id === uid) + 1;
  // Country podium: static diamond / gold / bronze. Global podium: same colours, glowing and animated.
  const frame = g <= 3 ? { tier: FRAME_TIERS[g - 1], scope: 'global', animated: true, rank: g }
    : c <= 3 ? { tier: FRAME_TIERS[c - 1], scope: 'country', animated: false, rank: c } : null;
  return { global: g, country: c, frame };
}

function statsFor(db, uid) {
  const rows = db.prepare('SELECT outcome,mine,theirs,bold_n,best_pts,best_player,ts FROM results WHERE user_id=? ORDER BY ts, duel_id').all(uid);
  const s = { games: rows.length, wins: 0, draws: 0, losses: 0, points: 0, bestScore: 0, boldTotal: 0, bestPlayerPts: 0, bestPlayer: null };
  for (const r of rows) {
    if (r.outcome === 'win') s.wins++; else if (r.outcome === 'draw') s.draws++; else s.losses++;
    s.points += r.mine; s.boldTotal += r.bold_n;
    if (r.mine > s.bestScore) s.bestScore = r.mine;
    if (r.best_pts > s.bestPlayerPts) { s.bestPlayerPts = r.best_pts; s.bestPlayer = r.best_player; }
  }
  const st = streaks(rows);
  s.currentStreak = st.current; s.bestStreak = st.best;
  s.winRate = s.games ? Math.round(100 * s.wins / s.games) : 0;
  s.avgScore = s.games ? Math.round(10 * s.points / s.games) / 10 : 0;
  const tier = TIERS.find(t => s.wins >= t.min);
  s.tier = { id: tier.id, name: tier.name };
  return s;
}

function history(db, uid, limit) {
  return db.prepare('SELECT duel_id id,opp_name,opp_country,mine,theirs,outcome,md,ts FROM results WHERE user_id=? ORDER BY ts DESC LIMIT ?').all(uid, Math.min(limit || 20, 100));
}

function profile(db, uid, withHistory) {
  const u = db.prepare('SELECT id,name,country,created FROM users WHERE id=?').get(uid);
  if (!u) return null;
  const stats = statsFor(db, uid);
  const rk = rankOf(db, uid);
  const out = { id: u.id, name: u.name, country: u.country, since: u.created, stats, rank: rk, achievements: achievements(Object.assign({ globalRank: rk.global, countryRank: rk.country }, stats)), recent: history(db, uid, withHistory ? 30 : 10) };
  return out;
}

function leaderboard(db, limit) {
  const rows = db.prepare(`SELECT r.user_id id, u.name, u.country, COUNT(*) games,
      SUM(r.outcome='win') wins, SUM(r.mine) pts, MAX(r.mine) best
    FROM results r JOIN users u ON u.id=r.user_id GROUP BY r.user_id HAVING games>=5
    ORDER BY wins DESC, pts DESC LIMIT ?`).all(Math.min(limit || 20, 100));
  return rows.map(r => ({ ...r, tier: TIERS.find(t => r.wins >= t.min).name, winRate: Math.round(100 * r.wins / r.games) }));
}

module.exports = { profile, leaderboard, statsFor, rankOf };
