const test = require('node:test');
const assert = require('node:assert/strict');
const { DeadPortRestartPolicy } = require('../stream-recovery');

test('片尾反复无首包也会自愈，但同一故障不会反复冷重启', () => {
  let now = 1000;
  const policy = new DeadPortRestartPolicy({ now: () => now, cooldownMs: 300000 });
  assert.equal(policy.shouldRestart(1, { nearEnd: true }), false);
  now += 40000; // 前端等不及重取，前一个请求只来得及判定一个死端口
  assert.equal(policy.shouldRestart(1, { nearEnd: true }), true);
  now += 80000;
  assert.equal(policy.shouldRestart(2, { nearEnd: true }), false);
  policy.succeeded();
  assert.equal(policy.shouldRestart(1, { nearEnd: true }), false);
  assert.equal(policy.shouldRestart(1, { nearEnd: true }), true);
});

test('冷启动仅宽限首个坏端口，过期的片尾失败不累计', () => {
  let now = 1000;
  const policy = new DeadPortRestartPolicy({ now: () => now, cooldownMs: 300000 });
  assert.equal(policy.shouldRestart(1, { startupWarmup: true }), false);
  assert.equal(policy.shouldRestart(1, { startupWarmup: true }), true);
  policy.succeeded();
  assert.equal(policy.shouldRestart(1, { nearEnd: true }), false);
  now += 300001;
  assert.equal(policy.shouldRestart(1, { nearEnd: true }), false);
  assert.equal(policy.shouldRestart(1, { nearEnd: true }), true);
});
