'use strict';
// Scoring rules shared by the server and the demo simulator.
const G_PTS = { GK: 6, DEF: 6, MID: 5, FWD: 4 };
const CS_PTS = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
const BOLD_RATE = 35;   // pick rate (%) below which a player counts as a bold pick
const BOLD_PTS = 6;     // base points needed to trigger the bold bonus

const COUNTRIES = ['SY','EG','SA','MA','DZ','IQ','JO','LB','TN','AE','TR','BR','AR','ES','IT','FR','DE','US'];

// stats row: { minutes, goals, assists, cs, saves, yellow, red, owng }
function scoreRow(player, row, isCap, rate) {
  const ev = [];
  if (!row || !row.minutes) {
    return { id: player.id, cap: isCap, bold: false, base: 0, total: 0, ev: [{ l: 'لم يشارك', k: 'n' }] };
  }
  let pts = 2;
  if (row.goals) { pts += row.goals * G_PTS[player.pos]; ev.push({ l: 'هدف' + (row.goals > 1 ? ' ×' + row.goals : ''), k: 'g' }); }
  if (row.assists) { pts += row.assists * 3; ev.push({ l: 'تمريرة حاسمة' + (row.assists > 1 ? ' ×' + row.assists : ''), k: 'g' }); }
  if (row.cs && CS_PTS[player.pos]) { pts += CS_PTS[player.pos]; ev.push({ l: 'شباك نظيفة', k: 'g' }); }
  if (player.pos === 'GK' && row.saves >= 3) { const b = Math.floor(row.saves / 3); pts += b; ev.push({ l: row.saves + ' تصديات', k: 'g' }); }
  if (row.owng) { pts -= 2 * row.owng; ev.push({ l: 'هدف بمرمى فريقه', k: 'n' }); }
  if (row.red) { pts -= 3; ev.push({ l: 'بطاقة حمراء', k: 'n' }); }
  else if (row.yellow) { pts -= 1; ev.push({ l: 'إنذار', k: 'n' }); }
  const bold = rate < BOLD_RATE && pts >= BOLD_PTS;
  const total = Math.round(pts * (isCap ? 2 : 1) * (bold ? 1.5 : 1));
  return { id: player.id, cap: isCap, bold, base: pts, total, ev };
}

const P_GOAL = { FWD: 0.42, MID: 0.2, DEF: 0.07, GK: 0.003 };
const P_ASSIST = { FWD: 0.22, MID: 0.3, DEF: 0.13, GK: 0.01 };
// Demo mode only: invent a plausible stat line.
function simulateStats(player) {
  if (Math.random() < 0.07) return { minutes: 0, goals: 0, assists: 0, cs: 0, saves: 0, yellow: 0, red: 0 };
  const star = 0.6 + Math.random() * 0.9;
  const pg = P_GOAL[player.pos] * star, pa = P_ASSIST[player.pos] * star;
  const r = Math.random();
  return {
    minutes: 90,
    goals: (Math.random() < pg ? 1 : 0) + (Math.random() < pg * 0.3 ? 1 : 0),
    assists: (Math.random() < pa ? 1 : 0) + (Math.random() < pa * 0.2 ? 1 : 0),
    cs: player.pos !== 'FWD' && Math.random() < 0.36 ? 1 : 0,
    saves: player.pos === 'GK' ? 1 + Math.floor(Math.random() * 7) : 0,
    yellow: r >= 0.015 && r < 0.135 ? 1 : 0,
    red: r < 0.015 ? 1 : 0
  };
}

module.exports = { scoreRow, simulateStats, COUNTRIES, BOLD_RATE, BOLD_PTS };
