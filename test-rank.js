'use strict';
const assert = require('node:assert');
const { open } = require('./lib/db');
const { profile } = require('./lib/profile');
function seed(db) {
  const U = [['aa', 'SY', 6], ['bb', 'SY', 5], ['cc', 'EG', 4], ['dd', 'SY', 3], ['ee', 'EG', 2]];
  const iu = db.prepare('INSERT INTO users(id,name,country,created) VALUES(?,?,?,?)');
  const ir = db.prepare('INSERT INTO results(duel_id,user_id,opp_name,opp_country,mine,theirs,outcome,md,ts) VALUES(?,?,?,?,?,?,?,?,?)');
  for (const [id, c, w] of U) { iu.run(id, 'لاعب ' + id, c, 1); for (let i = 0; i < 6; i++) ir.run(id + i, id, 'x', 'EG', 40, 20, i < w ? 'win' : 'loss', 'm', 1000 + i); }
}
if (require.main === module) {
  const db = open(':memory:'); seed(db);
  const f = (id) => profile(db, id, false).rank;
  assert.deepStrictEqual(f('aa').frame, { tier: 'diamond', scope: 'global', animated: true, rank: 1 });
  assert.strictEqual(f('bb').frame.tier, 'gold'); assert.strictEqual(f('cc').frame.tier, 'bronze');
  assert.deepStrictEqual(f('dd').frame, { tier: 'bronze', scope: 'country', animated: false, rank: 3 }); // 4th globally, 3rd in SY
  assert.deepStrictEqual(f('ee').frame, { tier: 'gold', scope: 'country', animated: false, rank: 2 }); // 5th globally, 2nd in EG
  const a = profile(db, 'aa', false).achievements.filter(x => x.got).map(x => x.id);
  assert.ok(a.includes('global_top1') && a.includes('country_top1') && a.includes('global_top3'));
  assert.ok(!profile(db, 'ee', false).achievements.some(x => x.id === 'global_top3' && x.got));
  console.log('RANK OK');
}
module.exports = { seed };
