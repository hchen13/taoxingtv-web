const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise RPC argument flow and callback lifetime; native JNI stability also
// needs an actual emulator playback run, which this mock cannot prove.
function agent() {
  const calls = [], messages = [], callbacks = { live: {}, vod: {} }, tells = { live: {}, vod: {} };
  let created = 0, retained = 0;
  const activity = (kind, errorMethod) => ({
    $new() { created++; return callbacks[kind]; },
    tellMessage: { overload: () => tells[kind] },
    [errorMethod]: { overload: () => ({}) },
  });
  const classes = {
    'com.newvod.activity.VodPlayActivity': activity('vod', 'lambda$tellMessage$1$VodPlayActivity'),
    'com.wys.iptvgo.activity.TimeShiftPlayActivity': activity('live', 'lambda$tellMessage$2$TimeShiftPlayActivity'),
    'dnet.ITellMessage': {},
    'dnet.VideoClient': {
      playbackStop() {}, vodStop() {},
      playbackStart(...args) { calls.push({ kind: 'live', args }); return 41001; },
      vodStart(...args) { calls.push({ kind: 'vod', args }); return 41002; },
    },
  };
  const context = vm.createContext({
    rpc: { exports: {} }, send: data => messages.push(data), shutdownJavaNetwork() {},
    Java: {
      perform: fn => fn(), scheduleOnMainThread: fn => fn(),
      use(name) { assert.ok(classes[name], `Unexpected callback class: ${name}`); return classes[name]; },
      cast: object => object,
      retain(object) { retained++; return object; },
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../agent-src.js'), 'utf8')
    .replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  return { rpc: context.rpc.exports, callbacks, calls, messages, tells,
    counts: () => ({ created, retained }) };
}

test('live and VOD use their registered APK classes and retain one instance per class', async () => {
  const h = agent();
  const [live, vod] = await Promise.all([
    h.rpc.play('525', 0), h.rpc.vodPlay('episode', '127.0.0.1', 9000, 20, 0), h.rpc.play('526', 0),
  ]);
  assert.equal(live.callback, 'activity');
  assert.equal(vod.callback, 'activity');
  assert.equal(h.calls.find(c => c.kind === 'live').args[3], h.callbacks.live);
  assert.equal(h.calls.find(c => c.kind === 'vod').args[8], h.callbacks.vod);
  await h.rpc.play('526', 0);
  assert.deepEqual(h.counts(), { created: 2, retained: 2 });
});

test('APK callback notifications reach the server without executing Activity UI', () => {
  const h = agent(); h.tells.live.implementation(4); h.tells.vod.implementation(2);
  assert.deepEqual(h.messages.filter(m => m.tell).map(m => m.tell), [4, 2]);
  assert.deepEqual(h.messages.filter(m => m.tell).map(m => m.playbackKind), ['live', 'vod']);
  assert.equal(h.rpc.pollTell(true).count, 2);
  assert.equal(h.rpc.pollTell(false).ended, 0);
});
