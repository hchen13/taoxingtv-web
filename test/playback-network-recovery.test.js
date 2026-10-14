const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function section(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }
function viewer() {
  let recoveries = 0, tick;
  const c = vm.createContext({ activeStreamSid: 'current', networkFailedSid: '', isLiveNow: false,
    vodUserPaused: false, switching: false, player: {}, curFilm: {}, recovering: false,
    pendingResumeAt: 0, vodBase: 0, vodDur: 3000, ahead: 100,
    V: { currentTime: 30, paused: false, error: null, buffered: { length: 0 } },
    bufferedEndAt: t => t + c.ahead, doRecover: () => { recoveries++; },
    fetch: async () => ({}), jget: async () => ({ alive: true, feeding: true }),
    playedToEnd: () => false, streamConfirmedEnded: () => false, atBufferedEnd: () => false,
    setInterval: fn => { tick = fn; },
  });
  vm.runInContext(section('function onNetworkFailure(', 'function doRecover()') +
    section('let drainChecking=', "window.addEventListener('pagehide'"), c);
  return { c, tick: () => tick(), fail: sid => vm.runInContext(`onNetworkFailure(${JSON.stringify(sid)})`, c),
    recoveries: () => recoveries };
}
test('network EOF retains playable video until the buffer is nearly consumed', async () => {
  const h = viewer(); h.fail('current'); await h.tick(); assert.equal(h.recoveries(), 0);
  h.c.ahead = 5; await h.tick(); assert.equal(h.recoveries(), 1);
});
test('paused video survives network EOF and recovers only after resume drains it', async () => {
  const h = viewer(); h.c.vodUserPaused = true; h.c.V.paused = true; h.c.ahead = 2;
  h.fail('current'); await h.tick(); assert.equal(h.recoveries(), 0);
  h.c.V.paused = false; h.c.vodUserPaused = false; await h.tick(); assert.equal(h.recoveries(), 1);
});
test('stale network errors do not affect a new stream; decoder errors recover immediately', () => {
  const h = viewer(); h.fail('old'); assert.equal(h.c.networkFailedSid, '');
  h.c.V.error = { code: 3 }; h.fail('current'); assert.equal(h.recoveries(), 1);
});
test('a seek still waiting for its target retries immediately on network failure', () => {
  const h = viewer(); h.c.pendingResumeAt = 120; h.fail('current');
  assert.equal(h.recoveries(), 1);
});
test('drained video retries even when the server status endpoint is offline', async () => {
  const h = viewer(); h.fail('current'); h.c.ahead = 3;
  h.c.jget = async () => { throw new Error('offline'); };
  await h.tick(); assert.equal(h.recoveries(), 1);
});
