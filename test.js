'use strict';
// Smoke test: two humans draft against each other, then one human plays a bot. Run: node test.js
process.env.DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'dd-test-' + Date.now() + '.db');
process.env.DEMO = '1';
const assert = require('node:assert');
const { server } = require('./server');

function client(base) {
  let token = null;
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: r.status, j: await r.json() };
  };
  return { call, join: async (name, country) => { const r = await call('POST', '/api/register', { name, country, email: name.toLowerCase() + '@example.com', password: 'secret-pass-1' }); assert.strictEqual(r.s, 200, JSON.stringify(r.j)); token = r.j.token; return r; },
    setToken: (t) => { token = t; } };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function playOut(c, id, label) {
  for (let i = 0; i < 200; i++) {
    const { j: d } = await c.call('GET', '/api/duel/' + id);
    if (d.status === 'done') return d;
    if (d.status === 'drafting' && d.order[d.turn] === 'me') {
      const free = d.pool.filter(p => !p.t).sort((a, b) => b.o - a.o)[0];
      const r = await c.call('POST', `/api/duel/${id}/pick`, { player: free.id });
      assert.strictEqual(r.s, 200, label + ' pick failed ' + JSON.stringify(r.j));
    } else if (d.status === 'captain' && !d.captain.me) {
      const r = await c.call('POST', `/api/duel/${id}/captain`, { player: d.picks.me[0] });
      assert.strictEqual(r.s, 200, label + ' captain failed');
    } else await sleep(150);
  }
  throw new Error(label + ' did not finish');
}

server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port;
  try {
    const a = client(base), b = client(base);
    await a.join('Ahmad', 'SY'); await b.join('Omar', 'EG');
    assert.strictEqual((await a.call('POST', '/api/queue')).j.status, 'waiting');
    const qb = (await b.call('POST', '/api/queue')).j;
    assert.strictEqual(qb.status, 'matched');
    const qa = (await a.call('GET', '/api/queue')).j;
    assert.strictEqual(qa.status, 'matched'); assert.strictEqual(qa.duel, qb.duel);
    const id = qa.duel;

    // account checks
    const anon = client(base);
    assert.strictEqual((await anon.call('GET', '/api/me')).s, 401, 'no session -> 401');
    assert.strictEqual((await anon.call('POST', '/api/register', { name: 'X', country: 'SY', email: 'ahmad@example.com', password: 'secret-pass-1' })).s, 409, 'duplicate email');
    assert.strictEqual((await anon.call('POST', '/api/register', { name: 'X', country: 'SY', email: 'new@example.com', password: 'short' })).s, 400, 'weak password');
    assert.strictEqual((await anon.call('POST', '/api/login', { email: 'ahmad@example.com', password: 'wrong-password' })).s, 401, 'bad password');
    const li = await anon.call('POST', '/api/login', { email: 'AHMAD@example.com', password: 'secret-pass-1' });
    assert.strictEqual(li.s, 200); anon.setToken(li.j.token);
    assert.strictEqual((await anon.call('GET', '/api/me')).j.name, 'Ahmad');
    assert.strictEqual((await anon.call('POST', '/api/logout')).s, 200);
    assert.strictEqual((await anon.call('GET', '/api/me')).s, 401, 'logged out session is dead');

    // cheating checks
    const d0 = (await a.call('GET', '/api/duel/' + id)).j;
    assert.strictEqual(d0.pool.length, 14);
    const notMine = d0.order[0] === 'me' ? b : a;
    const bad = await notMine.call('POST', `/api/duel/${id}/pick`, { player: d0.pool[0].id });
    assert.strictEqual(bad.s, 409, 'pick out of turn must be rejected');
    const outsider = client(base); await outsider.join('Eve', 'TR');
    assert.strictEqual((await outsider.call('GET', '/api/duel/' + id)).s, 404, 'outsiders cannot read a duel');

    const [ra, rb] = await Promise.all([playOut(a, id, 'A'), playOut(b, id, 'B')]);
    assert.strictEqual(ra.result.me.length, 5); assert.strictEqual(ra.result.opp.length, 5);
    assert.strictEqual(ra.result.a, rb.result.b); assert.strictEqual(ra.result.b, rb.result.a);
    const ids = new Set([...ra.picks.me, ...ra.picks.opp]); assert.strictEqual(ids.size, 10, 'no player picked twice');
    console.log('human vs human OK:', ra.result.a, '-', ra.result.b);

    const war = (await a.call('GET', '/api/war')).j.war;
    const pts = Object.fromEntries(war.map(x => [x.c, x.v]));
    assert.strictEqual(pts.SY + pts.EG, ra.result.a === ra.result.b ? 10 : 12);
    console.log('war board OK', JSON.stringify(war.filter(x => x.v)));

    // permanent record
    const pa = (await a.call('GET', '/api/profile')).j;
    assert.strictEqual(pa.stats.games, 1); assert.strictEqual(pa.recent.length, 1);
    assert.strictEqual(pa.stats.wins + pa.stats.draws + pa.stats.losses, 1);
    const pub = await client(base).call('GET', '/api/player/' + pa.id);
    assert.strictEqual(pub.s, 200); assert.strictEqual(pub.j.name, 'Ahmad'); assert.ok(!('email' in pub.j), 'public profile must not expose email');
    console.log('profile OK:', JSON.stringify(pa.stats));

    // bot fallback
    const c = client(base); await c.join('Solo', 'MA');
    await c.call('POST', '/api/queue');
    let q; for (let i = 0; i < 30; i++) { await sleep(500); q = (await c.call('GET', '/api/queue')).j; if (q.status === 'matched') break; }
    assert.strictEqual(q.status, 'matched'); assert.ok(q.bot, 'should fall back to a bot');
    const rc = await playOut(c, q.duel, 'C');
    assert.strictEqual(rc.status, 'done');
    console.log('human vs bot OK:', rc.result.a, '-', rc.result.b, 'vs', rc.opp.name);
    const lb = (await a.call('GET', '/api/leaderboard')).j.top; assert.ok(Array.isArray(lb));
    const pc = (await c.call('GET', '/api/profile')).j; assert.strictEqual(pc.stats.games, 1);
    console.log('ALL PASSED');
    process.exit(0);
  } catch (e) { console.error('FAILED', e); process.exit(1); }
});
