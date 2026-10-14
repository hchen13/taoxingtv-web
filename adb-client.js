const { execFile } = require('node:child_process');

// ADB may wait for an entire Android cold boot. Never block the HTTP server or
// the disk-buffer relay while the emulator is offline/recovering.
function createAdbClient(executable) {
  let forwards = Promise.resolve();
  const run = (args, { timeout = 15000, maxBuffer = 1024 * 1024, required = false } = {}) =>
    new Promise((resolve, reject) => {
      execFile(executable, args, { encoding: 'utf8', timeout, maxBuffer, killSignal: 'SIGKILL' },
        (error, stdout) => {
          if (error && required) reject(new Error(`ADB ${args[0]} failed: ${error.killed ? 'timeout' : error.code}`));
          else resolve(error ? '' : stdout);
        });
    });
  return (args, options) => {
    if (args[0] !== 'forward') return run(args, options);
    // A late removal must finish before a reused native port is forwarded again.
    const next = forwards.then(() => run(args, options));
    forwards = next.catch(() => {});
    return next;
  };
}

module.exports = { createAdbClient };
