const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanName = value => {
  const name = String(value || '').normalize('NFKC')
    .replace(/[\x00-\x1f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  let short = '';
  for (const char of name) {
    if (Buffer.byteLength(short + char) > 100) break;
    short += char;
  }
  return short || '节目';
};

class DownloadQueue {
  constructor({ root, port, ffmpeg, getActiveStream, log = console }) {
    this.root = root;
    this.port = port;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffmpeg.replace(/ffmpeg$/, 'ffprobe');
    this.getActiveStream = getActiveStream;
    this.log = log;
    this.stateFile = path.join(root, 'state.json');
    this.jobsDir = path.join(root, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.directory = path.join(os.homedir(), 'Downloads');
    this.jobs = [];
    this.active = null;
    this.busy = false;
    this.closed = false;
    this.load();
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (typeof saved.directory === 'string') this.directory = saved.directory;
      if (Array.isArray(saved.jobs)) this.jobs = saved.jobs.filter(j => j && /^[a-f0-9-]{36}$/.test(j.id))
        .map(j => ({ ...j, status: ['downloading', 'waiting'].includes(j.status) ? 'queued' : j.status,
          currentSec: 0, error: j.status === 'downloading' ? '服务已重启，继续下载' : j.error }));
    } catch (e) { if (e.code !== 'ENOENT') this.log.error('[downloads] 状态读取失败', e.message); }
    this.persist();
  }

  persist() {
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ directory: this.directory, jobs: this.jobs }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  snapshot() {
    return { directory: this.directory, jobs: this.jobs.map(j => ({ ...j })) };
  }

  setDirectory(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('请选择保存目录');
    const expanded = input.trim().replace(/^~(?=\/|$)/, os.homedir());
    const directory = fs.realpathSync(expanded);
    if (!fs.statSync(directory).isDirectory()) throw new Error('路径不是文件夹');
    fs.accessSync(directory, fs.constants.W_OK);
    this.directory = directory;
    this.persist();
    return this.snapshot();
  }

  enqueue({ playid, episodeIndex, title, episode }) {
    if (typeof playid !== 'string' || !playid || !Number.isInteger(episodeIndex) || episodeIndex < 0 ||
        !episode || !/^[A-Za-z0-9_-]{8,128}$/.test(episode.channelId) ||
        !/^[A-Za-z0-9.:-]{3,255}$/.test(episode.ip) ||
        !Number.isInteger(episode.port) || episode.port < 1 || episode.port > 65535 ||
        !Number.isFinite(episode.duration) || episode.duration < 30) throw new Error('选集资源无效');
    const existing = this.jobs.find(j => j.playid === playid && j.episodeIndex === episodeIndex &&
      !['cancelled', 'failed'].includes(j.status));
    if (existing) return existing;
    this.setDirectory(this.directory);
    const id = crypto.randomUUID();
    const name = cleanName(title) + ' - ' + cleanName(episode.playname);
    const job = {
      id, playid, episodeIndex, title: String(title), playname: String(episode.playname),
      episode: { channelId: episode.channelId, ip: episode.ip, port: episode.port,
        duration: Math.round(episode.duration), sourceMode: episode.sourceMode === 0 ? 0 : 1 },
      directory: this.directory, filename: name + '.mp4', status: 'queued', segments: [],
      completedSec: 0, currentSec: 0, attempts: 0, error: '', createdAt: Date.now(),
    };
    this.jobs.push(job);
    this.persist();
    this.tick();
    return job;
  }

  cancel(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw new Error('任务不存在');
    if (job.status === 'done') throw new Error('已完成的文件不会删除');
    job.status = 'cancelled';
    job.error = '';
    if (this.active && this.active.job.id === id) {
      const { proc, sid } = this.active;
      this.stopSource(sid);
      setTimeout(() => { if (this.active?.proc === proc) proc.kill('SIGINT'); }, 5000).unref();
      setTimeout(() => { if (this.active?.proc === proc) proc.kill('SIGKILL'); }, 12000).unref();
    }
    else fs.rmSync(path.join(this.jobsDir, id), { recursive: true, force: true });
    if (!this.active || this.active.job.id !== id) { job.segments = []; job.completedSec = 0; job.currentSec = 0; }
    this.persist();
    return job;
  }

  retry(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw new Error('任务不存在');
    if (!['failed', 'cancelled'].includes(job.status)) throw new Error('只有失败或取消的任务可以重试');
    if (this.active?.job.id === id) throw new Error('正在结束上次下载，请稍后重试');
    job.status = 'queued'; job.error = ''; job.attempts = 0;
    this.persist(); this.tick();
    return job;
  }

  playbackActive() {
    const stream = this.getActiveStream();
    return !!stream && !!(stream.ff || stream.starting || stream.splicing) &&
      !String(stream.sid || '').startsWith('download-');
  }

  stopSource(sid) {
    if (!sid) return;
    const req = http.request({ hostname: '127.0.0.1', port: this.port,
      path: '/api/leave?sid=' + encodeURIComponent(sid), method: 'POST', timeout: 5000 },
    res => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
  }

  async tick() {
    if (this.busy || this.closed) return;
    const job = this.jobs.find(j => ['queued', 'waiting'].includes(j.status));
    if (!job) return;
    if (this.playbackActive()) {
      if (job.status !== 'waiting') { job.status = 'waiting'; this.persist(); }
      return;
    }
    this.busy = true;
    try { await this.run(job); }
    catch (e) { if (job.status !== 'cancelled') { job.status = 'failed'; job.error = String(e.message || e); this.persist(); this.log.error('[downloads]', job.id, job.error); } }
    finally { this.busy = false; if (!this.closed) setImmediate(() => this.tick()); }
  }

  probe(file) {
    try {
      const raw = execFileSync(this.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file],
        { encoding: 'utf8', timeout: 30000 });
      const info = JSON.parse(raw);
      const duration = Number(info.format?.duration) || 0;
      return info.streams?.some(s => s.codec_type === 'video') && duration > 0 ? duration : 0;
    } catch { return 0; }
  }

  recoverSegments(job) {
    const dir = path.join(this.jobsDir, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const good = [];
    for (const segment of job.segments || []) {
      if (!/^segment-\d+\.mp4$/.test(segment.file)) continue;
      const file = path.join(dir, segment.file);
      const duration = fs.existsSync(file) ? this.probe(file) : 0;
      if (duration >= 2) good.push({ file: segment.file, duration });
    }
    job.segments = good;
    job.completedSec = good.reduce((sum, s) => sum + s.duration, 0);
    return dir;
  }

  uniqueOutput(job) {
    const base = path.parse(job.filename);
    let name = job.filename, n = 2;
    while (fs.existsSync(path.join(job.directory, name))) name = `${base.name} (${n++})${base.ext}`;
    return path.join(job.directory, name);
  }

  async run(job) {
    const dir = this.recoverSegments(job);
    this.persist();
    let failures = 0;
    while (job.status !== 'cancelled' && !this.closed) {
      if (this.playbackActive()) { job.status = 'waiting'; this.persist(); return; }
      if (job.completedSec >= job.episode.duration - 2) return this.finish(job, dir);
      if (failures >= 3) throw new Error('淘星源连续三次未继续供数，可稍后重试');
      job.status = 'downloading'; job.error = ''; job.currentSec = 0; job.attempts++;
      const result = await this.capture(job, dir);
      if (job.status === 'cancelled') {
        fs.rmSync(dir, { recursive: true, force: true });
        job.segments = []; job.completedSec = 0; job.currentSec = 0; this.persist();
        return;
      }
      if (result.duration >= Math.min(10, Math.max(2, job.episode.duration - job.completedSec - 2))) {
        job.segments.push({ file: result.file, duration: result.duration });
        job.completedSec = job.segments.reduce((sum, s) => sum + s.duration, 0);
        failures = 0;
        this.log.log('[downloads] '+job.title+' '+job.playname+' '+job.completedSec.toFixed(0)+'/'+job.episode.duration+'s');
      } else {
        try { fs.unlinkSync(path.join(dir, result.file)); } catch {}
        failures++;
      }
      job.currentSec = 0; this.persist();
      if (this.closed) { job.status = 'queued'; this.persist(); return; }
      if (this.playbackActive()) { job.status = 'waiting'; this.persist(); return; }
      if (job.completedSec < job.episode.duration - 2) await sleep(Math.min(8000, 1500 * (failures + 1)));
    }
  }

  capture(job, dir) {
    return new Promise(resolve => {
      const n = job.segments.length;
      const file = `segment-${n}.mp4`;
      const output = path.join(dir, file);
      const duration = job.episode.duration;
      const percent = Math.max(0, Math.min(96, Math.floor(job.completedSec / duration * 100)));
      const skip = Math.max(0, job.completedSec - percent / 100 * duration);
      const sid = `download-${job.id}-${n}-${Date.now()}`;
      const params = new URLSearchParams({ channelId: job.episode.channelId,
        ip: job.episode.ip, port: String(job.episode.port), percent: String(percent),
        dur: String(duration), mode: String(job.episode.sourceMode), sid });
      const url = `http://127.0.0.1:${this.port}/vod-stream?${params}`;
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1',
        '-stats_period', '2', '-y', '-fflags', '+discardcorrupt+genpts', '-err_detect', 'ignore_err', '-i', url,
        ...(skip > 0.1 ? ['-ss', skip.toFixed(3)] : []),
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', output];
      const proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.active = { job, proc, sid };
      let lastMedia = 0, lastGrow = Date.now(), lastPersist = 0, warned = '', progressText = '';
      proc.stdout.on('data', chunk => {
        const lines = (progressText + chunk.toString()).split(/\r?\n/);
        progressText = lines.pop().slice(-200);
        for (const line of lines) {
          if (!line.startsWith('out_time_us=')) continue;
          const sec = Number(line.slice(12)) / 1e6;
          if (sec > lastMedia + 0.2) { lastMedia = sec; lastGrow = Date.now(); job.currentSec = sec; }
        }
        if (Date.now() - lastPersist > 5000) { lastPersist = Date.now(); this.persist(); }
      });
      proc.stderr.on('data', chunk => { warned = (warned + chunk.toString()).slice(-700); });
      let stopping = false;
      const monitor = setInterval(() => {
        const limit = lastMedia > 0 ? 60000 : 180000;
        if (!stopping && Date.now() - lastGrow > limit) {
          stopping = true; this.log.log('[downloads] 无数据超时，保存已有片段后续取', job.id);
          this.stopSource(sid);
          setTimeout(() => { if (this.active?.proc === proc) proc.kill('SIGINT'); }, 5000).unref();
          setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 12000).unref();
        }
      }, 5000);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearInterval(monitor);
        if (this.active?.proc === proc) this.active = null;
        const seconds = fs.existsSync(output) ? this.probe(output) : 0;
        if (warned && seconds < 2) this.log.error('[downloads] ffmpeg:', warned.slice(-300));
        resolve({ file, duration: seconds });
      };
      proc.once('error', done);
      proc.once('close', done);
    });
  }

  finish(job, dir) {
    if (job.status === 'cancelled') return;
    const output = this.uniqueOutput(job);
    const tmp = output + '.partial';
    const files = job.segments.map(s => path.join(dir, s.file));
    if (!files.length) throw new Error('没有可用的视频片段');
    if (files.length === 1) fs.copyFileSync(files[0], tmp);
    else {
      const list = path.join(dir, 'concat.txt');
      fs.writeFileSync(list, files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      execFileSync(this.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp],
      { timeout: 180000, maxBuffer: 1024 * 1024 });
    }
    const actual = this.probe(tmp);
    if (actual < job.episode.duration - 2) {
      try { fs.unlinkSync(tmp); } catch {}
      throw new Error(`文件只有 ${actual.toFixed(0)} 秒，片长应为 ${job.episode.duration} 秒`);
    }
    fs.renameSync(tmp, output);
    job.status = 'done'; job.completedSec = actual; job.currentSec = 0;
    job.output = output; job.error = ''; job.finishedAt = Date.now();
    this.persist();
    fs.rmSync(dir, { recursive: true, force: true });
    this.log.log('[downloads] 完成', output);
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const deadline = Date.now() + 15000;
    if (this.active) {
      const { proc, sid } = this.active;
      this.stopSource(sid);
      const soft = setTimeout(() => { if (this.active?.proc === proc) proc.kill('SIGINT'); }, 5000);
      const force = setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 12000);
      while (this.busy && proc.exitCode === null && Date.now() < deadline) await sleep(100);
      clearTimeout(soft);
      clearTimeout(force);
      if (this.busy && this.active?.proc === proc) proc.kill('SIGKILL');
    }
    while (this.busy && Date.now() < deadline) await sleep(50);
    this.persist();
  }
}

module.exports = { DownloadQueue };
