const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const attach = source.slice(source.indexOf('async function attach(){'), source.indexOf('async function ensureReady(){'));
function engine() {
  const callbacks = [], calls = { cleanup: 0, boot: 0 };
  const dev = {
    enumerateApplications: async () => [{ identifier: 'test', pid: 1 }],
    attach: async () => ({ detached: { connect: fn => callbacks.push(fn) },
      createScript: async () => ({ message: { connect() {} }, load: async () => {} }) }),
  };
  const context = vm.createContext({ frida: { getUsbDevice: async () => dev }, PKG: 'test',
    script: null, session: null, state: 'ready', needColdRestart: false,
    current: { buffer: { pendingBytes: 256 * 1024 * 1024 }, res: { writableEnded: false }, splicing: false },
    fs: { readFileSync: () => '' }, __dirname: '', console: { log() {}, error() {} },
    cleanupCurrent: () => { calls.cleanup++; }, bootEmulator: async () => { calls.boot++; },
  });
  vm.runInContext(attach, context);
  return { calls, context, callbacks, attach: () => vm.runInContext('attach()', context) };
}

test('engine loss warms a replacement before a full cache has drained', async () => {
  const h = engine(); await h.attach(); h.callbacks[0]('connection-terminated');
  assert.equal(h.calls.boot, 1); assert.equal(h.calls.cleanup, 0);
  assert.equal(h.context.current.buffer.pendingBytes, 256 * 1024 * 1024);
  assert.equal(h.context.state, 'off'); assert.equal(h.context.needColdRestart, true);
});

test('a delayed detach from an old session cannot discard its replacement', async () => {
  const h = engine(); await h.attach(); await h.attach();
  const session = h.context.session, script = h.context.script;
  h.callbacks[0]('connection-terminated');
  assert.equal(h.context.session, session); assert.equal(h.context.script, script);
  assert.equal(h.context.state, 'ready'); assert.equal(h.calls.boot, 0);
});

test('an intentional shutdown does not auto-start the emulator again', async () => {
  const h = engine(); await h.attach(); h.context.state = 'off';
  h.callbacks[0]('application-requested'); assert.equal(h.calls.boot, 0);
});
