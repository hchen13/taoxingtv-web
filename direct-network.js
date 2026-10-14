const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Local opt-in only. This module never changes the parent environment, proxy
// configuration, DNS settings or routing table.
function emulatorNetworkEnv() {
  const file = path.join(__dirname, 'direct-network.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const name = process.env.TXTV_DIRECT_INTERFACE ?? config.interface ?? '';
  if (!name) return process.env;
  if (process.platform !== 'darwin') throw new Error('模拟器网卡直连模式目前仅支持 macOS');
  if (typeof name !== 'string' || !/^en\d+$/.test(name) ||
      !os.networkInterfaces()[name]?.some(address => address.family === 'IPv4' && !address.internal)) {
    throw new Error('直连网卡不可用：'+name+'；请选择有 IPv4 地址的 en* 物理网卡');
  }
  const source = path.join(__dirname, 'native/direct-network.c');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,16);
  const directory = path.join(__dirname, 'cache/direct-network');
  const library = path.join(directory, process.arch+'-'+hash+'.dylib');
  if (!fs.existsSync(library)) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = library+'.'+process.pid+'.tmp';
    try {
      execFileSync('/usr/bin/xcrun', ['clang','-dynamiclib','-std=c11','-O2','-Wall','-Wextra','-Werror',
        source,'-o',temporary], { stdio: 'pipe', timeout: 30000 });
      fs.renameSync(temporary, library);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) {}
      throw new Error('直连模块编译失败，请检查 Xcode Command Line Tools：'+String(error.stderr||error.message).slice(0,500));
    }
  }
  console.log('[network] 模拟器出站连接绑定物理网卡 '+name+'（本地 ADB/Frida 不变）');
  return { ...process.env, TXTV_DIRECT_INTERFACE: name,
    DYLD_INSERT_LIBRARIES: [process.env.DYLD_INSERT_LIBRARIES, library].filter(Boolean).join(':') };
}

module.exports = { emulatorNetworkEnv };
