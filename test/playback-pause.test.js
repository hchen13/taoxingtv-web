const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real UI handlers with a media element and stream restart stub.
// A decoder can pause the element itself, so paused alone is not user intent.
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function section(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing browser handler: ${start}`);
  return html.slice(from, to);
}
const handlers = [
  section('function saveState()', 'async function restore()'),
  section('function togglePP()', "$('ppBtn').onclick"),
  section('function userAction()', 'function playedToEnd()'),
  section('function doRecover()', 'function fallbackToTranscode()'),
  section('function fallbackToTranscode()', 'let failedMediaSid='),
  section("V.addEventListener('play',", "$('speed').onchange"),
].join('\n');

function viewer() {
  const timers = [], restarts = [], saved = {}, listeners = {};
  const element = { textContent: '', classList: { add() {}, remove() {} } };
  const v = { paused: false, currentTime: 25, buffered: { length: 0 },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    pause() { this.paused = true; for (const fn of listeners.pause || []) fn(); },
    play() { this.paused = false; for (const fn of listeners.play || []) fn(); return Promise.resolve(); } };
  const c = vm.createContext({
    player: {}, V: v, isLiveNow: false, livePauseStartedAt: 0,
    mode: 'vod', playbackStoppedForDownload: false,
    LS: { set(key, value) { saved[key] = value; } }, saveProg() {},
    vodUserPaused: false, pendingStartPaused: false, pendingResumeAt: 0,
    pendingMargin: 0, vodDur: 3000, vodBase: 600, curPct: 20,
    recovering: false, switching: false, recoverTimes: 0, lastRecover: 0, recoverPos: -1,
    recoverTimer: null, fromRecovery: false, streamStartedAt: Date.now() - 100000,
    curFilm: { playid: 'film' }, curEps: [{ channelId: 'episode' }], curEpIdx: 0,
    transcodeFallback: new Set(), console: { warn() {} },
    STAGE: element, $: () => element, resumeMargin: () => 10,
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    playEpisode(pct) { restarts.push({ pct, keepPaused: c.pendingStartPaused }); },
  });
  vm.runInContext(handlers, c);
  return { c, v, timers, restarts, saved, run: code => vm.runInContext(code, c) };
}

test('transport recovery preserves an explicit user pause', () => {
  const h = viewer(); h.run('togglePP(); doRecover();'); h.timers.shift()();
  assert.equal(h.v.paused, true);
  assert.equal(h.restarts[0].keepPaused, true);
});

test('codec fallback preserves an explicit user pause', () => {
  const h = viewer(); h.run('togglePP(); fallbackToTranscode();');
  assert.equal(h.restarts[0].keepPaused, true);
});

test('codec fallback retains the pending resume position and remembers compatibility mode', () => {
  const h = viewer(); h.c.pendingResumeAt = 654; h.v.currentTime = 0;
  h.run('fallbackToTranscode();');
  assert.equal(h.c.pendingResumeAt, 654);
  assert.equal(h.restarts[0].pct, 21);
  assert.deepEqual(Array.from(h.saved.txtv_transcode_v1), ['episode']);
});

test('an automatic decoder pause does not stop recovery of active viewing', () => {
  const h = viewer(); h.v.paused = true;
  h.run('doRecover();'); h.timers.shift()();
  assert.equal(h.restarts[0].keepPaused, false);
});

test('resume during recovery backoff overrides the earlier pause intent', () => {
  const h = viewer(); h.run('togglePP(); doRecover(); togglePP();');
  h.timers.shift()();
  assert.equal(h.v.paused, false);
  assert.equal(h.restarts[0].keepPaused, false);
});

test('an explicit episode or seek action clears the old pause intent', () => {
  const h = viewer(); h.run('togglePP(); userAction();');
  assert.equal(h.c.vodUserPaused, false);
});

test('saving during recovery retains the user pause for a later page restore', () => {
  const h = viewer(); h.run('togglePP(); doRecover();'); h.timers.shift()();
  h.run('saveState();');
  assert.equal(h.saved.txtv_state.vod.paused, true);
});

test('saving after a decoder-induced pause does not invent a user pause', () => {
  const h = viewer(); h.v.paused = true; h.run('saveState();');
  assert.equal(h.saved.txtv_state.vod.paused, false);
});

test('a system media-key pause is retained during transport recovery', () => {
  const h = viewer(); h.v.pause(); h.run('doRecover();'); h.timers.shift()();
  assert.equal(h.restarts[0].keepPaused, true);
});

test('the decoder error pause event keeps active viewing intent', () => {
  const h = viewer(); h.v.error = { code: 3 }; h.v.pause();
  h.run('doRecover();'); h.timers.shift()();
  assert.equal(h.restarts[0].keepPaused, false);
});

test('a pause event caused by switching streams is not saved as a user pause', () => {
  const h = viewer(); h.c.switching = true; h.v.pause();
  assert.equal(h.c.vodUserPaused, false);
  assert.equal(h.saved.txtv_state.vod.paused, false);
});

test('premature media end does not turn an automatic pause into user intent', () => {
  const h = viewer(); h.v.ended = true; h.v.pause();
  h.run('doRecover();'); h.timers.shift()();
  assert.equal(h.restarts[0].keepPaused, false);
});
