const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { detectPhysicalInterface } = require('./network-interface');

function directNetworkMode({ env = process.env, platform = process.platform,
  file = path.join(__dirname, 'direct-network.json') } = {}) {
  let setting = env.TXTV_DIRECT_INTERFACE;
  if (setting === undefined && fs.existsSync(file)) {
    let config;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { throw new Error('无法读取 direct-network.json；请检查 JSON 格式'); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('direct-network.json 必须是配置对象');
    setting = config.interface;
  }
  setting ??= platform === 'darwin' ? 'auto' : 'off';
  if (typeof setting !== 'string') throw new Error('直连配置应为 auto、off 或物理网卡名');
  setting = setting.trim();
  if (!setting || setting === 'off') return 'off'; // Empty values retain the previous explicit opt-out.
  if (platform !== 'darwin') throw new Error('模拟器网卡直连模式目前仅支持 macOS');
  if (setting !== 'auto' && !/^en\d+$/.test(setting)) throw new Error('直连配置应为 auto、off 或 en* 物理网卡名');
  return setting;
}

function inspectDirectNetwork() {
  const mode = directNetworkMode();
  if (mode === 'off') return { mode };
  return { mode: mode === 'auto' ? 'auto' : 'manual', ...detectPhysicalInterface({ requested: mode }) };
}

// Only the spawned emulator receives this environment. Detection is read-only;
// no parent environment, proxy configuration, DNS or system route is modified.
function emulatorNetworkEnv() {
  const selection = inspectDirectNetwork();
  if (selection.mode === 'off') return process.env;
  const name = selection.interface;
  if (process.platform !== 'darwin') throw new Error('模拟器网卡直连模式目前仅支持 macOS');
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
  console.log('[network] '+(selection.mode === 'auto' ? '自动识别' : '手动指定')+'物理出口 '+
    name+'（'+selection.address+' → '+selection.gateway+'；'+selection.reason+'），模拟器外连绑定此网卡');
  return { ...process.env, TXTV_DIRECT_INTERFACE: name,
    DYLD_INSERT_LIBRARIES: [process.env.DYLD_INSERT_LIBRARIES, library].filter(Boolean).join(':') };
}

module.exports = { emulatorNetworkEnv, directNetworkMode, inspectDirectNetwork };

// Read-only diagnosis: does not compile, start an emulator or change networking.
if (require.main === module) {
  try { console.log(JSON.stringify(inspectDirectNetwork(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
