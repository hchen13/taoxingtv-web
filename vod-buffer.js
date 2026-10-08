const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');

// Track the transport clock of bytes actually delivered to the browser. ffmpeg's
// progress instead describes bytes already prefetched, possibly minutes ahead.
class TransportClock {
  constructor() { this.tail = Buffer.alloc(0); this.previous = null; this.seconds = 0; }
  push(chunk) {
    const data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    let i = 0;
    for (; i + 188 <= data.length; i += 188) {
      if (data[i] !== 0x47) { i -= 187; continue; }
      if (!(data[i + 3] & 0x20) || data[i + 4] < 7 || !(data[i + 5] & 0x10)) continue;
      const pcr = data[i+6]*33554432 + data[i+7]*131072 + data[i+8]*512 + data[i+9]*2 + (data[i+10]>>7);
      if (this.previous !== null) {
        let delta = pcr - this.previous;
        if (delta < -4294967296) delta += 8589934592;
        if (delta >= 0 && delta < 90000 * 3600) this.seconds += delta / 90000;
      }
      this.previous = pcr;
    }
    this.tail = Buffer.from(data.subarray(i));
    return this.seconds;
  }
}

// A bounded disk ring separates fast prefetch from paced browser delivery. The
// file is unlinked immediately: closing, cancelling or crashing leaves no movie
// file behind. Only the current viewing session owns this temporary reserve.
class VodBuffer extends Writable {
  constructor({ directory, capacity = 256 * 1024 * 1024 }) {
    super({ highWaterMark: 256 * 1024, autoDestroy: false });
    if (!Number.isSafeInteger(capacity) || capacity < 188) throw new Error('Invalid VOD buffer capacity');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, crypto.randomUUID() + '.ring');
    this.fd = fs.openSync(file, 'wx+', 0o600);
    fs.unlinkSync(file);
    this.capacity = capacity;
    this.written = 0; this.read = 0;
    this.deliveryPaused = false; this.waitingForSpace = false;
    this.inputEnded = false; this.stopped = false;
    this.waiters = new Set(); this.operations = new Set();
  }

  get pendingBytes() { return this.written - this.read; }
  get backpressured() { return this.waitingForSpace || this.pendingBytes >= this.capacity; }
  setDeliveryPaused(value) { this.deliveryPaused = !!value; this.wake(); }
  wake() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  async until(predicate) {
    while (!this.stopped && !predicate()) await new Promise(resolve => this.waiters.add(resolve));
    return !this.stopped;
  }
  io(method, buffer, offset, length, position) {
    const p = new Promise((resolve, reject) => fs[method](this.fd, buffer, offset, length, position,
      (error, bytes) => error ? reject(error) : resolve(bytes)));
    this.operations.add(p);
    p.then(() => this.operations.delete(p), () => this.operations.delete(p));
    return p;
  }
  _write(chunk, encoding, callback) {
    this.append(chunk).then(() => callback(), callback);
  }
  async append(chunk) {
    for (let offset = 0; offset < chunk.length;) {
      this.waitingForSpace = this.pendingBytes >= this.capacity;
      if (!await this.until(() => this.pendingBytes < this.capacity) || this.stopped) throw new Error('VOD buffer closed');
      this.waitingForSpace = false;
      const position = this.written % this.capacity;
      const length = Math.min(chunk.length-offset, this.capacity-position, this.capacity-this.pendingBytes);
      const bytes = await this.io('write', chunk, offset, length, position);
      if (!bytes) throw new Error('VOD buffer write made no progress');
      offset += bytes; this.written += bytes; this.wake();
    }
  }
  _final(callback) { this.inputEnded = true; this.wake(); callback(); }
  _destroy(error, callback) {
    this.stopped = true; this.wake();
    Promise.allSettled([...this.operations]).then(() => fs.close(this.fd, closeError => callback(error || closeError)));
  }

  async relay(response, onData = () => {}) {
    const onDrain = () => this.wake(), onClose = () => this.destroy();
    response.on('drain', onDrain); response.once('close', onClose);
    try {
      while (await this.until(() => (this.inputEnded && this.pendingBytes === 0) ||
          (!this.deliveryPaused && !response.writableNeedDrain && this.pendingBytes > 0))) {
        if (this.stopped) return;
        if (this.inputEnded && !this.pendingBytes) { response.end(); return; }
        const position = this.read % this.capacity;
        const buffer = Buffer.allocUnsafe(Math.min(65536, this.pendingBytes, this.capacity-position));
        const bytes = await this.io('read', buffer, 0, buffer.length, position);
        if (this.stopped) return;
        if (!bytes) throw new Error('VOD buffer read made no progress');
        this.read += bytes; this.wake();
        const data = buffer.subarray(0, bytes);
        response.write(data); onData(data);
      }
    } finally {
      response.off('drain', onDrain); response.off('close', onClose);
      this.destroy();
    }
  }
}

module.exports = { VodBuffer, TransportClock };
