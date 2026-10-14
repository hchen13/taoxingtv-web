const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectPhysicalInterface } = require('../network-interface');
const { directNetworkMode } = require('../direct-network');

const ipv4 = address => [{ address, family: 'IPv4', internal: false }];
const route = (name, gateway = '192.168.10.1', flags = 'UP,GATEWAY,DONE,IFSCOPE') =>
  `   route to: default\ndestination: default\n    gateway: ${gateway}\n  interface: ${name}\n      flags: <${flags}>\n`;

function mac({ devices = ['en0'], interfaces = { en0: ipv4('192.168.10.20') },
  order = devices, inactive = [], defaults = devices, defaultInterface = 'en0', primary = defaultInterface } = {}) {
  const outputs = new Map([
    ['-listallhardwareports', devices.map(name => `Hardware Port: Adapter (${name})\nDevice: ${name}\nEthernet Address: 00:01:02:03:04:05`).join('\n\n')],
    ['-listnetworkserviceorder', order.map((name, i) => `(${i + 1}) Service ${name}\n(Hardware Port: Adapter, Device: ${name})`).join('\n\n')],
    ['scutil', `<dictionary> {\n  PrimaryInterface : ${primary}\n}`],
    ['-n get default', route(defaultInterface)],
  ]);
  for (const name of devices) {
    outputs.set(name, `${name}: flags=8863<UP,BROADCAST,RUNNING> mtu 1500\n\tstatus: ${inactive.includes(name) ? 'inactive' : 'active'}\n`);
    if (defaults.includes(name)) outputs.set(`-n get -ifscope ${name} default`, route(name));
  }
  const reads = [];
  const read = (command, args, input) => {
    reads.push([command, args, input]);
    if (command === '/usr/sbin/networksetup') assert.ok(['-listallhardwareports', '-listnetworkserviceorder'].includes(args[0]));
    else if (command === '/sbin/route') assert.deepEqual(args.slice(0, 2), ['-n', 'get']);
    else if (command === '/sbin/ifconfig') assert.equal(args.length, 1);
    else {
      assert.equal(command, '/usr/sbin/scutil');
      assert.equal(input, 'show State:/Network/Global/IPv4\nquit\n');
    }
    const key = command === '/usr/sbin/scutil' ? 'scutil' : args.join(' ');
    if (!outputs.has(key)) throw new Error('not in table');
    return outputs.get(key);
  };
  return { interfaces, read, reads, outputs };
}

test('Mac defaults to auto; off and manual overrides remain explicit and local', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'txtv-network-config-'));
  const file = path.join(directory, 'direct-network.json');
  const mode = (env = {}, platform = 'darwin') => directNetworkMode({ env, platform, file });
  try {
    assert.equal(mode(), 'auto');
    assert.equal(mode({}, 'linux'), 'off');
    fs.writeFileSync(file, '{"interface":"en8"}');
    assert.equal(mode(), 'en8');
    assert.equal(mode({ TXTV_DIRECT_INTERFACE: 'auto' }), 'auto');
    assert.equal(mode({ TXTV_DIRECT_INTERFACE: '' }), 'off');
    assert.equal(mode({ TXTV_DIRECT_INTERFACE: 'off' }, 'linux'), 'off');
    assert.throws(() => mode({ TXTV_DIRECT_INTERFACE: 'auto' }, 'linux'), /macOS/);
    assert.throws(() => mode({ TXTV_DIRECT_INTERFACE: 'utun4' }), /物理网卡/);
    assert.throws(() => mode({ TXTV_DIRECT_INTERFACE: false }), /配置/);
    fs.writeFileSync(file, '{"interface":""}');
    assert.equal(mode(), 'off');
    fs.writeFileSync(file, '{"interface":"auto"}');
    assert.equal(mode(), 'auto');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => mode(), /JSON/);
    assert.equal(mode({ TXTV_DIRECT_INTERFACE: 'off' }), 'off');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('another Mac can use Wi-Fi en0 even with TUN as the default route', () => {
  const state = mac({ devices: ['en0', 'bridge0', 'utun4'], order: ['en0'],
    interfaces: { en0: ipv4('192.168.10.20'), bridge0: ipv4('10.1.1.1'), utun4: ipv4('198.18.0.1') },
    defaultInterface: 'utun4', primary: 'en0' });
  assert.deepEqual(detectPhysicalInterface(state), {
    interface: 'en0', address: '192.168.10.20', gateway: '192.168.10.1', reason: 'primary-service',
  });
  assert.ok(!state.reads.some(([, args]) => args.includes('utun4') || args.includes('bridge0')));
});

test('a USB Ethernet interface is selected without assuming an en number or hardware label', () => {
  const state = mac({ devices: ['en0', 'en12'], order: ['en12', 'en0'],
    interfaces: { en0: ipv4('192.168.10.20'), en12: ipv4('10.20.0.2') }, defaultInterface: 'en12' });
  state.outputs.set('-n get -ifscope en12 default', route('en12', '10.20.0.1'));
  assert.equal(detectPhysicalInterface(state).interface, 'en12');
  assert.equal(detectPhysicalInterface(state).gateway, '10.20.0.1');
});

test('active physical default takes precedence over enumeration and service order', () => {
  const state = mac({ devices: ['en0', 'en8'], interfaces: { en0: ipv4('192.168.10.20'), en8: ipv4('10.0.0.2') },
    order: ['en8', 'en0'], defaultInterface: 'en0', primary: 'en8' });
  assert.equal(detectPhysicalInterface(state).interface, 'en0');
  assert.equal(detectPhysicalInterface(state).reason, 'default-route');
});

test('when TUN owns both primary and default, scoped physical routes follow service order', () => {
  const state = mac({ devices: ['en0', 'en8'], interfaces: { en0: ipv4('192.168.10.20'), en8: ipv4('10.0.0.2') },
    order: ['en8', 'en0'], defaultInterface: 'utun4' });
  assert.equal(detectPhysicalInterface(state).interface, 'en8');
  assert.equal(detectPhysicalInterface(state).reason, 'service-order');
});

test('disconnected Ethernet with a stale IPv4 address is not selected ahead of connected Wi-Fi', () => {
  const state = mac({ devices: ['en0', 'en1'], interfaces: { en0: ipv4('10.0.0.2'), en1: ipv4('192.168.10.20') },
    inactive: ['en0'], defaultInterface: 'utun4' });
  assert.equal(detectPhysicalInterface(state).interface, 'en1');
});

test('disabled services, link-local addresses, and LAN-only interfaces are not Internet exits', () => {
  const state = mac({ devices: ['en0', 'en1', 'en8', 'en9'],
    interfaces: { en0: ipv4('10.0.0.2'), en1: ipv4('169.254.2.3'), en8: ipv4('192.168.10.20'), en9: ipv4('172.20.0.2') },
    defaults: ['en0', 'en1', 'en9'], defaultInterface: 'utun4' });
  state.outputs.set('-listnetworkserviceorder', '(*) Disabled\n(Hardware Port: Ethernet, Device: en0)\n(1) Connected\n(Hardware Port: USB, Device: en9)');
  assert.equal(detectPhysicalInterface(state).interface, 'en9');
});

test('a scoped lookup returning TUN or a rejected route does not qualify as direct', () => {
  const state = mac();
  state.outputs.set('-n get -ifscope en0 default', route('utun4'));
  assert.throws(() => detectPhysicalInterface(state), /未找到/);
  state.outputs.set('-n get -ifscope en0 default', route('en0', '192.168.10.1', 'UP,GATEWAY,REJECT'));
  assert.throws(() => detectPhysicalInterface(state), /未找到/);
});

test('manual selection is validated and never falls back to another NIC or TUN', () => {
  const state = mac({ devices: ['en0', 'en8'], interfaces: { en0: ipv4('192.168.10.20'), en8: ipv4('10.0.0.2') } });
  assert.equal(detectPhysicalInterface({ ...state, requested: 'en8' }).reason, 'manual');
  state.outputs.set('en8', 'en8: flags=8863<UP,RUNNING>\nstatus: inactive\n');
  assert.throws(() => detectPhysicalInterface({ ...state, requested: 'en8' }), /指定网卡 en8/);
  assert.throws(() => detectPhysicalInterface({ ...state, requested: 'utun4' }), /不是本机物理网卡/);
  assert.throws(() => detectPhysicalInterface({ ...state, requested: 'en999' }), /不是本机物理网卡/);
});

test('offline, IPv6-only, and unreadable hardware states fail visibly', () => {
  assert.throws(() => detectPhysicalInterface(mac({ interfaces: {} })), /未找到/);
  assert.throws(() => detectPhysicalInterface(mac({ interfaces: { en0: [{ family: 'IPv6', address: '2001:db8::1' }] } })), /IPv4/);
  const state = mac();
  state.outputs.delete('-listallhardwareports');
  assert.throws(() => detectPhysicalInterface(state), /无法读取/);
});

test('missing preference data allows a single physical exit but rejects ambiguous exits', () => {
  const state = mac({ defaultInterface: 'utun4', order: [] });
  assert.equal(detectPhysicalInterface(state).reason, 'only-physical-route');
  const multiple = mac({ devices: ['en0', 'en8'], order: [], defaultInterface: 'utun4',
    interfaces: { en0: ipv4('192.168.10.20'), en8: ipv4('10.0.0.2') } });
  assert.throws(() => detectPhysicalInterface(multiple), /多个物理出口/);
});

test('each emulator start re-detects the network instead of retaining the previous Mac or NIC', () => {
  const state = mac({ devices: ['en0', 'en8'], interfaces: { en0: ipv4('192.168.10.20'), en8: ipv4('10.0.0.2') } });
  assert.equal(detectPhysicalInterface(state).interface, 'en0');
  state.outputs.set('en0', 'en0: flags=8863<UP,RUNNING>\nstatus: inactive\n');
  state.outputs.set('-n get default', route('en8'));
  assert.equal(detectPhysicalInterface(state).interface, 'en8');
});
