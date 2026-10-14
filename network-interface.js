const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

function readNetworkState(command, args, input) {
  return execFileSync(command, args, {
    input, encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function usableIPv4(address) {
  return net.isIPv4(address || '') && !/^(0|127)\./.test(address) &&
    !address.startsWith('169.254.');
}

function routeInfo(output) {
  const field = name => new RegExp('^\\s*' + name + ':\\s*(\\S+)', 'm').exec(output)?.[1];
  const flags = (field('flags') || '').replace(/[<>]/g, '').split(',');
  if (!['default', '0.0.0.0'].includes(field('destination')) ||
      !usableIPv4(field('gateway')) || !flags.includes('UP') ||
      flags.some(flag => ['REJECT', 'BLACKHOLE'].includes(flag))) return null;
  return { interface: field('interface'), gateway: field('gateway') };
}

function serviceOrder(output) {
  const services = [];
  let enabled = false;
  for (const line of output.split('\n')) {
    const heading = /^\((\d+|\*)\)\s+(.+)$/.exec(line.trim());
    if (heading) enabled = heading[1] !== '*' && !heading[2].startsWith('*');
    const device = /\(Hardware Port:.*?, Device:\s*([^,)]+)\)/.exec(line);
    if (device) services.push({ interface: device[1].trim(), enabled });
  }
  return services;
}

// All commands here are reads. In particular, route uses only GET, including
// interface-scoped lookups when the unscoped default belongs to a VPN/TUN.
function detectPhysicalInterface({ requested = 'auto', interfaces = os.networkInterfaces(), read = readNetworkState } = {}) {
  const query = (command, args, input) => {
    try { return String(read(command, args, input)); } catch (_) { return ''; }
  };
  const hardware = [...query('/usr/sbin/networksetup', ['-listallhardwareports'])
    .matchAll(/^Device:\s*(en\d+)\s*$/gm)].map(match => match[1]);
  if (!hardware.length) throw new Error('无法读取 macOS 物理网卡列表；未启用直连，也不会自动改用代理');
  if (requested !== 'auto' && !hardware.includes(requested)) {
    throw new Error('直连网卡不是本机物理网卡：' + requested + '；可改用 auto 自动识别');
  }
  const services = serviceOrder(query('/usr/sbin/networksetup', ['-listnetworkserviceorder']));
  const disabled = new Set(services.filter(service => !service.enabled).map(service => service.interface));
  const candidates = [];
  for (const name of new Set(hardware)) {
    if (requested !== 'auto' && name !== requested) continue;
    if (disabled.has(name) && !services.some(service => service.interface === name && service.enabled)) continue;
    const address = interfaces[name]?.find(item =>
      (item.family === 'IPv4' || item.family === 4) && !item.internal && usableIPv4(item.address))?.address;
    if (!address) continue;
    const link = query('/sbin/ifconfig', [name]);
    const flags = /flags=\w+<([^>]+)>/.exec(link)?.[1].split(',') || [];
    if (!flags.includes('UP') || !/^\s*status:\s*active\s*$/m.test(link)) continue;
    const route = routeInfo(query('/sbin/route', ['-n', 'get', '-ifscope', name, 'default']));
    if (route?.interface === name) candidates.push({ ...route, address });
  }
  if (!candidates.length) {
    throw new Error((requested === 'auto' ? '未找到' : '指定网卡 ' + requested + ' 不是') +
      '已连接且有 IPv4 默认出口的物理网卡；请检查网络后重试，直连不会退回代理');
  }
  if (requested !== 'auto') return { ...candidates[0], reason: 'manual' };

  const primary = /PrimaryInterface\s*:\s*(\S+)/.exec(query('/usr/sbin/scutil', [],
    'show State:/Network/Global/IPv4\nquit\n'))?.[1];
  const defaultRoute = routeInfo(query('/sbin/route', ['-n', 'get', 'default']));
  for (const [name, reason] of [
    [defaultRoute?.interface, 'default-route'], [primary, 'primary-service'],
    ...services.filter(service => service.enabled).map(service => [service.interface, 'service-order']),
  ]) {
    const candidate = candidates.find(item => item.interface === name);
    if (candidate) return { ...candidate, reason };
  }
  if (candidates.length === 1) return { ...candidates[0], reason: 'only-physical-route' };
  throw new Error('存在多个物理出口，但无法确定系统优先级：' + candidates.map(item => item.interface).join(', ') +
    '；请用 TXTV_DIRECT_INTERFACE 指定，未自动猜测出口');
}

module.exports = { detectPhysicalInterface };
