const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function section(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing browser handler: ${start}`);
  return html.slice(from, to);
}

function viewer() {
  let now = 1000, ranges = [], compatible = true;
  const timers = [], calls = { fallback: 0, recover: 0, play: 0 };
  const element = { textContent: '', classList: { add() {}, remove() {} } };
  const c = vm.createContext({
    player: {}, curFilm: {}, isLiveNow: false, recovering: false,
    pendingResumeAt: 620, vodBase: 600, vodDur: 3000, pendingMargin: 10,
    resumeLastBuf: 0, resumeLastGrow: now, resumeLastReady: 0, resumeReadyGrow: now,
    resumeLastCheck: 0, resumeChecking: false, pendingStartPaused: false,
    RESUME_MARGIN: 10, curSpeed: 1, activeStreamSid: 'test',
    Date: { now: () => now }, $: () => element,
    V: { currentTime: 0, paused: true, readyState: 2,
      buffered: { get length() { return ranges.length; }, start: i => ranges[i][0], end: i => ranges[i][1] },
      pause() { this.paused = true; }, play() { this.paused = false; calls.play++; return Promise.resolve(); } },
    setInterval(fn, ms) { timers.push({ fn, ms }); },
    fallbackToTranscode() { calls.fallback++; return compatible; },
    doRecover() { calls.recover++; }, saveState() {}, refreshDeferredCats() {},
    jget: async () => ({ alive: true, feeding: true }),
    streamConfirmedEnded: () => false, playedToEnd: () => false, atBufferedEnd: () => false,
  });
  vm.runInContext(section('function bufferedEndAt(', "V.addEventListener('progress',") +
    section('function hasBufferedGapAfter(', 'let drainChecking=') +
    section('let wdLast=', "V.addEventListener('waiting',"), c);
  return { c, calls, ranges: value => { ranges = value; }, time: value => { now = value; },
    compatible: value => { compatible = value; },
    tick: () => timers.find(x => x.ms === 500).fn(),
    watchdog: () => timers.find(x => x.ms === 3000).fn(),
    read: code => vm.runInContext(code, c) };
}

test('future fragments cannot disguise a stalled resume window', () => {
  const h = viewer(); h.ranges([[0, 5], [18, 22], [30, 40]]); h.tick();
  for (let now = 2000; now <= 13000; now += 1000) {
    h.time(now); h.ranges([[0, 5], [18, 22], [30, 40 + now / 1000]]); h.tick();
  }
  assert.equal(h.calls.fallback, 0);
  h.time(14001); h.tick();
  assert.equal(h.calls.fallback, 1);
  assert.equal(h.calls.play, 0);
  assert.equal(h.c.pendingResumeAt, 620);
});

test('slow but continuous buffering does not trigger compatibility fallback', () => {
  const h = viewer();
  for (let i = 0; i <= 15; i++) {
    h.time(1000 + i * 1000); h.ranges([[0, 20 + i]]); h.tick();
  }
  assert.equal(h.calls.fallback, 0);
  assert.equal(h.calls.play, 1);
});

test('missing source data is not mistaken for a timestamp gap', () => {
  const h = viewer(); h.tick(); h.time(20000); h.tick();
  assert.equal(h.calls.fallback, 0);
  assert.equal(h.calls.recover, 0);
});

test('a persistent gap in compatibility mode retries without waiting two minutes', () => {
  const h = viewer(); h.compatible(false); h.ranges([[0, 5], [30, 60]]); h.tick();
  h.time(23000); h.tick();
  assert.equal(h.calls.recover, 1);
});

test('an active viewer stuck before a gap falls back and releases the watchdog lock', async () => {
  const h = viewer(); h.c.pendingResumeAt = 0; h.c.V.paused = false;
  h.c.V.currentTime = 5; h.ranges([[0, 5], [10, 60]]);
  for (let i = 0; i < 5; i++) await h.watchdog();
  assert.equal(h.calls.fallback, 1);
  assert.equal(h.read('checking'), false);
});

test('a user pause does not trigger gap recovery', async () => {
  const h = viewer(); h.c.pendingResumeAt = 0; h.ranges([[0, 5], [10, 60]]);
  for (let i = 0; i < 6; i++) await h.watchdog();
  assert.equal(h.calls.fallback, 0);
  assert.equal(h.calls.recover, 0);
});
