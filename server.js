const express = require('express');
const frida = require('frida');
const http = require('http');
const fs = require('fs');
const pathMod = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const { pinyin } = require('pinyin-pro');

const ADB = process.env.ADB || 'adb';
const EMULATOR = process.env.EMULATOR || 'emulator';
const AVD = process.env.AVD || 'TaoxingTV';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const PKG = 'com.wys.iptvgo';
const CREDS_FILE = __dirname + '/creds.json';  // 本地保存的登录凭据(gitignore,永不进仓库),用于登出/重置后自动登录
const PORT = process.env.PORT || 8090;
const IDLE_MS = parseInt(process.env.IDLE_MS || '90000', 10);
const FRIDA_BIN = '/data/local/tmp/frida-server';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function adb(args, opts={}) { try { return execFileSync(ADB, args, {encoding:'utf8', timeout: opts.timeout||15000}); } catch(e){ return ''; } }
function adbSu(cmd) { return adb(['shell','su','-c',cmd]); }
function readDevFile(dev){
  try { const b64 = execFileSync(ADB, ['exec-out','su','-c','base64 "'+dev+'" 2>/dev/null'], {encoding:'utf8', maxBuffer:64*1024*1024, timeout:15000});
    const buf = Buffer.from(b64.replace(/\s/g,''), 'base64'); return buf.length>0 ? buf : null;
  } catch(e){ return null; }
}
// FFmpeg 容错解码 + 硬件重编码;-readrate 1.0 按实时读(不追上P2P直播边缘),initial_burst 快读垫底
function spawnTranscode(srcPort, isLive){
  // 直播:transient P2P 抖动时底层重连更顺;点播:绝不重连——EOF=内容真结束,重连会反复GET已结束端口把原生app打崩
  const rec = isLive ? ['-reconnect','1','-reconnect_streamed','1','-reconnect_on_network_error','1','-reconnect_delay_max','4'] : [];
  // 点播:P2P会下载超前,用2x读+编码器全速产出,填出~30秒深缓冲吸收P2P抖动(像原生mpv,不卡);
  // 直播:1x实时读 + 断供后 catchup 4x 把源的追赶突发拉进来回填(实测源快读不会EOF,稳定攒~11秒深缓冲),initial_burst 开台垫底
  const rate = isLive ? ['-readrate','1.0','-readrate_catchup','4.0','-readrate_initial_burst','15'] : ['-readrate','2.0'];  // 点播:2x持续读快速填/回填深缓冲;上限由 serveStream 反馈节流控制(有界~60秒)
  const venc = isLive
    ? ['-c:v','h264_videotoolbox','-realtime','1','-b:v','8M','-g','60','-pix_fmt','yuv420p']
    : ['-c:v','h264_videotoolbox','-b:v','8M','-g','60','-pix_fmt','yuv420p'];
  const rwto = isLive ? ['-rw_timeout','30000000'] : [];   // 点播:根本不设读超时。ffmpeg只要连接(页面)还开着就一直活,暂停多久都不自杀;页面关/掉线→res close→teardown回收(见serveStream);真卡死(源挂/App崩)由前端看门狗冻结~24s重取兜底。直播保留30s,与-reconnect配套扛P2P抖动
  const args=['-hide_banner','-loglevel','error', ...rec, ...rwto,
    '-fflags','+discardcorrupt+genpts','-err_detect','ignore_err',
    ...rate,
    '-i','http://127.0.0.1:'+srcPort+'/',
    ...venc,
    '-c:a','aac','-b:a','160k','-ac','2',
    '-f','mpegts','-muxdelay','0','-muxpreload','0','pipe:1'];
  const ff=spawn(FFMPEG,args,{stdio:['ignore','pipe','pipe']});
  let errbuf='';
  ff.stderr.on('data',d=>{ errbuf=(errbuf+d.toString()).slice(-1000); });
  ff.on('exit',(code,sig)=>{ if(sig!=='SIGKILL') console.log('[ff exit] code='+code+' sig='+sig+' | '+errbuf.replace(/\s+/g,' ').trim().slice(-260)); });
  return ff;
}

// ---------- 引擎(模拟器)生命周期 ----------
let state='off', bootStep='', bootPromise=null;
let script=null, session=null, catalog=null;
// current: 当前活动流。token=递增唯一标识(不用端口,端口会复用);ended=收到tellMessage(2)真结束;ffExited=ffmpeg已退出
let current={ token:0, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false };
let curBuf=0;  // 前端上报的点播缓冲深度(秒),用于反馈节流
let lastActivity=Date.now();

function emulatorRunning(){ return /emulator-\d+\s+device/.test(adb(['devices'])); }
async function waitBootCompleted(timeoutMs=90000){ const t0=Date.now();
  while(Date.now()-t0<timeoutMs){ if(adb(['shell','getprop','sys.boot_completed']).trim()==='1')return true; await sleep(2000); } return false; }
function fridaServerUp(){ return /frida-server/.test(adbSu('pgrep -l frida-server || true')); }
function appRunning(){ return adb(['shell','pidof',PKG]).trim().length>0; }

function cleanupCurrent(){
  if(current.ff){ try{current.ff.kill('SIGKILL');}catch(e){} }
  if(current.port){ try{ if(script)script.exports.stop().catch(()=>{}); }catch(e){} adb(['forward','--remove','tcp:'+current.port]); }
  current={token:current.token, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false};
}

let needColdRestart=false;
async function bootEmulator(){
  if(state==='ready' && script && emulatorRunning()) return;
  if(bootPromise) return bootPromise;
  bootPromise=(async()=>{ state='booting';
    try {
      if(!emulatorRunning()){ bootStep='启动模拟器(全新冷启动)…';
        const p=spawn(EMULATOR,['-avd',AVD,'-no-window','-no-audio','-no-boot-anim','-gpu','swiftshader_indirect','-no-metrics','-no-snapshot'],{detached:true,stdio:'ignore'}); p.unref();   // -no-snapshot:每次全新冷启动,不加载/保存快照,不继承上次残留状态(登录仍在磁盘userdata里,会自动登录)
        adb(['wait-for-device'],{timeout:120000}); }
      bootStep='等待系统就绪…'; await waitBootCompleted();
      bootStep='启动取流引擎…'; if(!fridaServerUp()){ adbSu('nohup '+FRIDA_BIN+' >/dev/null 2>&1 &'); await sleep(1500); }
      if(needColdRestart){ bootStep='冷重启应用…'; adb(['shell','am','force-stop',PKG]); await sleep(2000); needColdRestart=false; }
      let coldLaunch=false;
      if(!appRunning()){ adb(['shell','monkey','-p',PKG,'-c','android.intent.category.LEANBACK_LAUNCHER','1']); coldLaunch=true; }
      for(let i=0;i<30 && !appRunning();i++) await sleep(1000);
      if(coldLaunch){ bootStep='等待应用启动…'; await sleep(4000); }  // 短暂等应用进程起来再注入,随后按真实信号放行(不再盲等12s)
      bootStep='注入引擎…'; await attach();
      if(coldLaunch){ bootStep='等待频道数据就绪…';   // 就绪门:等频道加载完成(icChart挂表成功的信号)。注:activatedTime(icAuth设备授权)在无头环境永远为0——那是HomeActivity的UI流程,我们绕过了界面直接Frida调vodStart,故不能作为门条件(实测等3分钟仍为0)
        let rdy={};
        for(let i=0;i<20;i++){ try{ rdy=await script.exports.engineReady(); }catch(e){ rdy={}; } if(rdy && rdy.channels>0) break; await sleep(1500); }
        console.log('[engine] 频道就绪 ch='+(rdy.channels||0));
        // 冷启动后必须自己挂表+授权:原生靠首页UI流程跑 icChart/icAuth,我们无头绕过了UI,
        // 不做这步则 vodStart/playbackStart 一律返回 -1000(没授权),表现为"死端口/取不到流"
        bootStep='挂表授权…';
        try{ const a=await script.exports.reAuth(); console.log('[auth] 冷启动授权 chart='+a.chart+' auth='+a.auth+(a.err?' err='+a.err:'')); }catch(e){ console.log('[auth] 冷启动授权失败',e&&e.message); } }
      state='ready'; bootStep='就绪'; lastActivity=Date.now(); console.log('[engine] ready');   // 刚就绪即重置空闲计时:否则慢冷启动后 lastActivity 已过期,引擎会被空闲定时器立刻回收,导致随后 login/channels 请求 503(刷新加载不出节目的真凶)
    } catch(e){ state='off'; bootStep='启动失败: '+(e.message||e); console.error('[engine] boot failed',e); throw e; }
    finally { bootPromise=null; }
  })(); return bootPromise;
}
async function attach(){
  const dev=await frida.getUsbDevice(); let app=null;
  for(let i=0;i<40;i++){ const apps=await dev.enumerateApplications(); app=apps.find(a=>a.identifier===PKG&&a.pid>0); if(app)break; await sleep(1000); }   // 崩溃冷重启后App启动可能>20s,放宽到40s避免"应用未就位"导致彻底断
  if(!app) throw new Error('应用未就位');
  session=await dev.attach(app.pid);
  session.detached.connect((reason)=>{ cleanupCurrent(); script=null; session=null;
    if(state==='ready'){ state='off'; needColdRestart=true; console.log('[engine] session dropped ('+reason+') -> off; 下次冷重启app修复P2P核心'); } });
  script=await session.createScript(fs.readFileSync(__dirname+'/agent.js','utf8'));
  // 捕获原生播放回调 tellMessage:i==2=真结束(片尾);其他为错误码
  script.message.connect(m=>{
    if(m.type==='error'){ console.error('[agent]',m.description); return; }
    if(m.type==='send' && m.payload && typeof m.payload.tell==='number'){
      const t=m.payload.tell;
      if(t===2){ current.ended=true; console.log('[tell] 播放到结尾(tell=2)'); }
      else if([4,100,101,102,103].includes(t)){ console.log('[tell] 错误码',t); }
    }
  });
  await script.load(); console.log('[frida] attached pid',app.pid);
}
async function ensureReady(){ lastActivity=Date.now(); if(state==='ready'&&script&&emulatorRunning())return; await bootEmulator(); }
async function shutdownEmulator(reason){ if(state==='off')return; state='off'; console.log('[engine] shutting down:',reason);
  cleanupCurrent();
  try{ if(session) await session.detach(); }catch(e){} script=null; session=null;
  adb(['emu','kill']);
  for(let i=0;i<20 && emulatorRunning();i++){ await sleep(500); }  // 等模拟器真正退出,避免重启时新进程撞上正在死亡的模拟器
  bootStep=''; console.log('[engine] off (内存已释放)'); }
// 空闲回收:有活动流时(current.ff)绝不关;否则超时关
setInterval(()=>{ if(state==='ready' && !current.ff && Date.now()-lastActivity>IDLE_MS) shutdownEmulator('空闲超时'); }, 15000);

// ---------- 取流(直播/点播共用),token化+串行化 ----------
let streamMutex=Promise.resolve();
const MAX_START_TRIES = 2;     // 死端口时内部重取次数:3→2(原生几乎不重调vodStart,churn=崩溃元凶);配合就绪门+首字节耐心,死端口本就罕见。首字节门限见 serveStream 内 firstByteMs
function serveStream(req, res, playFn, label, isLive, nearEndVod){
  try{ req.socket.setKeepAlive(true, 30000); }catch(e){}   // TCP保活:暂停时页面还在→对端TCP栈会答保活探测→连接判活→ffmpeg不释放;页面真没了(断网/睡眠/崩)→探测无应答→连接断→res close→teardown回收。这才是"页面在不在"的正解,取代分不清暂停/掉线的读超时
  streamMutex = streamMutex.then(async()=>{
    const myToken = current.token + 1;
    let aborted=false; const onEarlyClose=()=>{ aborted=true; };
    req.on('close', onEarlyClose);
    try {
      await ensureReady();
      if(res.writableEnded||req.destroyed){ return; }          // 客户端已断开
      const hadStream=!!current.port; cleanupCurrent();
      // 关键:必须**等**上一路 stop 真正执行完再起新流。之前 stop 是 fire-and-forget,
      // 切集/重取时它可能在新的 vodStart 之后才到达 -> 把刚起来的新流停掉 ->
      // 表现为"端口有效但30秒不出数据"(切下一集起不来的真凶)。await 后再 settle。
      if(hadStream){ try{ if(script) await script.exports.stop(); }catch(e){} await sleep(700); }   // settle:给原生P2P引擎收尾时间,否则快速重取(seek)会拿到立即EOF的死端口
      // 启动占位:上报 starting 让 /api/streamstate 显示 alive,避免前端看门狗在服务端重取期间误判"断流"来抢流
      current={ token:myToken, chid:label, port:0, ff:null, ended:false, ffExited:false, starting:true };

      const firstByteMs = isLive ? 12000 : 30000;   // 首字节耐心:点播给 P2P 缓冲 30s(接近原生 MediaPlayer 的耐心),不再 10s 就判死端口拆流重取——这是 churn 主因之一
      let ff=null, myPort=0, buffered=null, badPortCount=0;
      for(let attempt=1; attempt<=MAX_START_TRIES && !aborted; attempt++){
        const r = await playFn();
        if(aborted) break;
        if(!r || !r.port || r.port<=0){   // -1000 = 没挂表/没授权(hint_master_or_option_error),不是内容问题
          badPortCount++;
          console.log('['+label+'] play 返回坏端口('+(r&&r.port)+') 重试 '+attempt+'/'+MAX_START_TRIES);
          try{ const a=await script.exports.reAuth(); console.log('[auth] 坏端口->温和重授权 chart='+a.chart+' auth='+a.auth); }catch(e){}   // 先重挂表+重授权(原生的补救方式),比 force-stop 整个App温和,能避开churn引发的崩溃
          try{ if(script) await script.exports.stop(); }catch(e){}   // await:避免stop晚到把下次重取的新流停掉
          await sleep(800); continue;
        }
        const port=r.port;
        adb(['forward','tcp:'+port,'tcp:'+port]);
        const cand=spawnTranscode(port, isLive);
        // 健康门限:等首字节。出数据=活端口;超时/即时退出=死端口,清理后重取
        const buf=[]; const collect=(d)=>buf.push(d); let onFirst, onCandExit, timer;
        const gotData = await new Promise(resolve=>{
          timer=setTimeout(()=>resolve(false), firstByteMs);
          onFirst=()=>resolve(true); onCandExit=()=>resolve(false);
          cand.stdout.on('data', collect);
          cand.stdout.once('data', onFirst);
          cand.once('exit', onCandExit);
        });
        clearTimeout(timer);
        cand.stdout.removeListener('data', onFirst); cand.removeListener('exit', onCandExit);
        if(gotData && !aborted){
          cand.stdout.removeListener('data', collect);
          ff=cand; myPort=port; buffered=buf;
          if(attempt>1) console.log('['+label+'] 第'+attempt+'次取流出数据(前'+(attempt-1)+'次死端口)');
          break;
        }
        console.log('['+label+'] 端口'+port+' '+(firstByteMs/1000)+'s 无数据(死端口/即时EOF) kill+重取 '+attempt+'/'+MAX_START_TRIES);
        try{ cand.kill('SIGKILL'); }catch(e){}
        try{ if(script) await script.exports.stop(); }catch(e){}   // await:同上,防止晚到的stop杀掉下一次重取
        adb(['forward','--remove','tcp:'+port]);
        await sleep(800);
      }

      if(aborted || res.writableEnded || req.destroyed){   // 客户端在启动期就走了(seek/切集时前端换流走的正是这条)
        if(ff){ try{ff.kill('SIGKILL');}catch(e){} }
        try{ if(script) await script.exports.stop(); }catch(e){}   // 必须await:否则这个stop会晚到,把用户下一次seek刚起的流停掉(端口有效却无数据)
        if(myPort) adb(['forward','--remove','tcp:'+myPort]);
        current={token:myToken, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false};
        return;
      }
      if(!ff){   // 多次重取都失败,放弃(前端会收到502后自行再试)
        current={token:myToken, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false};
        if(badPortCount>=MAX_START_TRIES && state==='ready' && !nearEndVod){   // 每次都拿到坏端口(如-1000)=原生P2P取流核心卡死(登录/频道都在但起不了流),触发冷重启App自愈。但点播接近片尾的坏端口多半是"内容真结束",不算卡死,不冷重启(前端会判作播完跳下一集)
          console.log('['+label+'] 连续坏端口,P2P核心疑似卡死 -> 触发冷重启App');
          needColdRestart=true; try{ if(session) await session.detach(); }catch(e){}
        }
        try{ res.status(502).end('播放启动失败:'+(badPortCount>=MAX_START_TRIES?'P2P核心卡死,正在自动重启,请稍候重试':'多次取流均无数据')); }catch(e){}
        return;
      }

      current={ token:myToken, chid:label, port:myPort, ff, ended:false, ffExited:false, starting:false };
      curBuf=0;
      console.log('['+label+'] port',myPort,'tok',myToken);
      res.setHeader('Content-Type','video/mp2t');
      let lastBump=0;
      ff.stdout.on('data',()=>{ const now=Date.now(); if(current.token===myToken) current.lastData=now; if(now-lastBump>4000){ lastBump=now; lastActivity=now; } });  // 播放中保活;lastData=最后出数时刻(供feeding判断:恢复时源还在不在供数)
      if(buffered && buffered.length){ for(const c of buffered){ try{ res.write(c); }catch(e){} } }  // 补发健康门限期间缓冲的首包(含PAT/PMT),不丢头
      ff.stdout.pipe(res);
      // 点播深缓冲上限:前端上报 curBuf,>60秒暂停ffmpeg(背压,~4秒短暂不会断P2P)、<56秒续读 -> 缓冲稳定56-60秒,抖动自动回填(读速2x,1x播放约60秒填满)
      let bufPaused=false;
      const throttle = isLive ? null : setInterval(()=>{
        if(current.token!==myToken){ clearInterval(throttle); return; }
        try{ if(!bufPaused && curBuf>60){ ff.stdout.pause(); bufPaused=true; } else if(bufPaused && curBuf<56){ ff.stdout.resume(); bufPaused=false; } current.throttled=bufPaused; }catch(e){}
      }, 1000);
      ff.on('error',(e)=>{ console.error('[ff spawn err]',e&&e.message); if(current.token===myToken){ current.ffExited=true; cleanupCurrent(); } try{res.end();}catch(_){} });
      ff.on('exit',()=>{ if(current.token===myToken) current.ffExited=true; });
      const teardown=()=>{ if(throttle)clearInterval(throttle); try{ff.kill('SIGKILL');}catch(e){} if(current.token===myToken){ try{if(script)script.exports.stop().catch(()=>{});}catch(e){} adb(['forward','--remove','tcp:'+myPort]); current={token:myToken,chid:null,port:null,ff:null,ended:false,ffExited:false,starting:false}; } };
      res.on('close',teardown); res.on('error',teardown);
    } catch(e){ console.error('['+label+' err]',e&&(e.stack||e.message||e)); try{res.status(503).end(''+(e.message||e));}catch(_){}
      if(current.token===myToken && current.starting){ current={token:myToken,chid:null,port:null,ff:null,ended:false,ffExited:false,starting:false}; }
    }
    finally { req.removeListener('close', onEarlyClose); }
  });
  return streamMutex;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());
app.get('/', (req,res)=>{ res.set('Cache-Control','no-cache, no-store, must-revalidate'); res.sendFile(__dirname+'/public/index.html'); });
app.get('/mpegts.js', (req,res)=>res.sendFile(__dirname+'/node_modules/mpegts.js/dist/mpegts.js'));
app.get('/api/status', (req,res)=>res.json({state, step:bootStep, playing:current.chid, ended:current.ended, alive: (!!current.ff && !current.ffExited) || !!current.starting}));
app.post('/api/wake', (req,res)=>{ lastActivity=Date.now(); bootEmulator().catch(()=>{}); res.json({state, step:bootStep}); });
app.post('/api/heartbeat', (req,res)=>{ lastActivity=Date.now(); res.json({ok:true, state}); });
// 流状态:前端用来区分"临时卡顿(alive,等就好)"vs"真结束(ended)"vs"断流(!alive)"
app.get('/api/streamstate', (req,res)=>res.json({ ended:current.ended, alive: (!!current.ff && !current.ffExited) || !!current.starting, feeding: (!!current.ff && !current.ffExited && ((Date.now()-(current.lastData||0) < 3000) || !!current.throttled)), chid:current.chid }));   // feeding:源近3秒在出数(或缓冲已满被节流)=还活着;恢复时前端据此判断要不要重连
app.get('/api/buf', (req,res)=>{ curBuf=parseFloat(req.query.d)||0; res.json({ok:true}); });  // 前端上报点播缓冲深度

// —— 登录(网页UI,全后台;用户永不碰模拟器)——
app.get('/api/loginstate', async (req,res)=>{
  try { await ensureReady(); const st = await script.exports.loginState();
    if (st.activated && !fs.existsSync(CREDS_FILE)) {  // 已登录但还没保存本地凭据 -> 从当前登录态抓一份(供自动登录,免重输)
      try { const c = await script.exports.readCreds(); if (c.account && c.password) fs.writeFileSync(CREDS_FILE, JSON.stringify({account:c.account,password:c.password}), {mode:0o600}); } catch(e){}
    }
    res.json({ loggedIn: st.activated, account: st.activated ? st.account : '', hasSavedCreds: fs.existsSync(CREDS_FILE) });
  } catch(e){ res.status(503).json({ error: ''+(e.message||e), loggedIn:false, hasSavedCreds: fs.existsSync(CREDS_FILE) }); }
});
app.post('/api/login', async (req,res)=>{
  let account, password;
  if (req.body && req.body.useSaved) {
    if (!fs.existsSync(CREDS_FILE)) return res.status(400).json({ error:'无保存的凭据' });
    try { const c = JSON.parse(fs.readFileSync(CREDS_FILE,'utf8')); account=c.account; password=c.password; } catch(e){ return res.status(500).json({error:'读取保存凭据失败'}); }
  } else { account=((req.body&&req.body.account)||'').trim(); password=((req.body&&req.body.password)||'').trim(); }
  if (!account || !password) return res.status(400).json({ error:'请输入账号和密码' });
  try {
    await ensureReady();
    await script.exports.saveCreds(account, password);   // 写入 App 的 SharedPreferences
    await sleep(800);                                     // 等 apply() 落盘
    needColdRestart = true;                               // 冷重启 App 走它自带的启动自动登录+激活
    try { if (session) await session.detach(); } catch(e){}
    await sleep(1000);
    await bootEmulator();
    let st = { activated:false };
    for (let i=0;i<15;i++){ try { st = await script.exports.loginState(); } catch(e){} if (st.activated) break; await sleep(2000); }
    if (st.activated) {
      try { fs.writeFileSync(CREDS_FILE, JSON.stringify({ account, password }), { mode:0o600 }); } catch(e){}
      catalog = null;
      res.json({ ok:true, account });
    } else {
      res.json({ ok:false, error:'登录失败:请检查账号密码,或该账号未授权此设备' });
    }
  } catch(e){ res.status(500).json({ error: ''+(e.message||e) }); }
});
app.post('/api/logout', async (req,res)=>{
  try { await ensureReady();
    await script.exports.saveCreds('', '');   // 清空 prefs 凭据
    try { fs.unlinkSync(CREDS_FILE); } catch(e){}
    needColdRestart = true; try { if (session) await session.detach(); } catch(e){}
    catalog = null; res.json({ ok:true });
  } catch(e){ res.status(500).json({ error: ''+(e.message||e) }); }
});

app.get('/api/channels', async (req,res)=>{
  try { await ensureReady(); if(!catalog) catalog=await script.exports.dump(); res.json(catalog); }
  catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});

app.get('/stream/:chid', (req,res)=>{ const chid=req.params.chid; serveStream(req,res,()=>script.exports.play(chid,0), 'live:'+chid, true); });

app.post('/api/stop', async (req,res)=>{ lastActivity=Date.now(); cleanupCurrent(); res.json({ok:true}); });
app.post('/api/leave', async (req,res)=>{ cleanupCurrent(); res.json({ok:true}); });

// ---------- VOD 点播 ----------
const xml = new XMLParser({ ignoreAttributes:false, cdataPropName:'cdata', trimValues:true });
function txt(node){ if(node==null) return ''; if(typeof node==='object'){ if('cdata'in node) return (''+node.cdata).trim(); if('#text'in node) return (''+node['#text']).trim(); return ''; } return (''+node).trim(); }
function arr(x){ return Array.isArray(x)?x:(x==null?[]:[x]); }
let vodBase=null, vodRootPath=null;
async function vodInit(){ if(vodBase&&vodRootPath)return;
  const u=await script.exports.vodUrls(); const root=xml.parse(await script.exports.vodGet(u.VODROOT_URL));
  const rp=txt(((root.vod_addrs||{}).vod_addr||{}).addr)||'/gotv/root_cn.xml';
  vodBase=u.VODBASE_URL; vodRootPath=rp; }   // 两个一起赋值,避免部分失败缓存坏值
async function vodFetch(path){ await ensureReady(); await vodInit(); const full=/^https?:|^\d/.test(path)?path:(vodBase+path); return script.exports.vodGet(full); }

app.get('/api/vod/categories', async (req,res)=>{
  try { await ensureReady(); await vodInit();
    const data=xml.parse(await script.exports.vodGet(vodBase+vodRootPath));
    const types=arr((data.Typelist||{}).Types).map(t=>({type:txt(t.type),tag:txt(t.tag),link:txt(t.link),sub:txt(t.sub)}))
      .filter(t=>['电影','电视剧','短剧','综艺','动漫','纪录片','体育'].includes(t.type));
    res.json({categories:types});
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});
app.get('/api/vod/list', async (req,res)=>{
  try { const path=req.query.path; if(!path) return res.status(400).json({error:'no path'});
    const data=xml.parse(await vodFetch(path));
    const films=arr((data.Playlist||{}).film).map(f=>({filmid:txt(f.filmid),title:txt(f.title),pic:txt(f.pic),remark:txt(f.remark),playid:txt(f.playid)}));
    res.json({films});
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});
app.get('/api/vod/detail', async (req,res)=>{
  try { const playid=req.query.playid; if(!playid) return res.status(400).json({error:'no playid'});
    const data=xml.parse(await vodFetch(playid)); const f=(data.PlayInfo||{}).film||{};
    const eps=arr(((data.PlayInfo||{}).playurl||{}).playid).map(p=>{
      const tag=txt(p.playtag); const src= tag.startsWith('relay')?txt(p.relay).slice(8):txt(p.udp).slice(6);
      const slash=src.indexOf('/'); if(slash<0) return null;
      const server=src.slice(0,slash); const channelId=src.slice(slash+1);
      const colon=server.indexOf(':'); if(colon<0) return null;
      const ip=server.slice(0,colon); const port=parseInt(server.slice(colon+1),10);
      if(!Number.isInteger(port)) return null;
      return {playname:txt(p.playname),channelId,ip,port,playtag:tag,duration:parseInt(txt(p.duration)||'0',10)};
    }).filter(Boolean);
    res.json({film:{title:txt(f.title),actor:txt(f.actor),director:txt(f.director),type:txt(f.type),area:txt(f.area),year:txt(f.year),content:txt(f.content),remark:txt(f.remark)},episodes:eps});
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});

function toInitials(han){ return pinyin(han,{pattern:'first',toneType:'none',type:'array'}).join('').toUpperCase().replace(/[^A-Z]/g,''); }
app.get('/api/search', async (req,res)=>{
  try { const q=(req.query.q||'').trim(); if(!q) return res.json({films:[]});
    await ensureReady(); await vodInit();
    const hanMatch=q.match(/[一-鿿]+/); let searchKey,filterTerm,isName;
    if(hanMatch){ searchKey=toInitials(hanMatch[0]); filterTerm=hanMatch[0]; isName=true; }
    else { searchKey=q.toUpperCase().replace(/[^A-Z0-9]/g,''); filterTerm=q; isName=false; }
    if(!searchKey) return res.json({films:[], initials:''});
    const raw=await script.exports.vodSearch('vod', searchKey, 'all', 0);
    let data; try{ data=JSON.parse(raw); }catch(e){ return res.status(502).json({error:'搜索返回异常'}); }
    let films=(data.filmlist||[]).map(f=>({filmid:f.filmid,title:f.title,pic:f.pic,remark:f.remark,playid:f.playxml,type:f.type}));
    if(isName){ const pre=films.filter(f=>(f.title||'').startsWith(filterTerm)); const inc=films.filter(f=>!(f.title||'').startsWith(filterTerm)&&(f.title||'').includes(filterTerm)); films=pre.concat(inc); }
    res.json({query:q, initials:searchKey, count:films.length, films:films.slice(0,80)});
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});

app.get('/vod-stream', (req,res)=>{
  const {channelId, ip, port}=req.query; const percent=Math.max(0,Math.min(96,parseInt(req.query.percent||'0',10)||0));  // 上限96:冷启动在最后几%会撞P2P文件尾edge-catch;向前播放可正常到真片尾
  if(!channelId||!ip||!port){ return res.status(400).end('bad params'); }
  serveStream(req,res,()=>script.exports.vodPlay(channelId, ip, parseInt(port,10), percent), 'vod:'+channelId, false, percent>=90);   // percent>=90 视为接近片尾
});

// ---------- 海报(P2P 下载 + 缓存,小并发池) ----------
const POSTER_DIR=__dirname+'/cache/posters'; try{fs.mkdirSync(POSTER_DIR,{recursive:true});}catch(e){}
const posterInflight=new Map();
async function fetchPoster(pic, local, key, ext){
  if(posterInflight.has(key)) return posterInflight.get(key);
  const pr=(async()=>{ await ensureReady();
    const dev='/data/data/'+PKG+'/files/txtvp_'+key+ext; const r=await script.exports.dlPoster(pic,dev);
    if(r&&r.ret===0){ const buf=readDevFile(dev); if(buf&&buf.length>100) fs.writeFileSync(local,buf); try{execFileSync(ADB,['shell','su','-c','rm -f "'+dev+'"']);}catch(e){} }
  })().catch(e=>console.error('[poster]',e&&e.message)).finally(()=>posterInflight.delete(key));
  posterInflight.set(key,pr); return pr;
}
app.get('/poster', async (req,res)=>{
  const pic=req.query.pic||''; if(!/^\/[\w./-]+\.(jpe?g|png)$/i.test(pic)) return res.status(400).end('bad');
  const key=crypto.createHash('md5').update(pic).digest('hex'); const ext=(pic.match(/\.(jpe?g|png)$/i)||['.jpg'])[0].toLowerCase();
  const local=pathMod.join(POSTER_DIR,key+ext);
  const serve=()=>{ res.setHeader('Cache-Control','public, max-age=604800'); res.sendFile(local); };
  if(fs.existsSync(local)) return serve();
  try{ await fetchPoster(pic, local, key, ext); }catch(e){}
  if(fs.existsSync(local)) serve(); else res.status(404).end();
});
// ---------- 台标(root 读盘) ----------
const LOGO_DIR=__dirname+'/cache/logos'; try{fs.mkdirSync(LOGO_DIR,{recursive:true});}catch(e){}
app.get('/logo', async (req,res)=>{
  const link=(req.query.link||'').trim(); if(!/^\w{1,16}$/.test(link)) return res.status(400).end('bad');
  const local=pathMod.join(LOGO_DIR,link+'.png');
  const serve=()=>{ res.setHeader('Cache-Control','public, max-age=604800'); res.sendFile(local); };
  if(fs.existsSync(local)) return serve();
  try { await ensureReady(); const dev='/data/data/'+PKG+'/files/icon/'+link+'.png'; const buf=readDevFile(dev);
    if(buf&&buf.length>100&&buf[0]===0x89&&buf[1]===0x50){ fs.writeFileSync(local,buf); return serve(); }
  } catch(e){}
  res.status(404).end();
});

function gracefulExit(sig){ console.log('['+sig+'] 退出:释放当前流,保留模拟器供重启复用(空闲定时器会回收;登出/关机由系统回收)'); try{ cleanupCurrent(); }catch(e){} process.exit(0); }
process.on('SIGINT', ()=>gracefulExit('SIGINT'));
process.on('SIGTERM', ()=>gracefulExit('SIGTERM'));   // launchd 用 SIGTERM
app.listen(PORT, ()=>console.log(`\n淘星TV: http://localhost:${PORT}  (空闲 ${IDLE_MS/1000}s 自动关引擎, ffmpeg 转码)\n`));
