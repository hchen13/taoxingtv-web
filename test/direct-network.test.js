const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const nic=Object.entries(os.networkInterfaces()).find(([name,addresses])=>
  /^en\d+$/.test(name) && addresses.some(a=>a.family==='IPv4'&&!a.internal));
const canCompile=process.platform==='darwin' && nic && spawnSync('/usr/bin/xcrun',['--find','clang']).status===0;
test('macOS direct sockets preserve loopback, cover UDP sends, and fail closed without the NIC', {skip:!canCompile}, () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'txtv-network-'));
  try {
    const library=path.join(directory,'direct.dylib');
    const emulator=path.join(directory,'qemu-system-network-test');
    const ordinary=path.join(directory,'ordinary-network-test');
    const build=args=>execFileSync('/usr/bin/xcrun',['clang','-Wall','-Wextra','-Werror',...args],{timeout:30000});
    build(['-dynamiclib',path.join(__dirname,'../native/direct-network.c'),'-o',library]);
    build([path.join(__dirname,'fixtures/direct-network.c'),'-o',emulator]);
    fs.copyFileSync(emulator,ordinary);
    const ip=nic[1].find(a=>a.family==='IPv4'&&!a.internal).address;
    const run=(binary,mode,iface=nic[0])=>{
      const result=spawnSync(binary,[mode,nic[0],ip],{encoding:'utf8',timeout:10000,
        env:{...process.env,DYLD_INSERT_LIBRARIES:library,TXTV_DIRECT_INTERFACE:iface}});
      assert.equal(result.status,0,result.stderr||String(result.error));
    };
    run(emulator,'bound');
    run(ordinary,'normal'); // Helper/other app processes must not acquire the emulator's socket policy.
    run(emulator,'missing','en99999');
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
