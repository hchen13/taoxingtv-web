const frida = require('frida'); const fs = require('fs');
(async () => {
  const dev = await frida.getUsbDevice();
  const apps = await dev.enumerateApplications();
  const app = apps.find(a => a.identifier === 'com.wys.iptvgo');
  if (!app || !app.pid) throw new Error('app not running');
  const session = await dev.attach(app.pid);
  const script = await session.createScript(fs.readFileSync('agent.js','utf8'));
  script.message.connect(m => { if(m.type==='error') console.error('SCRIPT ERR:', m.description); });
  await script.load();
  const data = await script.exports.dump();
  console.log('直播频道数:', data.live.length, ' 回放频道数:', data.backplay.length, ' 到期:', data.expiredTime);
  console.log('=== 前 8 个直播频道 ===');
  data.live.slice(0,8).forEach((c,i) => console.log(`${i+1}. [${c.sort}] ${c.name}  chid=${c.channelId} link=${c.link}`));
  fs.writeFileSync('catalog-live.json', JSON.stringify(data, null, 2));
  console.log('\n完整目录已存 catalog-live.json');
  await session.detach(); process.exit(0);
})().catch(e => { console.error('ERR:', e.message||e); process.exit(1); });
