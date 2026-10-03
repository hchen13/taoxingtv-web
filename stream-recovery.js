class DeadPortRestartPolicy {
  constructor({ now = () => Date.now(), cooldownMs = 5 * 60 * 1000 } = {}) {
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.lastFailureAt = null;
    this.lastRestartAt = null;
  }

  shouldRestart(portCount, { nearEnd = false, startupWarmup = false } = {}) {
    if (portCount < 1) return false;
    const now = this.now();
    if (this.lastFailureAt === null || now - this.lastFailureAt >= this.cooldownMs) this.failures = 0;
    this.failures += portCount;
    this.lastFailureAt = now;
    // 冷启动时首个坏端口可能只是 P2P 初始化；片尾首个坏端口也可能是文件尾。
    if (startupWarmup && this.failures === 1) return false;
    if (nearEnd && this.failures < 2) return false;
    // 连续坏端口跨越前端自动重试计数；同一故障最多每五分钟冷重启一次。
    if (this.lastRestartAt !== null && now - this.lastRestartAt < this.cooldownMs) return false;
    this.lastRestartAt = now;
    return true;
  }

  succeeded() {
    this.failures = 0;
    this.lastFailureAt = null;
    this.lastRestartAt = null;
  }
}

module.exports = { DeadPortRestartPolicy };
