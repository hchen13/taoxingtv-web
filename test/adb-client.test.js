const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createAdbClient } = require('../adb-client');
const { VodBuffer } = require('../vod-buffer');

test('a device wait leaves HTTP and cached video delivery responsive', async () => {
  const run = createAdbClient(process.execPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txtv-boot-'));
  const cache = new VodBuffer({ directory: dir, capacity: 4096 });
  const response = new PassThrough();
  const received = []; response.on('data', data => received.push(data));
  cache.end(Buffer.alloc(1880, 0x47));
  const server = http.createServer((req, res) => res.end('healthy'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let bootDone = false;
  const boot = run(['-e', 'setTimeout(()=>console.log("device"),500)']).then(out => { bootDone = true; return out; });
  try {
    await cache.relay(response);
    const health = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await health.text(), 'healthy');
    assert.equal(bootDone, false, 'the HTTP request must finish before the device wait');
    assert.equal(Buffer.concat(received).length, 1880, 'cached bytes drain during recovery');
    assert.equal((await boot).trim(), 'device');
  } finally {
    await boot; server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    cache.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('required ADB commands report timeout; optional probes return empty', async () => {
  const run = createAdbClient(process.execPath);
  await assert.rejects(run(['-e', 'setInterval(()=>{},1000)'], { timeout: 50, required: true }), /timeout/);
  assert.equal(await run(['-e', 'process.exit(1)']), '');
});

test('a reused forward waits for the old removal and survives a previous error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txtv-forward-'));
  const fake = path.join(dir, 'adb');
  fs.writeFileSync(fake, '#!' + process.execPath + '\n' +
    'const fs=require("node:fs"); const [cmd,action,file]=process.argv.slice(2);' +
    'setTimeout(()=>{fs.appendFileSync(file,action+"\\n");process.exit(action==="remove"?1:0)},action==="remove"?200:0);');
  fs.chmodSync(fake, 0o700);
  try {
    const run = createAdbClient(fake), log = path.join(dir, 'order');
    const remove = run(['forward', 'remove', log], { required: true });
    const bind = run(['forward', 'bind', log], { required: true });
    await assert.rejects(remove, /failed/); await bind;
    assert.equal(fs.readFileSync(log, 'utf8'), 'remove\nbind\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
