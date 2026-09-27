const express = require('express');
const frida = require('frida');
const http = require('http');
const fs = require('fs');
const pathMod = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const { pinyin } = require('pinyin-pro');
// 日志带本地时间戳:排查"何时断源/续接花了多久/前端何时重取"必须有时序
{ const _l=console.log.bind(console), _e=console.error.bind(console);
  const st=()=>{ const d=new Date(); return d.toTimeString().slice(0,8)+'.'+String(d.getMilliseconds()).padStart(3,'0'); };
  console.log=(...a)=>_l(st(),...a); console.error=(...a)=>_e(st(),...a); }

const ADB = process.env.ADB || 'adb';
const EMULATOR = process.env.EMULATOR || 'emulator';
const AVD = process.env.AVD || 'TaoxingTV';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const PKG = 'com.wys.iptvgo';
const CREDS_FILE = __dirname + '/creds.json';  // 本地保存的登录凭据(gitignore,永不进仓库),用于登出/重置后自动登录
const PORT = process.env.PORT || 8090;
const IDLE_MS = parseInt(process.env.IDLE_MS || '600000', 10);  // 短暂离开页面不反复冷启动模拟器(一次约几十秒)
const FRIDA_BIN = '/data/local/tmp/frida-server';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function adb(args, opts={}) { try { return execFileSync(ADB, args, {encoding:'utf8', timeout: opts.timeout||15000}); } catch(e){ return ''; } }
function adbSu(cmd) { return adb(['shell','su','-c',cmd]); }
function readDevFile(dev){
  try { const b64 = execFileSync(ADB, ['exec-out','su','-c','base64 "'+dev+'" 2>/dev/null'], {encoding:'utf8', maxBuffer:64*1024*1024, timeout:15000});
    const buf = Buffer.from(b64.replace(/\s/g,''), 'base64'); return buf.length>0 ? buf : null;
  } catch(e){ return null; }
}
// 直播继续硬件转码；点播原片可浏览器解码时只转封装，保留低开销与原生供数速度。
function spawnTranscode(srcPort, isLive, nearEnd, skipSec, tsOffsetSec, transcodeVod=false){
  // 直播:开 ffmpeg 底层重连,扛 P2P 抖动。
  // 点播:不开重连。点播源的 HTTP 连接只在两种情况下结束:内容真到结尾,或它的 P2P 会话被 vodStop 掉。
  // 连接断了由 serveStream 的 onSegEnd 负地续接(重新 vodStart + -ss 跳过重叠),ffmpeg 自己不重连。
  const rec = isLive ? ['-reconnect','1','-reconnect_streamed','1','-reconnect_on_network_error','1','-reconnect_delay_max','4'] : [];
  // 直播按实时读并允许追赶；点播由客户端缓冲深度控制背压，不额外限制读速。
  // 本机实测旧点播原始 TS 在 20 秒供数 37 MB，旧硬件重编码同时间仅输出 0.5 MB。
  const rate = isLive ? ['-readrate','1.0','-readrate_catchup','4.0','-readrate_initial_burst','15']
                      : [];
  // 仅在浏览器不支持原片编码时使用已有的低码率硬件转码兜底。
  const venc = isLive
    ? ['-c:v','h264_videotoolbox','-realtime','1','-b:v','8M','-g','60','-pix_fmt','yuv420p']
    : transcodeVod ? ['-c:v','h264_videotoolbox','-q:v','50','-maxrate','1500k','-bufsize','3M','-g','60','-pix_fmt','yuv420p']
                   : ['-c:v','copy'];
  const aenc=(!isLive&&!transcodeVod) ? ['-c:a','copy'] : ['-c:a','aac','-b:a','160k','-ac','2'];
  const rwto = isLive ? ['-rw_timeout','30000000'] : [];   // 点播:根本不设读超时。ffmpeg只要连接(页面)还开着就一直活,暂停多久都不自杀;页面关/掉线→res close→teardown回收(见serveStream);真卡死(源挂/App崩)由前端看门狗冻结~24s重取兜底。直播保留30s,与-reconnect配套扛P2P抖动
  const seek = (skipSec>0.05) ? ['-ss', skipSec.toFixed(3)] : [];             // 续接时跳过与上一段重叠的部分,避免重复内容
  const tsoff = (tsOffsetSec>0.05) ? ['-output_ts_offset', tsOffsetSec.toFixed(3)] : [];  // 让新一段的时间戳接着上一段走,客户端看到的是一条连续的流
  const prog = isLive ? [] : ['-progress','pipe:2'];                          // 上报已输出时长,续接时据此算出续接点
  const args=['-hide_banner','-loglevel','error', ...prog, ...rec, ...rwto,
    '-fflags','+discardcorrupt+genpts','-err_detect','ignore_err',
    ...rate,
    ...seek, '-i','http://127.0.0.1:'+srcPort+'/',
    ...venc,
    ...aenc,
    ...tsoff, '-f','mpegts','-muxdelay','0','-muxpreload','0','pipe:1'];
  const ff=spawn(FFMPEG,args,{stdio:['ignore','pipe','pipe']});
  let errbuf='';
  ff.stderr.on('data',d=>{ errbuf=(errbuf+d.toString()).slice(-1000); });
  ff.on('exit',(code,sig)=>{ if(sig!=='SIGKILL') console.log('[ff exit] code='+code+' sig='+sig+' | '+errbuf.replace(/\s+/g,' ').trim().slice(-260)); });
  return ff;
}

// ---------- 引擎(模拟器)生命周期 ----------
let state='off', bootStep='', bootPromise=null;
let script=null, session=null, catalog=null;
// VOD 元数据来自模拟器里的远端请求；切换分类和重新打开详情不应每次再等一次网络往返。
const vodCache = new Map();
async function cachedVod(key, ttlMs, load){
  const now=Date.now(), hit=vodCache.get(key);
  if(hit && (hit.promise || hit.expires>now)){
    vodCache.delete(key); vodCache.set(key,hit);
    return hit.promise || hit.value;
  }
  const entry={promise:null,value:null,expires:0};
  const promise=Promise.resolve().then(load);
  entry.promise=promise; vodCache.delete(key); vodCache.set(key,entry);
  while(vodCache.size>160) vodCache.delete(vodCache.keys().next().value);
  try{
    const value=await promise;
    if(vodCache.get(key)===entry){ entry.value=value; entry.promise=null; entry.expires=Date.now()+ttlMs; }
    return value;
  }catch(e){ if(vodCache.get(key)===entry) vodCache.delete(key); throw e; }
}
// current: 当前活动流。token=递增唯一标识(不用端口,端口会复用);ended=收到tellMessage(2)真结束;ffExited=ffmpeg已退出
let current={ token:0, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false, sid:null };
let curBuf=0;  // 前端上报的点播缓冲深度(秒),用于反馈节流
let lastActivity=Date.now();
let activeLogins=0;

function emulatorRunning(){ return /emulator-\d+\s+device/.test(adb(['devices'])); }
async function waitBootCompleted(timeoutMs=90000){ const t0=Date.now();
  while(Date.now()-t0<timeoutMs){ if(adb(['shell','getprop','sys.boot_completed']).trim()==='1')return true; await sleep(2000); } return false; }
function fridaServerUp(){ return /frida-server/.test(adbSu('pgrep -l frida-server || true')); }
function appRunning(){ return adb(['shell','pidof',PKG]).trim().length>0; }

// 停原生 P2P 会话(vodStop)必须防"晚到":stop 串进 streamMutex 队列时,队列里可能已排着新流的启动任务,
// 于是 stop 在新流刚接通、刚出数据时才执行 -> 停掉的是**新**会话 -> 源把在途的几 MB 吐完就关连接。
// 这就是日志里大量"源断开于 6-11s"、ffmpeg 报 Stream ends prematurely / Input-output error 的真正来源:
// 实测正常读流 4 秒后调一次 vodStop,连接 4.6 秒后被关;而源本身全速读 7 分钟、停读 60 秒都不会断。
// 所以 stop 真正执行前先核对 token:期间有更新的流启动过(token 变了)就作废——新流的 vodPlay 自己会先 vodStop 旧会话。
function queueStop(token){ streamMutex = streamMutex.then(async()=>{ if(current.token!==token) return; try{ if(script) await script.exports.stop(); }catch(e){} }); }
function cleanupCurrent(){
  const tok=current.token;
  if(current.ff){ try{current.ff.kill('SIGKILL');}catch(e){} }
  if(current.res && !current.res.writableEnded){ try{current.res.end();}catch(e){} }
  if(current.port){ queueStop(tok); adb(['forward','--remove','tcp:'+current.port]); }
  current={token:tok, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false, sid:null};
}

let needColdRestart=false;
async function bootEmulator(){
  if(state==='ready' && script && emulatorRunning()) return;
  if(bootPromise) return bootPromise;
  bootPromise=(async()=>{ state='booting';
    try {
      if(!emulatorRunning()){ bootStep='启动模拟器(全新冷启动)…';
        const p=spawn(EMULATOR,['-avd',AVD,'-no-window','-no-audio','-no-boot-anim','-gpu','swiftshader_indirect','-no-metrics','-no-snapshot'],{detached:true,stdio:'ignore'});
        await new Promise((resolve,reject)=>{ p.once('spawn',resolve); p.once('error',reject); });
        p.unref();   // -no-snapshot:每次全新冷启动,不加载/保存快照,不继承上次残留状态(登录仍在磁盘userdata里,会自动登录)
        adb(['wait-for-device'],{timeout:120000}); }
      bootStep='等待系统就绪…'; await waitBootCompleted();
      bootStep='启动取流引擎…'; if(!fridaServerUp()){ adbSu('nohup '+FRIDA_BIN+' >/dev/null 2>&1 &'); await sleep(1500); }
      if(needColdRestart){ bootStep='冷重启应用…'; adb(['shell','am','force-stop',PKG]); await sleep(2000); needColdRestart=false; }
      let coldLaunch=false;
      if(!appRunning()){
        adb(['shell','monkey','-p',PKG,'-c','android.intent.category.LEANBACK_LAUNCHER','1']);
        // 部分模拟器上 monkey 找不到 Leanback 入口并以 -5 退出；显式启动 APK 的登录入口。
        if(!appRunning()) adb(['shell','am','start','-n',PKG+'/.activity.LoginActivity']);
        coldLaunch=true;
      }
      for(let i=0;i<30 && !appRunning();i++) await sleep(1000);
      if(coldLaunch){ bootStep='等待应用启动…'; await sleep(4000); }  // 短暂等应用进程起来再注入,随后按真实信号放行(不再盲等12s)
      bootStep='注入引擎…'; await attach();
      if(coldLaunch){
        let login=null; try{ login=await script.exports.loginState(); }catch(e){}
        if(login && !login.account){ console.log('[engine] 等待网页登录'); }
        else { bootStep='等待频道数据就绪…';   // 就绪门:等频道加载完成(icChart挂表成功的信号)。注:activatedTime(icAuth设备授权)在无头环境永远为0——那是HomeActivity的UI流程,我们绕过了界面直接Frida调vodStart,故不能作为门条件(实测等3分钟仍为0)
          let rdy={};
          for(let i=0;i<20;i++){ try{ rdy=await script.exports.engineReady(); }catch(e){ rdy={}; } if(rdy && rdy.channels>0) break; await sleep(1500); }
          console.log('[engine] 频道就绪 ch='+(rdy.channels||0));
          // 冷启动后必须自己挂表+授权:原生靠首页UI流程跑 icChart/icAuth,我们无头绕过了UI,
          // 不做这步则 vodStart/playbackStart 一律返回 -1000(没授权),表现为"死端口/取不到流"
          if(rdy.channels>0){ bootStep='挂表授权…';
            try{ const a=await script.exports.reAuth(); console.log('[auth] 冷启动授权 chart='+a.chart+' auth='+a.auth+(a.err?' err='+a.err:'')); }catch(e){ console.log('[auth] 冷启动授权失败',e&&e.message); } }
        } }
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
// —— 诊断采样(排查频繁短缓冲):需要时用 DIAG=1 打开 ——
if(process.env.DIAG==='1'){ let _lastOut=0, _lastT=Date.now();
  setInterval(()=>{ try{
    if(current.ff && !current.ffExited && current.chid && (''+current.chid).startsWith('vod')){
      const now=Date.now(); const dt=(now-_lastT)/1000||1; const ob=current.outTotal||0;
      const kbps=Math.max(0,(ob-_lastOut))/1024/dt;
      _lastOut=ob; _lastT=now;
      const idle=(now-(current.lastData||now))/1000;
      if(curBuf<15 || current.throttled || current.splicing || idle>3)   // 只在异常时记(健康稳态不刷屏)
        console.log('[diag '+current.chid+'] 客户端缓冲='+curBuf.toFixed(0)+'s 节流='+(current.throttled?'是':'否')+' 续接='+(current.splicing?'是':'否')+' 输出='+kbps.toFixed(0)+'KB/s 源静默='+idle.toFixed(0)+'s');
    } else { _lastOut=0; _lastT=Date.now(); }
  }catch(e){} }, 3000);
}
// 空闲回收:有活动流时(current.ff)绝不关;否则超时关
setInterval(()=>{ if(state==='ready' && !current.ff && activeLogins===0 && Date.now()-lastActivity>IDLE_MS) shutdownEmulator('空闲超时'); }, 15000);

// ---------- 取流(直播/点播共用),token化+串行化 ----------
let streamMutex=Promise.resolve();
let prematureCount=0, prematureLabel='';   // 连续"有数据但很快提前结束"计数:churn会把P2P引擎搞到只能吐几秒就EOF,
                // 这种情况前端会不停重起->更多churn->自我维持的死循环。连续多次即判引擎已坏,冷重启自愈
let reqSeq=0;   // 请求序号:用户连按方向键时会连发多个取流请求,只有最新的才该触达原生。
                // 旧请求若也去 vodStart 再被抛弃,就是"起流->没出数据->停掉"的高频churn,实测6次就能毒死P2P引擎
const MAX_START_TRIES = 2;     // 死端口时内部重取次数:3→2(原生几乎不重调vodStart,churn=崩溃元凶);配合就绪门+首字节耐心,死端口本就罕见。首字节门限见 serveStream 内 firstByteMs
function serveStream(req, res, playFn, label, isLive, nearEndVod, vod){
  const mySeq = ++reqSeq;   // 同步取号(在排队之前),后来者会让先来者作废
  const mySid=typeof req.query.sid==='string' ? req.query.sid.slice(0,64) : '';
  try{ req.socket.setKeepAlive(true, 30000); }catch(e){}   // TCP保活:暂停时页面还在→对端TCP栈会答保活探测→连接判活→ffmpeg不释放;页面真没了(断网/睡眠/崩)→探测无应答→连接断→res close→teardown回收。这才是"页面在不在"的正解,取代分不清暂停/掉线的读超时
  streamMutex = streamMutex.then(async()=>{
    const myToken = current.token + 1;
    let aborted=false; const onEarlyClose=()=>{ aborted=true; };
    req.on('close', onEarlyClose);
    try {
      if(mySeq !== reqSeq && (aborted || req.destroyed)){ return; }   // 已被更新请求取代 且 客户端确实已走(seek换流):直接放弃,绝不去动原生引擎。
      // 注意必须带"客户端已走"这个条件:只看序号会导致请求比处理快时人人都被判陈旧->谁都不执行的死锁
      await ensureReady();
      if(res.writableEnded||req.destroyed){ return; }          // 客户端已断开
      if(mySeq !== reqSeq && (aborted || req.destroyed)){ return; }   // 等待期间又被取代且客户端已走,同上
      const hadStream=!!current.port; cleanupCurrent();
      // 立刻用新 token 占位(在 stop/settle 之前):一来 /api/streamstate 立即显示 alive(starting),前端看门狗不会在重取期间误判断流来抢流;
      // 二来上一路流若正在续接(onSegEnd),它每一步都核对 token,看到已换流就立刻作废,不会再去 vodStop/vodStart 干扰这一路
      current={ token:myToken, chid:label, port:0, ff:null, ended:false, ffExited:false, starting:true, sid:mySid };
      // 等上一路 P2P 会话真正 stop 完再起新流,并给原生引擎一点收尾时间(settle),否则快速重取(seek)可能拿到不出数据的死端口
      if(hadStream){ try{ if(script) await script.exports.stop(); }catch(e){} await sleep(700); }

      const firstByteMs = 12000;   // 首字节耐心:实测健康时 2.5-3.5 秒出数据,12秒已是3倍余量。
      // (曾设成30秒想"更有耐心",结果每次失败都要干等30秒、拖慢每一次拖进度,是过度矫正)
      let ff=null, myPort=0, buffered=null, badPortCount=0, deadPortCount=0;
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
        let cand=null, gotData=false;
        // 同一端口最多就地重开3次:刚 vodStart 到新位置时P2P往往还没下载够,读到尽头会被当成EOF。
        // 就地重开 ffmpeg 不碰原生会话(零churn),等几秒让P2P追上来,比"拆掉整路重来"便宜得多也稳得多
        for(let sub=1; sub<=3 && !aborted; sub++){
        cand=spawnTranscode(port, isLive, nearEndVod, 0, 0, !!(vod&&vod.transcode));
        // 健康门限:等首字节。出数据=活端口;超时/即时退出=死端口,清理后重取
        const buf=[]; const collect=(d)=>buf.push(d); let onFirst, onCandExit, timer;
        gotData = await new Promise(resolve=>{
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
          if(sub>1) console.log('['+label+'] 同端口第'+sub+'次重开ffmpeg后出数据');
          break;
        }
        try{ cand.kill('SIGKILL'); }catch(e){}
        if(sub<3 && !aborted){ console.log('['+label+'] 端口'+port+' 未出数据,同端口重开ffmpeg '+sub+'/3(等P2P下载)'); await sleep(2500); }
        }   // end sub loop
        if(ff) break;
        deadPortCount++;
        console.log('['+label+'] 端口'+port+' 同端口重开3次仍无数据 -> 重新取流 '+attempt+'/'+MAX_START_TRIES);
        try{ if(script) await script.exports.stop(); }catch(e){}   // await:同上,防止晚到的stop杀掉下一次重取
        adb(['forward','--remove','tcp:'+port]);
        await sleep(800);
      }

      if(aborted || res.writableEnded || req.destroyed){   // 客户端在启动期就走了(seek/切集时前端换流走的正是这条)
        if(ff){ try{ff.kill('SIGKILL');}catch(e){} }
        try{ if(script) await script.exports.stop(); }catch(e){}   // 必须await:否则这个stop会晚到,把用户下一次seek刚起的流停掉(端口有效却无数据)
        if(myPort) adb(['forward','--remove','tcp:'+myPort]);
        current={token:myToken, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false, sid:null};
        // 前端等不及先走了,但本次确实遇到过死端口=引擎已坏。必须在这里也自愈,否则前端反复重试、
        // 每次都走abort分支跳过自愈 -> 引擎一直毒着 -> 用户看到"播放中断"。正常seek不会有死端口,不会误触发
        if(deadPortCount>0 && state==='ready' && !nearEndVod){
          console.log('['+label+'] 客户端已放弃但出现死端口 -> 触发冷重启App自愈');
          needColdRestart=true; try{ if(session) await session.detach(); }catch(e){}
        }
        return;
      }
      if(!ff){   // 多次重取都失败,放弃(前端会收到502后自行再试)
        current={token:myToken, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false, sid:null};
        if(state==='ready' && !nearEndVod){   // 坏端口(-1000)或连续死端口(端口有效却不出数据)都说明P2P引擎已坏,冷重启自愈   // 每次都拿到坏端口(如-1000)=原生P2P取流核心卡死(登录/频道都在但起不了流),触发冷重启App自愈。但点播接近片尾的坏端口多半是"内容真结束",不算卡死,不冷重启(前端会判作播完跳下一集)
          console.log('['+label+'] 连续坏端口,P2P核心疑似卡死 -> 触发冷重启App');
          needColdRestart=true; try{ if(session) await session.detach(); }catch(e){}
        }
        try{ res.status(502).end('播放启动失败:'+(badPortCount>=MAX_START_TRIES?'P2P核心卡死,正在自动重启,请稍候重试':'多次取流均无数据')); }catch(e){}
        return;
      }

      current={ token:myToken, chid:label, port:myPort, ff, res, ended:false, ffExited:false, starting:false, sid:mySid };
      curBuf=0;
      console.log('['+label+'] port',myPort,'tok',myToken);
      res.setHeader('Content-Type','video/mp2t');
      let lastBump=0;
      let outBytes=0;
      if(buffered && buffered.length){ for(const c of buffered){ try{ res.write(c); }catch(e){} } }  // 补发健康门限期间缓冲的首包(含PAT/PMT),不丢头
      // ——— 源断了由服务端无缝续接,客户端全程只看到一条不间断的流 ———
      // 源连接结束(真片尾之外)时:算出已经送出多少内容,重新取流并用 -ss 跳过重叠部分、-output_ts_offset 接续时间戳,
      // 继续写进同一个 HTTP 响应,前端不重建播放器、不丢已缓冲内容。
      // (根治晚到 stop 之后,源断开应当很少见;续接是兜底,所以必须可靠:有首字节门限、失败重试、全程有日志。)
      const durSec = (vod && vod.dur>0) ? vod.dur : 0;
      const segStartAbs = durSec ? (vod.percent/100*durSec) : 0;
      let deliveredSec = 0, segOut = 0, splicing = false, finished = false, emptySplices = 0;
      let wantSplice = false;   // 停滞检测主动 SIGKILL 当前段并要求续接时置真(否则 SIGKILL 一律视为我们主动拆流,不续接)
      const readProgress = (d)=>{ const m=(''+d).match(/out_time_us=(\d+)/g); if(m&&m.length){ const v=parseInt(m[m.length-1].split('=')[1],10); if(!isNaN(v)) segOut = v/1e6; } };

      const wire = (proc)=>{
        proc.stdout.on('data',(d)=>{ outBytes+=d.length; const now=Date.now(); if(current.token===myToken){ current.lastData=now; current.outTotal=(current.outTotal||0)+d.length; } if(now-lastBump>4000){ lastBump=now; lastActivity=now; } });
        proc.stderr.on('data', readProgress);
        proc.stdout.pipe(res,{end:false});          // 不让某一段结束就把响应关掉
        proc.on('exit',(code,sig)=>{ onSegEnd(proc,sig); });
        proc.on('error',(e)=>{ console.error('[ff spawn err]',e&&e.message); try{res.end();}catch(_){} });
      };

      // 等某段 ffmpeg 出首字节:出了=true;先退出/超时=false
      const waitFirstByte = (proc, ms) => new Promise(resolve=>{ let settled=false;
        const done=(v)=>{ if(settled) return; settled=true; clearTimeout(t); proc.stdout.removeListener('data',onD); proc.removeListener('exit',onX); resolve(v); };
        const onD=()=>done(true), onX=()=>done(false); const t=setTimeout(()=>done(false), ms);
        proc.stdout.once('data',onD); proc.once('exit',onX); });

      async function onSegEnd(proc, sig){
        if(current.token===myToken) current.ffExited=true;
        if(finished || splicing) return;
        if(sig==='SIGKILL' && !wantSplice) return;                     // 我们主动拆的(seek/切集/客户端离开);停滞检测发起的 SIGKILL 例外,要续接
        wantSplice=false;
        if(res.writableEnded || req.destroyed){ finished=true; return; }
        const segLen = segOut; deliveredSec += segOut; segOut = 0;
        const resumeAbs = segStartAbs + deliveredSec;
        // 连续多次续接都几乎取不到内容 = 真到片尾(或源彻底没了),停止续接,否则会在片尾无限重连
        if(segLen < 2) emptySplices++; else emptySplices = 0;
        if(isLive || !vod || !vod.mkPlay || emptySplices >= 3 || (durSec && resumeAbs >= durSec*0.985)){
          finished=true; try{ res.end(); }catch(e){}
          console.log('['+label+'] 结束于 '+resumeAbs.toFixed(0)+'s'+(durSec?('/'+durSec+'s'):'')+(emptySplices>=3?'(连续取不到内容)':''));
          return;
        }
        if(current.token!==myToken){ finished=true; return; }         // 已有更新的流接管(用户刚好在此刻换流):本路作废,绝不能再去 stop(会停掉新流的会话)
        splicing = true; current.splicing=true;                        // 续接期间 /api/streamstate 仍报 alive,前端别来抢流
        // 知道总时长就跳到最近的百分点(跳过的秒数少、续接快);不知道(老页面没传dur)就用同一个百分点跳过已播时长——同样正确,只是跳过得多一点
        const pct = durSec ? Math.max(0, Math.min(96, Math.floor(resumeAbs/durSec*100))) : vod.percent;
        const skip = durSec ? Math.max(0, resumeAbs - pct/100*durSec) : deliveredSec;
        console.log('['+label+'] 源断开于 '+resumeAbs.toFixed(0)+'s(本段供数 '+segLen.toFixed(0)+'s, 客户端缓冲 '+curBuf.toFixed(0)+'s) -> 无缝续接(从'+pct+'%跳过'+skip.toFixed(0)+'s)');
        const t0=Date.now();
        try{
          let ok=false;
          for(let attempt=1; attempt<=2 && !finished; attempt++){
            if(current.token!==myToken){ finished=true; return; }     // 同上:换流了就作废
            try{ if(script) await script.exports.stop(); }catch(e){}
            await sleep(600);
            await ensureReady();                       // 续接期间引擎可能已崩/被回收,先确保就绪(否则 script 为空直接抛错)
            if(!script) throw new Error('引擎未就绪');
            if(finished || res.writableEnded || req.destroyed || current.token!==myToken){ finished=true; return; }
            const r = await vod.mkPlay(pct);
            if(!r || !r.port || r.port<=0) throw new Error('续接取流失败 port='+(r&&r.port));
            adb(['forward','tcp:'+r.port,'tcp:'+r.port]);
            if(myPort && myPort!==r.port) adb(['forward','--remove','tcp:'+myPort]);
            myPort = r.port;
            const cand = spawnTranscode(r.port, isLive, nearEndVod, skip, deliveredSec, !!(vod&&vod.transcode));
            ff = cand;                                 // 立刻登记为当前段:客户端此刻离开时 teardown 才杀得到它
            if(current.token===myToken){ current.ff = cand; current.port = r.port; current.ffExited=false; }
            wire(cand);                                // 边等首字节边直接转发(不丢头);它若在 splicing 期间退出,onSegEnd 会直接返回,由这里的循环处理
            ok = await waitFirstByte(cand, firstByteMs);
            if(finished){ try{ cand.kill('SIGKILL'); }catch(e){} return; }   // 等首字节期间客户端走了
            if(ok){ console.log('['+label+'] 续接成功 port '+r.port+',断开到出数据 '+((Date.now()-t0)/1000).toFixed(1)+'s'); break; }
            console.log('['+label+'] 续接 port '+r.port+' '+(firstByteMs/1000)+'秒未出数据 '+attempt+'/2');
            try{ cand.kill('SIGKILL'); }catch(e){}
          }
          if(finished) return;
          if(!ok) throw new Error('续接多次无数据');
        }catch(e){
          console.error('['+label+'] 续接失败:', e&&(e.message||e));
          finished=true; try{ res.end(); }catch(_){}   // 让前端按老路走恢复
        }finally{
          splicing=false; if(current.token===myToken) current.splicing=false;
        }
      }

      wire(ff);

      // 点播深缓冲上限:前端上报 curBuf,>60秒暂停ffmpeg(背压)、<56秒续读 -> 缓冲稳定56-60秒
      let bufPaused=false;
      const throttle = isLive ? null : setInterval(()=>{
        if(current.token!==myToken){ clearInterval(throttle); return; }
        try{ const cur=ff; if(!bufPaused && curBuf>60){ cur.stdout.pause(); bufPaused=true; } else if(bufPaused && curBuf<56){ cur.stdout.resume(); bufPaused=false; } current.throttled=bufPaused; }catch(e){}
        // 停滞检测:没被我们节流,却20秒没有任何新数据 -> 源哑了(ffmpeg会无限阻塞不自己退出),主动触发无缝续接
        try{
          // 只有"客户端缓冲快见底了 还 20秒拿不到数据"才算真停滞。
          // 客户端暂停/缓冲充足时数据本就不该流动(背压),不能当成源哑了——否则会在用户暂停期间
          // 反复强行续接,把流反复重建、时间戳错乱(表现为画面卡住只剩声音)
          if(curBuf < 10 && !bufPaused && !splicing && !finished && current.lastData && Date.now()-current.lastData>20000){
            console.log('['+label+'] 客户端缓冲仅 '+curBuf.toFixed(0)+'s 且源 20 秒无数据 -> 主动续接');
            wantSplice=true; try{ ff.kill('SIGKILL'); }catch(e){}   // onSegEnd 见到 wantSplice 才会对 SIGKILL 续接(之前漏了这个判断,这里的 kill 只是把流杀死、从不续接,日志每秒刷一行)
          }
        }catch(e){}
      }, 1000);
      // 拆掉正在播放的流(用户seek/切集换流、关页面时走这里)。
      const teardown=()=>{ finished=true; if(throttle)clearInterval(throttle); try{ff.kill('SIGKILL');}catch(e){} if(current.token===myToken){ adb(['forward','--remove','tcp:'+myPort]); current={token:myToken,chid:null,port:null,ff:null,ended:false,ffExited:false,starting:false,sid:null};
        queueStop(myToken); } };   // 排队 stop 时再次核对 token(见 queueStop):若此后已有新流启动,这个 stop 作废,否则会把新流的 P2P 会话停掉
      res.on('close',teardown); res.on('error',teardown);
    } catch(e){ console.error('['+label+' err]',e&&(e.stack||e.message||e)); try{res.status(503).end(''+(e.message||e));}catch(_){}
      if(current.token===myToken && current.starting){ current={token:myToken,chid:null,port:null,ff:null,ended:false,ffExited:false,starting:false,sid:null}; }
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
app.get('/api/status', (req,res)=>res.json({state, step:bootStep, playing:current.chid, ended:current.ended, alive: (!!current.ff && !current.ffExited) || !!current.starting || !!current.splicing}));
app.post('/api/wake', (req,res)=>{ lastActivity=Date.now(); bootEmulator().catch(()=>{}); res.json({state, step:bootStep}); });
app.post('/api/heartbeat', (req,res)=>{ lastActivity=Date.now(); res.json({ok:true, state}); });
// 流状态:前端用来区分"临时卡顿(alive,等就好)"vs"真结束(ended)"vs"断流(!alive)"
app.get('/api/streamstate', (req,res)=>res.json({ ended:current.ended, alive: (!!current.ff && !current.ffExited) || !!current.starting || !!current.splicing, feeding: (!!current.ff && !current.ffExited && ((Date.now()-(current.lastData||0) < 3000) || !!current.throttled)), chid:current.chid, curBuf, throttled:!!current.throttled, splicing:!!current.splicing }));   // feeding:源近3秒在出数(或缓冲已满被节流)=还活着;恢复时前端据此判断要不要重连
app.get('/api/buf', (req,res)=>{ if(current.sid && req.query.sid===current.sid) curBuf=Math.max(0,parseFloat(req.query.d)||0); res.json({ok:true}); });  // 只接受当前流的缓冲量，旧页面/旧流不能误节流新流

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
  activeLogins++; lastActivity=Date.now();
  try {
    await ensureReady();
    await script.exports.saveCreds(account, password);   // 写入 App 的 SharedPreferences
    await sleep(800);                                     // 等 apply() 落盘
    needColdRestart = true;                               // 冷重启 App 走它自带的启动自动登录+激活
    try { if (session) await session.detach(); } catch(e){}
    await sleep(1000);
    await bootEmulator();
    let st = { activated:false };
    for (let i=0;i<45;i++){
      try { st = await script.exports.loginState(); } catch(e){}
      if (st.activated) break;
      // 原生应用会依次尝试六条线路；等它给出最终结果，避免网页先报登录失败。
      if (i%3===0 && /topResumedActivity=.*com\.wys\.iptvgo\/\.activity\.RescueActivity/.test(adb(['shell','dumpsys','activity','activities']))) break;
      await sleep(2000);
    }
    if (st.activated) {
      try { fs.writeFileSync(CREDS_FILE, JSON.stringify({ account, password }), { mode:0o600 }); } catch(e){}
      catalog = null; vodCache.clear(); vodBase=null; vodRootPath=null;
      res.json({ ok:true, account });
    } else {
      console.log('[login] 原生应用未完成激活 channels='+(st.channels||0)+' accountLoaded='+!!st.account);
      res.json({ ok:false, error:'淘星TV 应用未完成激活，未取得频道数据。请检查网络和代理，稍后重试；若仍失败，再核对账号及设备授权。' });
    }
  } catch(e){ res.status(500).json({ error: ''+(e.message||e) }); }
  finally { activeLogins--; lastActivity=Date.now(); }
});
app.post('/api/logout', async (req,res)=>{
  try { await ensureReady();
    await script.exports.saveCreds('', '');   // 清空 prefs 凭据
    try { fs.unlinkSync(CREDS_FILE); } catch(e){}
    needColdRestart = true; try { if (session) await session.detach(); } catch(e){}
    catalog = null; vodCache.clear(); vodBase=null; vodRootPath=null; res.json({ ok:true });
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
let vodBase=null, vodRootPath=null, vodInitPromise=null;
async function vodInit(){ if(vodBase&&vodRootPath)return;
  if(!vodInitPromise) vodInitPromise=(async()=>{
    const u=await script.exports.vodUrls(); const root=xml.parse(await script.exports.vodGet(u.VODROOT_URL));
    if(!root.vod_addrs) throw new Error('点播目录根地址暂不可用');
    const rp=txt(((root.vod_addrs||{}).vod_addr||{}).addr)||'/gotv/root_cn.xml';
    vodBase=u.VODBASE_URL; vodRootPath=rp;
  })().finally(()=>{ vodInitPromise=null; });
  await vodInitPromise;
}
async function vodFetch(path){ await ensureReady(); await vodInit(); const full=/^https?:|^\d/.test(path)?path:(vodBase+path); return script.exports.vodGet(full); }
function parseVod(raw, root){ const data=xml.parse(raw); if(!data[root]) throw new Error('点播数据暂不可用'); return data; }
function decryptOld(s){ const key=Buffer.from('FB0D2346'.repeat(3)); const dec=crypto.createDecipheriv('des-ede3',key,null); return Buffer.concat([dec.update(Buffer.from(txt(s),'base64')),dec.final()]).toString('utf8'); }

app.get('/api/vod/categories', async (req,res)=>{
  try { res.json(await cachedVod('categories',10*60*1000,async()=>{
    await ensureReady(); await vodInit();
    const data=parseVod(await script.exports.vodGet(vodBase+vodRootPath),'Typelist');
    const types=arr(data.Typelist.Types).map(t=>({type:txt(t.type),tag:txt(t.tag),link:txt(t.link),sub:txt(t.sub)}))
      .filter(t=>['电影','电视剧','短剧','综艺','动漫','纪录片','体育'].includes(t.type));
    return {categories:types};
  }));
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});
app.get('/api/vod/list', async (req,res)=>{
  try { const path=req.query.path; if(!path) return res.status(400).json({error:'no path'});
    res.json(await cachedVod('list:'+path,5*60*1000,async()=>{
      const data=parseVod(await vodFetch(path),'Playlist');
      const films=arr(data.Playlist.film).map(f=>({filmid:txt(f.filmid),title:txt(f.title),pic:txt(f.pic),remark:txt(f.remark),playid:txt(f.playid)}));
      return {films};
    }));
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});
app.get('/api/vod/detail', async (req,res)=>{
  try { const playid=req.query.playid; if(!playid) return res.status(400).json({error:'no playid'});
    res.json(await cachedVod('detail:'+playid,30*60*1000,async()=>{
    if(playid.startsWith('old:')){
      const m=/^old:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+\.xml)$/.exec(playid);
      if(!m) throw new Error('旧点播地址无效');
      await ensureReady();
      const data=parseVod(await script.exports.vodGetOld('vod/xml2/'+m[1]+'/'+m[2]+'/'+m[3]),'category');
      const f=data.category.file||{};
      const eps=arr((f.links||{}).link).map(p=>{
        const server=decryptOld(p.server1), colon=server.lastIndexOf(':');
        if(colon<0) return null;
        return {playname:txt(p.filmname),channelId:decryptOld(p.filmid),ip:server.slice(0,colon),port:parseInt(server.slice(colon+1),10),duration:Math.floor((parseInt(txt(p.duration),10)||0)/1000),sourceMode:0};
      }).filter(p=>p&&Number.isInteger(p.port));
      return {film:{title:txt(data.category['@_name']),actor:txt(f.actor),director:txt(f.director),type:txt(f.v_type),area:txt(f.country),year:txt(f.releasedate),content:txt(f.description)},episodes:eps};
    }
    const data=parseVod(await vodFetch(playid),'PlayInfo'); const f=data.PlayInfo.film||{};
    const eps=arr((data.PlayInfo.playurl||{}).playid).map(p=>{
      const tag=txt(p.playtag); const src= tag.startsWith('relay')?txt(p.relay).slice(8):txt(p.udp).slice(6);
      const slash=src.indexOf('/'); if(slash<0) return null;
      const server=src.slice(0,slash); const channelId=src.slice(slash+1);
      const colon=server.indexOf(':'); if(colon<0) return null;
      const ip=server.slice(0,colon); const port=parseInt(server.slice(colon+1),10);
      if(!Number.isInteger(port)) return null;
      return {playname:txt(p.playname),channelId,ip,port,playtag:tag,duration:parseInt(txt(p.duration)||'0',10)};
    }).filter(Boolean);
    return {film:{title:txt(f.title),actor:txt(f.actor),director:txt(f.director),type:txt(f.type),area:txt(f.area),year:txt(f.year),content:txt(f.content),remark:txt(f.remark)},episodes:eps};
    }));
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});

function toInitials(han){ return pinyin(han,{pattern:'first',toneType:'none',type:'array'}).join('').toUpperCase().replace(/[^A-Z]/g,''); }
function searchTitle(s){ return String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,''); }
// 目录只登记中文名的已知英文原名；Silo 出现在本片海报上，但两套搜索索引都不收它。
const titleAliases=new Map([['silo','末日地堡']]);
function seasonInfo(title){
  const name=searchTitle(title), m=name.match(/第([一二三四五六七八九十\d]+)季$/);
  if(!m) return {base:name,season:0};
  const nums={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  return {base:name.slice(0,m.index),season:Number(m[1])||nums[m[1]]||0};
}
function mergeSearchResults(lists, q, initials, isName){
  const query=searchTitle(q), grouped=new Map();
  for(const list of lists) for(const f of list){
    const title=searchTitle(f.title);
    if(!title || !(title.includes(query) || (!isName && toInitials(f.title).startsWith(initials)))) continue;
    let group=grouped.get(title);
    if(!group){ group={...f,sources:[]}; grouped.set(title,group); }
    if(!group.sources.some(s=>s.type===f.type&&s.playid===f.playid)) group.sources.push(f);
  }
  const films=[...grouped.values()];
  // 同片多源时优先环球剧场：实测第二季起播供数更快；电视点播仍可在详情页切换。
  for(const f of films){
    f.sources.sort((a,b)=>(a.type==='new'?0:1)-(b.type==='new'?0:1));
    Object.assign(f,{pic:f.sources[0].pic,remark:f.sources[0].remark,playid:f.sources[0].playid,type:f.sources[0].type});
  }
  const baseOrder=new Map();
  for(const f of films){ const base=seasonInfo(f.title).base; if(!baseOrder.has(base)) baseOrder.set(base,baseOrder.size); }
  films.sort((a,b)=>{
    const an=searchTitle(a.title), bn=searchTitle(b.title);
    const ap=an.startsWith(query)||(!isName&&toInitials(a.title).startsWith(initials));
    const bp=bn.startsWith(query)||(!isName&&toInitials(b.title).startsWith(initials));
    if(ap!==bp) return ap?-1:1;
    const as=seasonInfo(a.title), bs=seasonInfo(b.title);
    return as.base===bs.base ? as.season-bs.season : baseOrder.get(as.base)-baseOrder.get(bs.base);
  });
  return films.slice(0,80);
}
app.get('/api/search', async (req,res)=>{
  try { const q=(req.query.q||'').trim(); if(!q) return res.json({films:[]});
    const lookup=titleAliases.get(searchTitle(q))||q;
    const hanMatch=lookup.match(/[一-鿿]+/); let searchKey,isName;
    if(hanMatch){ searchKey=toInitials(hanMatch[0]); isName=true; }
    else { searchKey=lookup.toUpperCase().replace(/[^A-Z0-9]/g,''); isName=false; }
    if(!searchKey) return res.json({films:[], initials:''});
    // 同一首字母的不同输入复用两套原始索引结果：用户从 MRDB 改搜中文全名时无需再访问远端。
    res.json(await cachedVod('search:'+q,10*1000,async()=>{
    await ensureReady();
    const oldSearch=()=>cachedVod('searchOld:'+searchKey,5*60*1000,async()=>{
      const raw=await script.exports.vodSearchOld(searchKey);
      const data=JSON.parse(raw);
      return arr(data.items).map(f=>({filmid:txt(f.folder),title:txt(f.name),pic:'old:'+txt(f.category)+'/'+txt(f.folder)+'/'+txt(f.img),remark:txt(f.v_type),playid:'old:'+txt(f.category)+'/'+txt(f.folder)+'/'+txt(f.url),type:'old'}))
        .filter(f=>/^old:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.xml$/.test(f.playid));
    });
    const fetchFilms=key=>cachedVod('searchNewRaw:'+key,5*60*1000,async()=>{
      const raw=await script.exports.vodSearch('vod',key,'all',0);
      const data=JSON.parse(raw);
      return arr(data.filmlist).map(f=>({filmid:f.filmid,title:f.title,pic:f.pic,remark:f.remark,playid:f.playxml,type:'new'}));
    });
    const newSearch=async()=>{
      // 环球剧场的完整拼音索引会漏掉第一季；先查短前缀，再用完整片名过滤。
      // 前缀结果为空或接近列表上限时再补查完整拼音，通常省去一次远端请求。
      const key=searchKey.length>2?searchKey.slice(0,2):searchKey;
      let broad; try{ broad=await fetchFilms(key); }
      catch(e){ if(key===searchKey) throw e; return fetchFilms(searchKey); }
      if(key!==searchKey && (broad.length>=80 || !mergeSearchResults([broad],lookup,searchKey,isName).length)){
        try{ return broad.concat(await fetchFilms(searchKey)); }
        catch(e){ if(!broad.length) throw e; }
      }
      return broad;
    };
    const found=await Promise.allSettled([oldSearch(),newSearch()]);
    if(found.every(r=>r.status==='rejected')) throw new Error('两套点播搜索暂不可用');
    for(let i=0;i<found.length;i++) if(found[i].status==='rejected')
      console.log('[search] '+(i?'环球剧场':'电视点播')+'查询失败:',String(found[i].reason).slice(0,100));
    const films=mergeSearchResults(found.map(r=>r.status==='fulfilled'?r.value:[]),lookup,searchKey,isName);
    return {query:q,initials:searchKey,count:films.length,films,
      source:found.every(r=>r.status==='fulfilled')?'电视点播 + 环球剧场':(found[0].status==='fulfilled'?'电视点播':'环球剧场'),
      partial:found.some(r=>r.status==='rejected')};
    }));
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});

app.get('/vod-stream', (req,res)=>{
  const {channelId, ip, port}=req.query; const percent=Math.max(0,Math.min(96,parseInt(req.query.percent||'0',10)||0));  // 上限96:冷启动在最后几%会撞P2P文件尾edge-catch;向前播放可正常到真片尾
  if(!channelId||!ip||!port){ return res.status(400).end('bad params'); }
  const dur=parseFloat(req.query.dur||'0')||0;   // 影片总时长:服务端据此判断"源断了"还是"真到片尾",并算出续接点
  const mode=req.query.mode==='0'?0:1;
  const mkPlay=(pct)=>{ if(!script) throw new Error('引擎未就绪'); return script.exports.vodPlay(channelId, ip, parseInt(port,10), pct, mode); };
  serveStream(req,res,()=>mkPlay(percent), 'vod:'+channelId, false, percent>=90, {dur, percent, mkPlay, transcode:req.query.transcode==='1'});   // percent>=90 视为接近片尾
});

// ---------- 海报(P2P 下载 + 缓存,小并发池) ----------
const POSTER_DIR=__dirname+'/cache/posters'; try{fs.mkdirSync(POSTER_DIR,{recursive:true});}catch(e){}
const posterInflight=new Map();
async function fetchPoster(pic, local, key, ext){
  if(posterInflight.has(key)) return posterInflight.get(key);
  const pr=(async()=>{ await ensureReady();
    const dev='/data/data/'+PKG+'/files/txtvp_'+key+ext;
    const r=pic.startsWith('old:') ? await script.exports.dlPosterOld(pic.slice(4),dev) : await script.exports.dlPoster(pic,dev);
    if(r&&r.ret===0){ const buf=readDevFile(dev); if(buf&&buf.length>100) fs.writeFileSync(local,buf); try{execFileSync(ADB,['shell','su','-c','rm -f "'+dev+'"']);}catch(e){} }
  })().catch(e=>console.error('[poster]',e&&e.message)).finally(()=>posterInflight.delete(key));
  posterInflight.set(key,pr); return pr;
}
app.get('/poster', async (req,res)=>{
  const pic=req.query.pic||''; if(!/^(?:\/[\w./-]+|old:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\.(jpe?g|png)$/i.test(pic)) return res.status(400).end('bad');
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
