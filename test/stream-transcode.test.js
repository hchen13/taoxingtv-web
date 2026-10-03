const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTranscodeArgs } = require('../stream-transcode');

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

test('不可 seek 的 MPEG-TS 续接能真正跳过重叠内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taoxing-stream-seek-'));
  try {
    const source = path.join(dir, 'source.ts');
    const made = spawnSync(ffmpeg, ['-hide_banner','-loglevel','error','-f','lavfi','-i',
      'testsrc2=s=64x64:r=10','-t','8','-c:v','libx264','-preset','ultrafast','-g','10',
      '-output_ts_offset','100','-f','mpegts',source], { timeout: 15000 });
    assert.equal(made.status, 0, String(made.stderr));
    const input = fs.readFileSync(source);
    const lengths = [];
    for (const skip of [0, 4]) {
      const out = path.join(dir, `skip-${skip}.ts`);
      const run = spawnSync(ffmpeg, buildTranscodeArgs('pipe:0', false, skip, 0),
        { input, timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
      assert.equal(run.status, 0, String(run.stderr).slice(-300));
      fs.writeFileSync(out, run.stdout);
      const probe = spawnSync(ffprobe, ['-v','error','-show_entries','format=duration',
        '-of','default=noprint_wrappers=1:nokey=1',out], { encoding: 'utf8', timeout: 5000 });
      assert.equal(probe.status, 0, probe.stderr);
      lengths.push(Number(probe.stdout.trim()));
    }
    assert.ok(lengths[0] > 7.5 && lengths[0] < 8.5, `原流 ${lengths[0]} 秒`);
    assert.ok(lengths[1] > 3.5 && lengths[1] < 4.5, `跳过后 ${lengths[1]} 秒`);

    // 首段在第 4 秒断开后，续接段应从第 4 秒起并接在同一时间轴上。
    const firstArgs = buildTranscodeArgs('pipe:0', false, 0, 0);
    firstArgs.splice(firstArgs.indexOf('-f'), 0, '-t', '4');
    const first = spawnSync(ffmpeg, firstArgs,
      { input, timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    const second = spawnSync(ffmpeg, buildTranscodeArgs('pipe:0', false, 4, 4),
      { input, timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    assert.equal(first.status, 0, String(first.stderr).slice(-300));
    assert.equal(second.status, 0, String(second.stderr).slice(-300));
    const joined = path.join(dir, 'joined.ts');
    fs.writeFileSync(joined, Buffer.concat([first.stdout, second.stdout]));
    const probe = spawnSync(ffprobe, ['-v','error','-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1',joined], { encoding: 'utf8', timeout: 5000 });
    assert.equal(probe.status, 0, probe.stderr);
    const joinedDuration = Number(probe.stdout.trim());
    assert.ok(joinedDuration > 7.5 && joinedDuration < 8.5, `续接后 ${joinedDuration} 秒`);
    const decoded = spawnSync(ffmpeg, ['-hide_banner','-loglevel','error','-i',joined,'-f','null','-'],
      { timeout: 15000 });
    assert.equal(decoded.status, 0, String(decoded.stderr).slice(-300));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
