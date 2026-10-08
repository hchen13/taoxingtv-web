const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable, Readable } = require('node:stream');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { VodBuffer, TransportClock } = require('../vod-buffer');

test('prefetch is bounded, survives ring wrap, and drains every byte before EOF', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'txtv-buffer-'));
  const spool = new VodBuffer({ directory, capacity: 32768 });
  const input = crypto.randomBytes(800000), received = [];
  const output = new Writable({ highWaterMark: 4096, write(data, _, done) {
    received.push(Buffer.from(data)); setImmediate(done);
  }});
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, spool.pendingBytes); }, 1);
  try {
    spool.setDeliveryPaused(true);
    Readable.from([input.subarray(0, 300000), input.subarray(300000)]).pipe(spool);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(spool.pendingBytes, 32768);
    assert.equal(spool.backpressured, true);
    assert.deepEqual(fs.readdirSync(directory), []);
    const finished = once(output, 'finish');
    spool.setDeliveryPaused(false);
    await spool.relay(output);
    await finished;
    assert.deepEqual(Buffer.concat(received), input);
    assert.ok(peak <= spool.capacity);
    if (!spool.closed) await once(spool, 'close');
  } finally { clearInterval(timer); spool.destroy(); fs.rmSync(directory, { recursive:true, force:true }); }
});

test('closing the viewer cancels a producer blocked on a full reserve', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'txtv-buffer-'));
  const spool = new VodBuffer({ directory, capacity: 1024 });
  spool.on('error', () => {});
  const output = new Writable({ write(data, _, done) { done(); } });
  spool.setDeliveryPaused(true);
  const relay = spool.relay(output);
  const closed = once(spool, 'close').catch(() => {});
  spool.write(Buffer.alloc(4096));
  await new Promise(resolve => setTimeout(resolve, 20));
  output.destroy();
  await relay; await closed;
  assert.equal(spool.destroyed, true);
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.rmSync(directory, { recursive:true, force:true });
});

test('browser delivery clock follows real MPEG-TS across arbitrary chunk boundaries', () => {
  const ff = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner','-loglevel','error',
    '-f','lavfi','-i','testsrc2=s=64x64:r=10','-t','4','-c:v','libx264','-preset','ultrafast',
    '-g','10','-output_ts_offset','100','-f','mpegts','pipe:1'], { timeout:15000, maxBuffer:1048576 });
  assert.equal(ff.status, 0, String(ff.stderr));
  for (const size of [1, 187, 188, 1001, 65536]) {
    const clock = new TransportClock();
    for (let i=0; i<ff.stdout.length; i+=size) clock.push(ff.stdout.subarray(i,i+size));
    assert.ok(clock.seconds > 3.5 && clock.seconds <= 4, `chunk ${size}: ${clock.seconds}`);
  }
});
