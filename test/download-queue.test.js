const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const { DownloadQueue } = require('../download-queue');

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await wait(100);
  }
  throw new Error('等待队列完成超时');
}

test('播放优先、按加入顺序下载，断流后续取并生成可解码 MP4', { timeout: 40000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taoxing-download-test-'));
  const output = path.join(temp, 'output');
  fs.mkdirSync(output);
  const fixture = path.join(temp, 'source.ts');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=s=64x64:r=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', '32', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '8', '-c:a', 'aac',
    '-b:a', '32k', '-f', 'mpegts', fixture], { timeout: 15000 });
  const source = fs.readFileSync(fixture);
  const requests = [];
  let interrupted = false;
  const server = http.createServer((req, res) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const channel = params.get('channelId');
    requests.push(channel);
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    if (channel === 'A'.repeat(32) && !interrupted) {
      interrupted = true;
      res.end(source.subarray(0, Math.floor(source.length * 0.36 / 188) * 188));
      return;
    }
    const start = Number(params.get('percent')) / 100 * 32;
    if (start < 0.1) { res.end(source); return; }
    const suffix = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(start),
      '-i', fixture, '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { timeout: 15000, maxBuffer: 5e6 });
    res.end(suffix);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let activeStream = { sid: 'browser-playback', ff: {} };
  const queue = new DownloadQueue({ root: path.join(temp, 'state'),
    port: server.address().port, ffmpeg, getActiveStream: () => activeStream,
    log: { log() {}, error(...args) { throw new Error(args.join(' ')); } } });
  try {
    queue.setDirectory(output);
    const episode = channelId => ({ channelId, ip: '127.0.0.1', port: 12345,
      duration: 32, playname: '第01集', sourceMode: 1 });
    const first = queue.enqueue({ playid: 'first', episodeIndex: 0, title: '第一部', episode: episode('A'.repeat(32)) });
    const second = queue.enqueue({ playid: 'second', episodeIndex: 0, title: '第二部', episode: episode('B'.repeat(32)) });
    assert.equal(first.status, 'waiting');
    assert.equal(second.status, 'queued');
    assert.deepEqual(requests, []);
    activeStream = null;
    void queue.tick();
    await until(() => first.status === 'done' && second.status === 'done');
    assert.ok(requests.filter(c => c === 'A'.repeat(32)).length >= 2, '第一集确实断流后续取');
    assert.ok(requests.lastIndexOf('A'.repeat(32)) < requests.indexOf('B'.repeat(32)), '第二集在第一集完成后才开始');
    for (const job of [first, second]) {
      assert.ok(fs.existsSync(job.output));
      const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries',
        'format=duration:stream=codec_type', '-of', 'json', job.output], { encoding: 'utf8' }));
      assert.ok(Number(info.format.duration) >= 30);
      assert.ok(info.streams.some(s => s.codec_type === 'video'));
      const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', job.output, '-f', 'null', '-'],
        { timeout: 15000, encoding: 'utf8' });
      assert.equal(decoded.status, 0, decoded.stderr);
      assert.equal(decoded.stderr, '', 'MP4 解码不应有损坏的帧');
    }
    assert.equal(fs.readdirSync(output).filter(name => name.endsWith('.mp4')).length, 2);
  } finally {
    await queue.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('服务正常退出会保存当前片段，重启后从该进度续取', { timeout: 40000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taoxing-resume-test-'));
  const output = path.join(temp, 'output');
  fs.mkdirSync(output);
  const fixture = path.join(temp, 'source.ts');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=s=64x64:r=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', '32', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '8', '-c:a', 'aac',
    '-b:a', '32k', '-f', 'mpegts', fixture], { timeout: 15000 });
  const source = fs.readFileSync(fixture);
  let requests = 0;
  let firstResponse = null;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/leave?')) {
      firstResponse?.end();
      res.writeHead(200); res.end();
      return;
    }
    requests++;
    const percent = Number(new URL(req.url, 'http://localhost').searchParams.get('percent'));
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    if (requests === 1) {
      firstResponse = res;
      res.write(source.subarray(0, Math.floor(source.length * 0.58 / 188) * 188));
      return;
    }
    const suffix = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss',
      String(percent / 100 * 32), '-i', fixture, '-c', 'copy', '-f', 'mpegts', 'pipe:1'],
    { timeout: 15000, maxBuffer: 5e6 });
    res.end(suffix);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const opts = { root: path.join(temp, 'state'), port: server.address().port, ffmpeg,
    getActiveStream: () => null, log: { log() {}, error() {} } };
  let queue = new DownloadQueue(opts);
  try {
    queue.setDirectory(output);
    const job = queue.enqueue({ playid: 'restart', episodeIndex: 0, title: '重启测试',
      episode: { channelId: 'C'.repeat(32), ip: '127.0.0.1', port: 12345,
        duration: 32, playname: '第01集', sourceMode: 1 } });
    await until(() => job.currentSec >= 10);
    await queue.close();
    assert.equal(job.status, 'queued');
    assert.ok(job.completedSec >= 10);
    assert.ok(job.segments.length >= 1);
    queue = new DownloadQueue(opts);
    const restored = queue.jobs[0];
    assert.equal(restored.status, 'queued');
    assert.ok(restored.completedSec >= 10);
    void queue.tick();
    await until(() => restored.status === 'done');
    assert.ok(requests >= 2);
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', restored.output, '-f', 'null', '-'],
      { timeout: 15000, encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr);
    assert.equal(decoded.stderr, '');
  } finally {
    await queue.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('取消后可从队列移除，其他排队任务保持原顺序', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taoxing-remove-test-'));
  const output = path.join(temp, 'output');
  fs.mkdirSync(output);
  const queue = new DownloadQueue({ root: path.join(temp, 'state'), port: 1, ffmpeg,
    getActiveStream: () => ({ ff: {}, sid: 'browser-playback' }), log: { log() {}, error() {} } });
  try {
    queue.setDirectory(output);
    const episode = channelId => ({ channelId, ip: '127.0.0.1', port: 12345,
      duration: 60, playname: '第01集', sourceMode: 0 });
    const first = queue.enqueue({ playid: 'series', episodeIndex: 0, title: '剧集', episode: episode('A'.repeat(32)) });
    const second = queue.enqueue({ playid: 'series', episodeIndex: 1, title: '剧集', episode: episode('B'.repeat(32)) });
    assert.throws(() => queue.remove(first.id), /只能移除已取消/);
    queue.cancel(second.id);
    queue.remove(second.id);
    assert.deepEqual(queue.snapshot().jobs.map(j => j.id), [first.id]);
    assert.deepEqual(JSON.parse(fs.readFileSync(queue.stateFile, 'utf8')).jobs.map(j => j.id), [first.id]);
    assert.throws(() => queue.remove(second.id), /任务不存在/);
  } finally {
    await queue.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
