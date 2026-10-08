const express = require('express');
const frida = require('frida');
const http = require('http');
const fs = require('fs');
const pathMod = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const { pinyin } = require('pinyin-pro');
const { DownloadQueue } = require('./download-queue');
const { DeadPortRestartPolicy } = require('./stream-recovery');
const { buildTranscodeArgs } = require('./stream-transcode');
const { VodBuffer, TransportClock } = require('./vod-buffer');
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
const IDLE_MS = parseInt(process.env.IDLE_MS || '3600000', 10);  // 一小时内重新开页复用热引擎；模拟器空闲约占 1 GB 内存
const FRIDA_BIN = '/data/local/tmp/frida-server';
const VOD_BUFFER_MB = Math.max(0, Math.min(1024, Number(process.env.VOD_BUFFER_MB ?? 256) || 0));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function adb(args, opts={}) { try { return execFileSync(ADB, args, {encoding:'utf8', timeout: opts.timeout||15000}); } catch(e){ return ''; } }
function adbSu(cmd) { return adb(['shell','su','-c',cmd]); }
function readDevFile(dev){
  try { const b64 = execFileSync(ADB, ['exec-out','su','-c','base64 "'+dev+'" 2>/dev/null'], {encoding:'utf8', maxBuffer:64*1024*1024, timeout:15000});
    const buf = Buffer.from(b64.replace(/\s/g,''), 'base64'); return buf.length>0 ? buf : null;
  } catch(e){ return null; }
}
// 直播继续硬件转码；点播原片可浏览器解码时只转封装，保留低开销与原生供数速度。
function spawnTranscode(srcPort, isLive, skipSec, tsOffsetSec, transcodeVod=false, copyLive=false){
  // 直播:开 ffmpeg 底层重连,扛 P2P 抖动。
  // 点播:不开重连。点播源的 HTTP 连接只在两种情况下结束:内容真到结尾,或它的 P2P 会话被 vodStop 掉。
  // 连接断了由 serveStream 的 onSegEnd 负地续接(重新 vodStart + -ss 跳过重叠),ffmpeg 自己不重连。
  const args=buildTranscodeArgs('http://127.0.0.1:'+srcPort+'/',isLive,skipSec,tsOffsetSec,transcodeVod,copyLive);
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
async function cachedVod(key, ttlMs, load, staleMs=0){
  const now=Date.now(), hit=vodCache.get(key);
  if(hit && (hit.promise || hit.expires>now)){
    vodCache.delete(key); vodCache.set(key,hit);
    return hit.promise || hit.value;
  }
  const stale=hit?.value!=null && hit.staleUntil>now ? hit : null;
  const entry={promise:null,value:null,expires:0,staleUntil:0};
  const promise=Promise.resolve().then(load).then(value=>{
    if(vodCache.get(key)===entry){ entry.value=value; entry.promise=null; entry.expires=Date.now()+ttlMs; entry.staleUntil=entry.expires+staleMs; }
    return value;
  },e=>{
    if(stale){
      console.warn('[vod cache] 使用旧数据 '+key+': '+String(e.message||e).slice(0,120));
      if(vodCache.get(key)===entry) Object.assign(entry,{value:stale.value,promise:null,expires:Date.now()+15000,staleUntil:stale.staleUntil});
      return stale.value;
    }
    if(vodCache.get(key)===entry) vodCache.delete(key);
    throw e;
  });
  entry.promise=promise; vodCache.delete(key); vodCache.set(key,entry);
  while(vodCache.size>160) vodCache.delete(vodCache.keys().next().value);
  return promise;
}
// current: 当前活动流。token=递增唯一标识(不用端口,端口会复用);ended=收到tellMessage(2)真结束;ffExited=ffmpeg已退出
let current={ token:0, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false, sid:null };
let endedVod={sid:'',at:0};  // 已确认结束的点播会话及实际送达片尾；App 退出后仍供页面按 sid 核对
let curBuf=0, curPaused=false, curBufAt=0, curPosAbs=0;  // 当前播放会话的缓冲深度、暂停状态和播放位置
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
  if(current.buffer) current.buffer.destroy();
  if(current.res && !current.res.writableEnded){ try{current.res.end();}catch(e){} }
  if(current.port){ queueStop(tok); adb(['forward','--remove','tcp:'+current.port]); }
  current={token:tok, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false, sid:null};
}

let needColdRestart=false, coldLaunchAt=0, coldStreamStarted=false;
const deadPortRestartPolicy=new DeadPortRestartPolicy();
function startupWarmup(){ return !!coldLaunchAt && !coldStreamStarted && Date.now()-coldLaunchAt<90000; }
function shouldRestartAfterDeadPort(count, nearEndVod){
  return deadPortRestartPolicy.shouldRestart(count,{nearEnd:nearEndVod,startupWarmup:startupWarmup()});
}
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
        coldLaunch=true; coldLaunchAt=Date.now(); coldStreamStarted=false;
      }
      for(let i=0;i<30 && !appRunning();i++) await sleep(1000);
      if(coldLaunch){ bootStep='等待应用启动…'; await sleep(1500); }
      bootStep='注入引擎…'; await attach();
      let login=await script.exports.loginState();
      if(!login.account && fs.existsSync(CREDS_FILE)){
        bootStep='等待应用自动登录…';
        for(let i=0;i<25 && !login.account;i++){
          await sleep(1000);
          login=await script.exports.loginState();
        }
      }
      if(!login.account){ console.log('[engine] 等待网页登录'); }
      else {
        bootStep='等待频道数据就绪…';
        let rdy={};
        for(let i=0;i<20;i++){
          rdy=await script.exports.engineReady();
          if(rdy.channels>0) break;
          await sleep(1500);
        }
        if(!rdy.channels) throw new Error('频道数据尚未就绪');
        if(!rdy.activated){
          bootStep='等待应用设备授权…';
          for(let i=0;i<20 && !rdy.activated;i++){
            await sleep(1500);
            rdy=await script.exports.engineReady();
          }
        }
        console.log('[engine] 频道 '+(rdy.channels||0)+' 授权 '+!!rdy.activated);
        if(!rdy.activated){
          bootStep='设备授权中…';
          const a=await script.exports.reAuth();
          console.log('[auth] 授权 chart='+a.chart+' option='+a.option+' auth='+a.auth+(a.err?' err='+a.err:''));
          rdy=await script.exports.engineReady();
          if(!rdy.activated) throw new Error(a.auth===3?'设备授权超时（淘星返回码 3）':'设备授权失败（返回码 '+a.auth+(a.err?'，'+a.err:'')+'）');
        }
      }
      state='ready'; bootStep='就绪'; lastActivity=Date.now(); console.log('[engine] ready');   // 刚就绪即重置空闲计时:否则慢冷启动后 lastActivity 已过期,引擎会被空闲定时器立刻回收,导致随后 login/channels 请求 503(刷新加载不出节目的真凶)
    } catch(e){ state='off'; await detachAgent(); session=null; script=null;
      bootStep='启动失败: '+(e.message||e); console.error('[engine] boot failed',e); throw e; }
    finally { bootPromise=null; }
  })(); return bootPromise;
}
async function detachAgent(){
  const attachedScript=script, attachedSession=session;
  try{ if(attachedScript) await attachedScript.exports.shutdownNetwork(); }catch(e){}
  try{ if(attachedSession) await attachedSession.detach(); }catch(e){}
}
async function attach(){
  const dev=await frida.getUsbDevice(); let app=null;
  for(let i=0;i<40;i++){ const apps=await dev.enumerateApplications(); app=apps.find(a=>a.identifier===PKG&&a.pid>0); if(app)break; await sleep(1000); }   // 崩溃冷重启后App启动可能>20s,放宽到40s避免"应用未就位"导致彻底断
  if(!app) throw new Error('应用未就位');
  session=await dev.attach(app.pid);
  session.detached.connect((reason)=>{
    // 片尾源先断、原生 App 随后崩溃时，onSegEnd 正在续接。保留 HTTP 响应和已缓冲的视频，
    // 让续接流程冷启动引擎继续核对后续内容；直接 cleanup 会把断流伪装成已播完。
    if((current.splicing || current.buffer) && current.res && !current.res.writableEnded) console.log('[engine] 原生会话退出，保留点播续接与客户端缓冲');
    else cleanupCurrent();
    script=null; session=null;
    if(state==='ready'){ state='off'; needColdRestart=true; console.log('[engine] session dropped ('+reason+') -> off; 下次冷重启app修复P2P核心'); } });
  script=await session.createScript(fs.readFileSync(__dirname+'/agent.js','utf8'));
  // 捕获原生播放回调 tellMessage:i==2=真结束(片尾);其他为错误码
  script.message.connect(m=>{
    if(m.type==='error'){ console.error('[agent]',m.description); return; }
    if(m.type==='send' && m.payload && m.payload.vodCallbackGuard) console.log('[agent] 后台点播回调防护已安装');
    if(m.type==='send' && m.payload && m.payload.vodCallbackGuardError) console.error('[agent] 点播回调防护安装失败:',m.payload.vodCallbackGuardError);
    if(m.type==='send' && m.payload && m.payload.vodCallbackWarning) console.log('[agent] 已忽略后台点播错误提示:',m.payload.vodCallbackWarning);
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
  await detachAgent(); script=null; session=null;
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
const MAX_START_TRIES = 2;     // 常态最多两次原生取流；仅首次冷启动尚未成功出流时增加一次，避免重试 churn 毒死 P2P。
function serveStream(req, res, playFn, label, isLive, nearEndVod, vod){
  const requestedAt=Date.now();
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
      if(isLive) console.log('['+label+'] 就绪等待 '+(Date.now()-requestedAt)+'ms');
      if(res.writableEnded||req.destroyed){ return; }          // 客户端已断开
      if(mySeq !== reqSeq && (aborted || req.destroyed)){ return; }   // 等待期间又被取代且客户端已走,同上
      if(!script || !(await script.exports.loginState()).account) throw new Error('应用自动登录尚未完成');
      const hadStream=!!current.port; cleanupCurrent();
      // 立刻用新 token 占位(在 stop/settle 之前):一来 /api/streamstate 立即显示 alive(starting),前端看门狗不会在重取期间误判断流来抢流;
      // 二来上一路流若正在续接(onSegEnd),它每一步都核对 token,看到已换流就立刻作废,不会再去 vodStop/vodStart 干扰这一路
      current={ token:myToken, chid:label, port:0, ff:null, ended:false, ffExited:false, starting:true, sid:mySid };
      // 等上一路 P2P 会话真正 stop 完再起新流,并给原生引擎一点收尾时间(settle),否则快速重取(seek)可能拿到不出数据的死端口
      if(hadStream){ try{ if(script) await script.exports.stop(); }catch(e){} await sleep(700); }

      const firstByteMs = 12000;   // 首字节耐心:实测健康时 2.5-3.5 秒出数据,12秒已是3倍余量。
      // (曾设成30秒想"更有耐心",结果每次失败都要干等30秒、拖慢每一次拖进度,是过度矫正)
      let ff=null, myPort=0, buffered=null, deadPortCount=0;
      const maxStartTries=startupWarmup()?3:MAX_START_TRIES;
      for(let attempt=1; attempt<=maxStartTries && !aborted; attempt++){
        if(state!=='ready' || !script) throw new Error('取流引擎已断开，正在重新连接');
        const playStarted=Date.now();
        const r = await playFn();
        console.log('['+label+'] 原生取流 '+(Date.now()-playStarted)+'ms port='+(r&&r.port)+' callback='+(r&&r.callback));
        if(state!=='ready' || !script) throw new Error('取流引擎已断开，正在重新连接');
        if(aborted) break;
        if(!r || !r.port || r.port<=0){   // -1000 = 没挂表/没授权(hint_master_or_option_error),不是内容问题
          console.log('['+label+'] play 返回坏端口('+(r&&r.port)+') 重试 '+attempt+'/'+maxStartTries);
          if(r&&r.port===-1000 && attempt===1 && startupWarmup()){
            // 刚自动登录的取流核心可能还在异步初始化；此时重挂表会和 App 自己的启动流程并发。
            console.log('['+label+'] 冷启动取流核心未就绪，等 7 秒再试');
            await sleep(7000); continue;
          }
          try{ const a=await script.exports.reAuth(); console.log('[auth] 坏端口->温和重授权 chart='+a.chart+' option='+a.option+' auth='+a.auth); }catch(e){}   // 原生登录顺序:挂表、加载选项、设备授权
          try{ if(script) await script.exports.stop(); }catch(e){}   // await:避免stop晚到把下次重取的新流停掉
          await sleep(800); continue;
        }
        const port=r.port;
        adb(['forward','tcp:'+port,'tcp:'+port]);
        let cand=null, gotData=false, engineLost=false;
        // 同一端口最多就地重开3次:刚 vodStart 到新位置时P2P往往还没下载够,读到尽头会被当成EOF。
        // 就地重开 ffmpeg 不碰原生会话(零churn),等几秒让P2P追上来,比"拆掉整路重来"便宜得多也稳得多
        for(let sub=1; sub<=3 && !aborted; sub++){
        cand=spawnTranscode(port, isLive, 0, 0, !!(vod&&vod.transcode), !!(vod&&vod.copyLive));
        // 健康门限:等首字节。出数据=活端口;超时/即时退出=死端口,清理后重取
        const buf=[]; const collect=(d)=>buf.push(d); let onFirst, onCandExit, timer, watch;
        gotData = await new Promise(resolve=>{
          timer=setTimeout(()=>resolve(false), firstByteMs);
          watch=setInterval(()=>{ if(state!=='ready'||!script){ engineLost=true; resolve(false); } },250);
          onFirst=()=>resolve(true); onCandExit=()=>resolve(false);
          cand.stdout.on('data', collect);
          cand.stdout.once('data', onFirst);
          cand.once('exit', onCandExit);
        });
        clearTimeout(timer);
        clearInterval(watch);
        cand.stdout.removeListener('data', onFirst); cand.removeListener('exit', onCandExit);
        if(engineLost){ try{cand.kill('SIGKILL');}catch(e){} adb(['forward','--remove','tcp:'+port]); throw new Error('取流引擎崩溃，正在重新连接'); }
        if(gotData && !aborted){
          console.log('['+label+'] 首包到达 总计 '+(Date.now()-requestedAt)+'ms,本次取流 '+(Date.now()-playStarted)+'ms');
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
        console.log('['+label+'] 端口'+port+' 同端口重开3次仍无数据 -> 重新取流 '+attempt+'/'+maxStartTries);
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
        if(deadPortCount>0 && state==='ready'){
          if(shouldRestartAfterDeadPort(deadPortCount, nearEndVod)){
            console.log('['+label+'] 客户端已放弃且死端口持续出现 -> 冷重启App自愈');
            needColdRestart=true; await detachAgent();
          } else console.log('['+label+'] 坏端口未达到自愈门限或处于重启冷却期');
        }
        return;
      }
      if(!ff){   // 多次重取都失败,放弃(前端会收到502后自行再试)
        current={token:myToken, chid:null, port:null, ff:null, ended:false, ffExited:false, starting:false, sid:null};
        let restarting=false;
        if(state==='ready'){
          if(deadPortCount>0 && !shouldRestartAfterDeadPort(deadPortCount, nearEndVod)){
            console.log('['+label+'] 坏端口未达到自愈门限或处于重启冷却期');
          } else {
            console.log('['+label+'] 连续坏端口,P2P核心疑似卡死 -> 触发冷重启App');
            restarting=true;
            needColdRestart=true; await detachAgent();
          }
        }
        try{ res.status(502).end('播放启动失败:'+(restarting?'P2P核心卡死,正在自动重启,请稍候重试':'多次取流均无数据,请稍候重试')); }catch(e){}
        return;
      }

      current={ token:myToken, chid:label, port:myPort, ff, res, ended:false, ffExited:false, starting:false, sid:mySid };
      let reserve=null;
      if(!isLive && vod && VOD_BUFFER_MB>0 && !mySid.startsWith('download-')){
        try{ reserve=new VodBuffer({directory:pathMod.join(__dirname,'cache','playback'),capacity:Math.floor(VOD_BUFFER_MB*1024*1024)}); }
        catch(e){ console.error('[vod buffer] 预缓存不可用，继续直接播放:',e.message); }
      }
      current.buffer=reserve;
      if(reserve) reserve.on('error',e=>{ console.error('[vod buffer]',e.message); res.destroy(e); });
      const deliveryClock=new TransportClock();
      deadPortRestartPolicy.succeeded();
      coldStreamStarted=true;
      curBuf=0; curPaused=false; curBufAt=0; curPosAbs=0;
      current.lastData=Date.now();  // 首字节健康门限已收到数据；即使后续立刻静默也能计时检测
      console.log('['+label+'] port',myPort,'tok',myToken);
      res.setHeader('Content-Type','video/mp2t');
      let lastBump=0;
      let outBytes=0;
      if(buffered && buffered.length){ for(const c of buffered){ try{ (reserve||res).write(c); }catch(e){} } }  // 补发健康门限期间缓冲的首包(含PAT/PMT),不丢头
      // ——— 源断了由服务端无缝续接,客户端全程只看到一条不间断的流 ———
      // 源连接结束(真片尾之外)时:算出已经产出多少内容(包括磁盘预缓存),重新取流并用 -ss 跳过重叠部分、-output_ts_offset 接续时间戳,
      // 继续写进同一个 HTTP 响应,前端不重建播放器、不丢已缓冲内容。
      // (根治晚到 stop 之后,源断开应当很少见;续接是兜底,所以必须可靠:有首字节门限、失败重试、全程有日志。)
      const durSec = (vod && vod.dur>0) ? vod.dur : 0;
      const segStartAbs = durSec ? (vod.percent/100*durSec) : 0;
      let deliveredSec = 0, segOut = 0, splicing = false, finished = false, emptySplices = 0;
      let bufPaused=false, probeStartedAt=0, probeBytes=0, nextProbeAt=Date.now()+30000, needDataAt=Date.now();
      let exitedDuringSplice=null;
      let wantSplice = false;   // 停滞检测主动 SIGKILL 当前段并要求续接时置真(否则 SIGKILL 一律视为我们主动拆流,不续接)
      const endOutput=()=>{ if(reserve){ if(!reserve.writableEnded&&!reserve.destroyed)reserve.end(); }else res.end(); };
      const readProgress = (d)=>{ const m=(''+d).match(/out_time_us=(\d+)/g); if(m&&m.length){ const v=parseInt(m[m.length-1].split('=')[1],10); if(!isNaN(v)) segOut = v/1e6; } };
      const bufferedAhead = (now)=>Math.max(curBuf,
        curPosAbs>0 && now-curBufAt<10000
          ? Math.max(0,segStartAbs+(reserve?deliveryClock.seconds:deliveredSec+segOut)-curPosAbs) : 0);
      // 无磁盘预缓存时保留原来的限流路径：stdout.pause() 与 pipe(res) 配合未能持续限流，
      // 需暂停 ffmpeg 进程限制 MSE 缓冲，并定期 SIGCONT 探测源健康。
      const pauseSource = (proc)=>{ if(proc!==ff || bufPaused) return;
        if(proc.kill('SIGSTOP')){ bufPaused=true; current.throttled=true; }
      };
      const resumeSource = (proc)=>{ if(proc!==ff || !bufPaused) return;
        if(proc.kill('SIGCONT')){ bufPaused=false; current.throttled=false; }
      };

      const wire = (proc)=>{
        proc.stdout.on('data',(d)=>{
          if(proc!==ff) return;
          outBytes+=d.length; const now=Date.now();
          if(current.token===myToken){ current.lastData=now; current.outTotal=(current.outTotal||0)+d.length; }
          if(now-lastBump>4000){ lastBump=now; lastActivity=now; }
          // 节流期间定期只放行少量数据探测源是否还活着；收到足够数据就立刻重新背压。
          if(probeStartedAt && proc===ff && outBytes-probeBytes>=65536){
            probeStartedAt=0; nextProbeAt=now+30000;
            const paused=curPaused && now-curBufAt<10000;
            if(bufferedAhead(now)>(paused?160:100)) pauseSource(proc);
          }
        });
        proc.stderr.on('data',d=>{ if(proc===ff) readProgress(d); });
        proc.stdout.pipe(reserve||res,{end:false}); // 浏览器缓冲满时仅停投递，原生继续填磁盘预缓存
        proc.on('close',(code,sig)=>{ onSegEnd(proc,sig); }); // stdout 排空后才续接或结束，不丢尾包
        proc.on('error',(e)=>{ console.error('[ff spawn err]',e&&e.message); if(!splicing) onSegEnd(proc,null); });
      };

      // 等某段 ffmpeg 出首字节:出了=true;先退出/超时=false
      const waitFirstByte = (proc, ms) => new Promise(resolve=>{ let settled=false;
        const done=(v)=>{ if(settled) return; settled=true; clearTimeout(t); proc.stdout.removeListener('data',onD); proc.removeListener('exit',onX); proc.removeListener('error',onX); resolve(v); };
        const onD=()=>done(true), onX=()=>done(false); const t=setTimeout(()=>done(false), ms);
        proc.stdout.once('data',onD); proc.once('exit',onX); proc.once('error',onX); });

      async function onSegEnd(proc, sig){
        if(current.token===myToken && current.ff===proc) current.ffExited=true;
        if(finished) return;
        if(splicing){ if(proc===ff) exitedDuringSplice={proc,sig}; return; }
        if(sig==='SIGKILL' && !wantSplice) return;                     // 我们主动拆的(seek/切集/客户端离开);停滞检测发起的 SIGKILL 例外,要续接
        wantSplice=false;
        if(res.writableEnded || req.destroyed){ finished=true; return; }
        const segLen = segOut; deliveredSec += segOut; segOut = 0;
        const resumeAbs = segStartAbs + deliveredSec;
        // 连续多次续接都几乎取不到内容 = 真到片尾(或源彻底没了),停止续接,否则会在片尾无限重连
        if(segLen < 2) emptySplices++; else emptySplices = 0;
        // 片长只是目录估计值：此集实际供数到 3135s，标注却只有 3108s。
        // 源已完整输出且超过标注片长 10 秒时，记录实际片尾给浏览器；其余断流仍续接。
        const sourcePastCatalogEnd=!!durSec && resumeAbs>=durSec+10 && proc.exitCode===0 && !sig && segLen>=10;
        const confirmedEnd=emptySplices>=3 || (current.token===myToken && current.ended) || sourcePastCatalogEnd;
        if(isLive || !vod || !vod.mkPlay || confirmedEnd){
          if(!isLive && current.token===myToken && confirmedEnd) endedVod={sid:mySid,at:resumeAbs};
          finished=true; try{ endOutput(); }catch(e){}
          console.log('['+label+'] 结束于 '+resumeAbs.toFixed(0)+'s'+(durSec?('/'+durSec+'s'):'')+(emptySplices>=3?'(连续取不到内容)':''));
          return;
        }
        if(current.token!==myToken){ finished=true; return; }         // 已有更新的流接管(用户刚好在此刻换流):本路作废,绝不能再去 stop(会停掉新流的会话)
        splicing = true; current.splicing=true;                        // 续接期间 /api/streamstate 仍报 alive,前端别来抢流
        bufPaused=false; probeStartedAt=0; needDataAt=Date.now();
        // 知道总时长就跳到最近的百分点(跳过的秒数少、续接快);不知道(老页面没传dur)就用同一个百分点跳过已播时长——同样正确,只是跳过得多一点
        const pct = durSec ? Math.max(0, Math.min(96, Math.floor(resumeAbs/durSec*100))) : vod.percent;
        const skip = durSec ? Math.max(0, resumeAbs - pct/100*durSec) : deliveredSec;
        console.log('['+label+'] 源断开于 '+resumeAbs.toFixed(0)+'s(本段供数 '+segLen.toFixed(0)+'s, 客户端缓冲 '+curBuf.toFixed(0)+'s) -> 无缝续接(从'+pct+'%跳过'+skip.toFixed(0)+'s)');
        const t0=Date.now();
        try{
          let ok=false, failedPorts=0;
          while(!ok && !finished){
            if(res.writableEnded || req.destroyed || current.token!==myToken){ finished=true; return; }
            let failure=null;
            try{
              try{ if(script) await script.exports.stop(); }catch(e){}
              await sleep(600);
              await ensureReady();                     // 续接期间引擎可能已崩/被回收
              if(!script) throw new Error('引擎未就绪');
              if(res.writableEnded || req.destroyed || current.token!==myToken){ finished=true; return; }
              const r = await vod.mkPlay(pct);
              if(!r || !r.port || r.port<=0) throw new Error('续接取流失败 port='+(r&&r.port));
              adb(['forward','tcp:'+r.port,'tcp:'+r.port]);
              if(myPort && myPort!==r.port) adb(['forward','--remove','tcp:'+myPort]);
              myPort = r.port;
              // 新端口可能还在等 P2P 下载。同一原生会话重开一次 ffmpeg，避免无谓的 vodStop/vodStart。
              for(let sub=1; sub<=2 && !finished; sub++){
                const cand = spawnTranscode(r.port, isLive, skip, deliveredSec, !!(vod&&vod.transcode));
                ff = cand;                             // 客户端离开时 teardown 能杀掉当前段
                if(current.token===myToken){ current.ff=cand; current.port=r.port; current.ffExited=false; }
                wire(cand);                            // 等首字节时直接转发，不丢 TS 头
                ok = await waitFirstByte(cand, firstByteMs);
                if(res.writableEnded || req.destroyed || current.token!==myToken){ finished=true; try{cand.kill('SIGKILL');}catch(e){} return; }
                if(ok){ console.log('['+label+'] 续接成功 port '+r.port+' 第'+sub+'次,断开到出数据 '+((Date.now()-t0)/1000).toFixed(1)+'s'); break; }
                console.log('['+label+'] 续接 port '+r.port+' '+(firstByteMs/1000)+'秒未出数据,同端口第'+sub+'次');
                try{ cand.stdout.unpipe(reserve||res); cand.kill('SIGKILL'); }catch(e){}
                if(sub<2) await sleep(2500);
              }
            }catch(e){ failure=e; }
            if(ok) break;
            if(res.writableEnded || req.destroyed || current.token!==myToken){ finished=true; return; }
            failedPorts++;
            // 客户端仍有内容可看时保持同一 HTTP 响应和 MSE 缓冲，不让前端重建播放器清空库存。
            // 故障期间放慢重试；播放缓冲见底后才交给前端的整路恢复流程。
            if(!(curPaused && Date.now()-curBufAt<10000) && curBuf<4) throw failure||new Error('续接多次无数据且客户端缓冲不足');
            const delay=Math.min(30000,3000*Math.pow(2,Math.min(failedPorts,3)));
            console.log('['+label+'] 续接未出数据'+(failure?('('+String(failure.message||failure).slice(0,80)+')'):'')+',剩余缓冲 '+curBuf.toFixed(0)+'s, '+(delay/1000)+'秒后重试');
            await sleep(delay);
          }
          if(finished) return;
        }catch(e){
          console.error('['+label+'] 续接失败:', e&&(e.message||e));
          finished=true; try{ endOutput(); }catch(_){} // 先耗尽已有预缓存，再交给前端恢复
        }finally{
          splicing=false; if(current.token===myToken) current.splicing=false;
          const exited=exitedDuringSplice; exitedDuringSplice=null;
          if(exited && !finished && current.token===myToken && exited.proc===ff) setImmediate(()=>onSegEnd(exited.proc,exited.sig));
        }
      }

      wire(ff);
      if(reserve) reserve.relay(res,d=>{
        deliveryClock.push(d);
        if(current.token!==myToken)return;
        // 每个传输块检查已送达的时间轴，避免本地缓存瞬间灌满浏览器内存。
        const now=Date.now(), high=curPaused&&now-curBufAt<10000?180:120;
        if(bufferedAhead(now)>high) reserve.setDeliveryPaused(true);
      }).catch(e=>{ console.error('[vod buffer relay]',e.message); res.destroy(e); });

      // 播放时留约100-120秒、暂停时留约160-180秒。源/端口恢复常耗数十秒，
      // 旧的56-60秒缓冲在1.25倍速下不够撑过一次失败续接。
      const throttle = isLive ? null : setInterval(()=>{
        if(current.token!==myToken){ clearInterval(throttle); return; }
        try{
          if(!reserve && (splicing || finished || wantSplice)) return;
          const now=Date.now(), paused=curPaused && now-curBufAt<10000;
          const high=paused?180:120, low=paused?160:100;
          // MSE 追加常落后于网络接收。只看 V.buffered 会在已发送数分钟数据后才背压；
          // 磁盘缓存路径使用投递时钟；直传路径使用 ffmpeg out_time，提前限制在途内容。
          const ahead=bufferedAhead(now);
          current.ahead=Math.round(ahead*10)/10;
          if(reserve){
            if(reserve.deliveryPaused && ahead<low) reserve.setDeliveryPaused(false);
            else if(ahead>high) reserve.setDeliveryPaused(true);
            current.throttled=reserve.deliveryPaused;
            current.prefetchPaused=reserve.backpressured;
            if(reserve.backpressured) needDataAt=now;
            else if(!splicing && !finished && !wantSplice && current.lastData && now-Math.max(current.lastData,needDataAt)>20000){
              console.log('['+label+'] 预取20秒未供数，保留 '+(reserve.pendingBytes/1048576).toFixed(1)+'MiB 缓存并续接');
              wantSplice=true; ff.kill('SIGKILL');
            }
            return;
          }
          if(probeStartedAt){
            if(now-probeStartedAt>15000){
              console.log('['+label+'] 节流探测15秒无数据,缓冲 '+curBuf.toFixed(0)+'s -> 提前续接');
              probeStartedAt=0; wantSplice=true; ff.kill('SIGKILL');
            }
            return;
          }
          if(bufPaused){
            if(ahead<low){ resumeSource(ff); needDataAt=now; }
            else if(now>=nextProbeAt){
              // 背压时无法仅凭 lastData 判断源健康：每30秒放行64KB；若15秒拿不到，趁客户端仍有缓冲就续接。
              probeStartedAt=now; probeBytes=outBytes; needDataAt=now;
              resumeSource(ff);
            }
          }else if(ahead>high){ pauseSource(ff); nextProbeAt=now+30000; }
          current.throttled=bufPaused;
          // 真正需要数据时20秒未出数就续接。暂停填库也检查；播放时在缓冲还有约90秒就检查。
          if(!bufPaused && !probeStartedAt && (paused || curBuf<90) && current.lastData &&
              now-Math.max(current.lastData,needDataAt)>20000){
            console.log('['+label+'] '+(paused?'暂停期间':'播放期间')+'源20秒无数据,缓冲 '+curBuf.toFixed(0)+'s -> 提前续接');
            wantSplice=true; ff.kill('SIGKILL');
          }
        }catch(e){}
      }, 1000);
      // 拆掉正在播放的流(用户seek/切集换流、关页面时走这里)。
      const teardown=()=>{ finished=true; if(throttle)clearInterval(throttle); if(reserve)reserve.destroy(); try{ff.kill('SIGKILL');}catch(e){} if(current.token===myToken){ adb(['forward','--remove','tcp:'+myPort]); current={token:myToken,chid:null,port:null,ff:null,ended:false,ffExited:false,starting:false,sid:null};
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
// 同一套页面同时支持 / 和 /TXTV/；反向代理保留前缀转发即可。
app.use((req,res,next)=>{
  if(req.url==='/TXTV' || req.url.startsWith('/TXTV?')) return res.redirect(308,'/TXTV/');
  if(req.url.startsWith('/TXTV/')) req.url=req.url.slice('/TXTV'.length);
  next();
});
app.use(express.json());
app.get('/', (req,res)=>{ res.set('Cache-Control','no-cache, no-store, must-revalidate'); res.sendFile(__dirname+'/public/index.html'); });
app.get('/mpegts.js', (req,res)=>res.sendFile(__dirname+'/node_modules/mpegts.js/dist/mpegts.js'));
const streamAlive=()=> (!!current.ff && !current.ffExited) || !!current.starting || !!current.splicing || (current.buffer?.pendingBytes>0);
app.get('/api/status', (req,res)=>res.json({state, step:bootStep, playing:current.chid, ended:current.ended, alive:streamAlive()}));
app.post('/api/wake', (req,res)=>{ lastActivity=Date.now(); bootEmulator().catch(()=>{}); res.json({state, step:bootStep}); });
app.post('/api/heartbeat', (req,res)=>{ lastActivity=Date.now(); res.json({ok:true, state}); });
// 流状态:前端用来区分"临时卡顿(alive,等就好)"vs"真结束(ended)"vs"断流(!alive)"
app.get('/api/streamstate', (req,res)=>res.json({ ended:current.ended, endedSid:endedVod.sid, endedAt:endedVod.at, alive:streamAlive(), feeding: (current.buffer?.pendingBytes>0) || (!!current.ff && !current.ffExited && ((Date.now()-(current.lastData||0) < 3000) || !!current.throttled)), chid:current.chid, sid:current.sid, starting:!!current.starting, curBuf, ahead:current.ahead, paused:curPaused, throttled:!!current.throttled, splicing:!!current.splicing, cacheBytes:current.buffer?.pendingBytes||0, cacheCapacityBytes:current.buffer?.capacity||0, prefetchPaused:!!current.prefetchPaused, fetchedBytes:current.outTotal||0 }));
app.get('/api/buf', (req,res)=>{ if(current.sid && req.query.sid===current.sid){ curBuf=Math.max(0,parseFloat(req.query.d)||0); curPaused=req.query.p==='1'; curPosAbs=Math.max(0,parseFloat(req.query.pos)||0); curBufAt=Date.now(); } res.json({ok:true}); });  // 只接受当前流的缓冲量，旧页面/旧流不能误节流新流

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
    await detachAgent();
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
      catalog = null; vodCache.clear(); vodBase=null;
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
    needColdRestart = true; await detachAgent();
    catalog = null; vodCache.clear(); vodBase=null; res.json({ ok:true });
  } catch(e){ res.status(500).json({ error: ''+(e.message||e) }); }
});

app.get('/api/channels', async (req,res)=>{
  try { await ensureReady(); if(!catalog) catalog=await script.exports.dump(); res.json(catalog); }
  catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});

// 彭博财经原片已是 H.264；VideoToolbox 重编码会产生可重复的 H.264 解码错误与浏览器重连。
const LIVE_COPY_IDS=new Set(['637']);
app.get('/stream/:chid', (req,res)=>{ const chid=req.params.chid; serveStream(req,res,()=>{
  if(!script) throw new Error('取流引擎未就绪');
  return script.exports.play(chid,0);
}, 'live:'+chid, true, false, {copyLive:LIVE_COPY_IDS.has(chid)||req.query.copy==='1'}); });

app.post('/api/stop', async (req,res)=>{ lastActivity=Date.now(); cleanupCurrent(); res.json({ok:true}); });
app.post('/api/leave', async (req,res)=>{ if(req.query.sid===current.sid || (!req.query.sid && !String(current.sid||'').startsWith('download-'))) cleanupCurrent(); res.json({ok:true}); });

// ---------- VOD 点播 ----------
const xml = new XMLParser({ ignoreAttributes:false, cdataPropName:'cdata', trimValues:true });
function txt(node){ if(node==null) return ''; if(typeof node==='object'){ if('cdata'in node) return (''+node.cdata).trim(); if('#text'in node) return (''+node['#text']).trim(); return ''; } return (''+node).trim(); }
function arr(x){ return Array.isArray(x)?x:(x==null?[]:[x]); }
let vodBase=null, vodInitPromise=null;
async function vodInit(){ if(vodBase)return;
  if(!vodInitPromise) vodInitPromise=(async()=>{
    // 搜索结果已给出完整 playid；取详情只需要基址。额外请求目录根节点既慢又会因上游 +3 阻断有效详情。
    const u=await script.exports.vodUrls();
    if(!u.VODBASE_URL) throw new Error('环球剧场点播基址尚未就绪');
    vodBase=u.VODBASE_URL;
  })().finally(()=>{ vodInitPromise=null; });
  await vodInitPromise;
}
async function vodFetch(path){ await ensureReady(); await vodInit(); const full=/^https?:|^\d/.test(path)?path:(vodBase+path); return script.exports.vodGet(full); }
function parseVod(raw, root){ const data=xml.parse(raw); if(!data[root]){
  const code=String(raw||'').trim(); throw new Error(/^[+-]\d+$/.test(code)?'点播上游返回错误码 '+code:'点播数据暂不可用');
} return data; }
function decryptOld(s){ const key=Buffer.from('FB0D2346'.repeat(3)); const dec=crypto.createDecipheriv('des-ede3',key,null); return Buffer.concat([dec.update(Buffer.from(txt(s),'base64')),dec.final()]).toString('utf8'); }

async function nativeVodCategories(){ return cachedVod('native-categories',10*60*1000,async()=>{
  await ensureReady();
  const u=await script.exports.vodUrlsOld();
  if(!u.VODROOT_URL || !u.VODBASE_URL || !u.VODROOT_URL.startsWith(u.VODBASE_URL)) throw new Error('原生点播目录地址尚未就绪');
  const data=parseVod(await script.exports.vodGetOld(u.VODROOT_URL.slice(u.VODBASE_URL.length)),'category');
  const categories=arr(data.category.file).map(f=>{
    let pathname; try{pathname=new URL(txt(f.url)).pathname;}catch(e){return null;}
    const m=pathname.match(/^\/([A-Za-z0-9_-]+)\/\d+\.xml$/i);
    return m ? {type:txt(f.name),link:'old:'+m[1],code:m[1]} : null;
  }).filter(c=>c&&c.type);
  if(!categories.length) throw new Error('原生点播目录没有可用分类');
  return {categories};
},60*60*1000); }

app.get('/api/vod/categories', async (req,res)=>{
  try { res.json(await nativeVodCategories());
  } catch(e){ console.warn('[vod categories]',e.message||e); res.status(503).json({error:''+(e.message||e)}); }
});
app.get('/api/vod/list', async (req,res)=>{
  try { const path=req.query.path; if(typeof path!=='string'||!path) return res.status(400).json({error:'no path'});
    if(path.startsWith('old:')){
      const page=Number(req.query.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000) return res.status(400).json({error:'无效页码'});
      const cat=(await nativeVodCategories()).categories.find(c=>c.link===path);
      if(!cat) return res.status(404).json({error:'原生点播分类不存在'});
      return res.json(await cachedVod('native-list:'+cat.code+':'+page,5*60*1000,async()=>{
        const data=parseVod(await script.exports.vodGetOld(cat.code+'/'+page+'.xml'),'category');
        if(txt(data.category['@_name'])!==cat.code) throw new Error('原生点播分类数据不匹配');
        const pages=Math.max(page,Number(data.category.page)||page);
        const films=arr(data.category.file).map(f=>{ try{
          const pic=decryptOld(f.img), playid=decryptOld(f.url);
          if(!pic.startsWith(cat.code+'/')||!playid.startsWith(cat.code+'/')) return null;
          return {filmid:playid.split('/')[1],title:txt(f.name),pic:'old:'+pic,remark:'',playid:'old:'+playid,type:'old'};
        }catch(e){return null;} }).filter(Boolean);
        return {films,page,pages};
      },60*60*1000));
    }
    res.json(await cachedVod('list:'+path,5*60*1000,async()=>{
      const data=parseVod(await vodFetch(path),'Playlist');
      const films=arr(data.Playlist.film).map(f=>({filmid:txt(f.filmid),title:txt(f.title),pic:txt(f.pic),remark:txt(f.remark),playid:txt(f.playid)}));
      return {films};
    },60*60*1000));
  } catch(e){ console.warn('[vod list]',e.message||e); res.status(503).json({error:''+(e.message||e)}); }
});
async function vodDetail(playid){
  return cachedVod('detail:'+playid,30*60*1000,async()=>{
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
    },60*60*1000);
}
app.get('/api/vod/detail', async (req,res)=>{
  try { const playid=req.query.playid; if(!playid) return res.status(400).json({error:'no playid'});
    res.json(await vodDetail(playid));
  } catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});

// 离线下载在服务端串行运行；关掉网页不影响队列，播放中的原生取流优先。
const downloads = new DownloadQueue({
  root:pathMod.join(__dirname,'cache','downloads'), port:PORT, ffmpeg:FFMPEG,
  getActiveStream:()=>current,
});
app.get('/api/downloads', (req,res)=>res.json(downloads.snapshot()));
app.post('/api/downloads/directory', (req,res)=>{
  try{ res.json(downloads.setDirectory(req.body?.directory)); }
  catch(e){ res.status(400).json({error:String(e.message||e)}); }
});
app.post('/api/downloads', async(req,res)=>{
  try{
    const playid=req.body?.playid, index=req.body?.episodeIndex;
    if(typeof playid!=='string'||playid.length>300||!Number.isInteger(index)||index<0) return res.status(400).json({error:'选集无效'});
    const detail=await vodDetail(playid), episode=detail.episodes?.[index];
    if(!episode) return res.status(404).json({error:'选集不存在'});
    const job=downloads.enqueue({playid,episodeIndex:index,title:detail.film.title,episode});
    res.json({job});
  }catch(e){ res.status(503).json({error:String(e.message||e)}); }
});
app.post('/api/downloads/:id/cancel', (req,res)=>{
  try{ res.json({job:downloads.cancel(req.params.id)}); }
  catch(e){ res.status(400).json({error:String(e.message||e)}); }
});
app.post('/api/downloads/:id/retry', (req,res)=>{
  try{ res.json({job:downloads.retry(req.params.id)}); }
  catch(e){ res.status(400).json({error:String(e.message||e)}); }
});
app.delete('/api/downloads/:id', (req,res)=>{
  try{ res.json({job:downloads.remove(req.params.id)}); }
  catch(e){ res.status(400).json({error:String(e.message||e)}); }
});

function toInitials(han){ return pinyin(han,{pattern:'first',toneType:'none',type:'array'}).join('').toUpperCase().replace(/[^A-Z]/g,''); }
function searchTitle(s){
  const title=String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
  const nums={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  return title.replace(/第([一二三四五六七八九十\d]+)季/g,(_,n)=>'第'+(Number(n)||nums[n]||n)+'季');
}
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
  // 同片多源时默认与电视首页“点播”一致。Silo 两季与黄石的持续取流对照
  // 均为电视点播更快；环球剧场仍保留为手动可选片源和独有节目的来源。
  for(const f of films){
    f.sources.sort((a,b)=>(a.type==='old'?0:1)-(b.type==='old'?0:1));
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
function searchContext(q){
  const lookup=titleAliases.get(searchTitle(q))||q;
  const hanMatch=lookup.match(/[一-鿿]+/);
  const isName=!!hanMatch;
  const searchKey=isName?toInitials(hanMatch[0]):lookup.toUpperCase().replace(/[^A-Z0-9]/g,'');
  return {q,lookup,isName,searchKey};
}
function searchResult(ctx,found,complete){
  const {q,lookup,searchKey,isName}=ctx;
  const films=mergeSearchResults(found.map(r=>r?.status==='fulfilled'?r.value:[]),lookup,searchKey,isName);
  const names=found.map((r,i)=>r?.status==='fulfilled'?(i?'环球剧场':'电视点播'):null).filter(Boolean);
  return {query:q,initials:searchKey,count:films.length,films,source:names.join(' + '),
    partial:found.some(r=>r?.status==='rejected'),complete};
}
function oldSearch(searchKey){
  return cachedVod('searchOld:'+searchKey,5*60*1000,async()=>{
    const raw=await script.exports.vodSearchOld(searchKey);
    const data=JSON.parse(raw);
    return arr(data.items).map(f=>({filmid:txt(f.folder),title:txt(f.name),pic:'old:'+txt(f.category)+'/'+txt(f.folder)+'/'+txt(f.img),remark:txt(f.v_type),playid:'old:'+txt(f.category)+'/'+txt(f.folder)+'/'+txt(f.url),type:'old'}))
      .filter(f=>/^old:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.xml$/.test(f.playid));
  });
}
function fetchNewSearch(key){
  return cachedVod('searchNewRaw:'+key,5*60*1000,async()=>{
    const raw=await script.exports.vodSearch('vod',key,'all',0);
    const data=JSON.parse(raw);
    return arr(data.filmlist).map(f=>({filmid:f.filmid,title:f.title,pic:f.pic,remark:f.remark,playid:f.playxml,type:'new'}));
  });
}
async function newSearch(ctx,onBroad){
  const {searchKey,lookup,isName}=ctx;
  // 环球剧场的完整拼音索引会漏掉第一季；先查短前缀，再用完整片名过滤。
  const key=searchKey.length>2?searchKey.slice(0,2):searchKey;
  let broad; try{ broad=await fetchNewSearch(key); }
  catch(e){ if(key===searchKey) throw e; return fetchNewSearch(searchKey); }
  const matched=key!==searchKey ? mergeSearchResults([broad],lookup,searchKey,isName) : [];
  if(key!==searchKey && (broad.length>=80 || !matched.length)){
    // 精确索引补查仍在进行时先把短前缀命中的结果送到页面，第一季无需等补查结束。
    if(matched.length) onBroad?.(broad);
    try{ return broad.concat(await fetchNewSearch(searchKey)); }
    catch(e){ if(!broad.length) throw e; }
  }
  return broad;
}
async function searchCatalogs(ctx,onProgress){
  await ensureReady();
  const found=[null,null], done=[false,false], started=Date.now();
  const calls=[()=>oldSearch(ctx.searchKey),()=>newSearch(ctx,broad=>{
    found[1]={status:'fulfilled',value:broad};
    if(onProgress) onProgress(searchResult(ctx,found,false));
  })];
  await Promise.all(calls.map(async(call,i)=>{
    const t0=Date.now();
    try{ found[i]={status:'fulfilled',value:await call()}; }
    catch(e){ found[i]={status:'rejected',reason:e};
      console.log('[search] '+(i?'环球剧场':'电视点播')+'查询失败:',String(e).slice(0,100)); }
    done[i]=true;
    console.log('[search] '+(i?'环球剧场':'电视点播')+' '+ctx.searchKey+' '+(Date.now()-t0)+'ms');
    if(onProgress && !done.every(Boolean) && found.some(r=>r?.status==='fulfilled')) onProgress(searchResult(ctx,found,false));
  }));
  if(found.every(r=>r.status==='rejected')) throw new Error('两套点播搜索暂不可用');
  console.log('[search] 合并 '+ctx.searchKey+' '+(Date.now()-started)+'ms');
  return searchResult(ctx,found,true);
}
app.get('/api/search', async (req,res)=>{
  try{ const q=String(req.query.q||'').trim(); if(!q) return res.json({films:[]});
    const ctx=searchContext(q); if(!ctx.searchKey) return res.json({films:[],initials:''});
    // 同一首字母的不同输入复用两套原始索引结果。
    res.json(await cachedVod('search:'+q,10*1000,()=>searchCatalogs(ctx)));
  }catch(e){ res.status(503).json({error:''+(e.message||e)}); }
});
app.get('/api/search/stream', async(req,res)=>{
  const q=String(req.query.q||'').trim();
  if(!q) return res.status(400).json({error:'no query'});
  const ctx=searchContext(q);
  if(!ctx.searchKey) return res.status(400).json({error:'invalid query'});
  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  let closed=false; res.on('close',()=>{closed=true;});
  const send=d=>{if(!closed) res.write('data: '+JSON.stringify(d)+'\n\n');};
  try{
    const result=await searchCatalogs(ctx,send);
    send(result);
  }catch(e){ send({error:String(e.message||e),complete:true}); }
  if(!closed) res.end();
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

let exiting=false;
async function gracefulExit(sig){
  if(exiting) return; exiting=true;
  console.log('['+sig+'] 退出:保存下载进度并释放当前流');
  try{ await downloads.close(); }catch(e){ console.error('[downloads] 退出时保存失败',e); }
  try{ cleanupCurrent(); }catch(e){}
  await detachAgent();
  process.exit(0);
}
process.on('SIGINT', ()=>gracefulExit('SIGINT'));
process.on('SIGTERM', ()=>gracefulExit('SIGTERM'));   // launchd 用 SIGTERM
app.listen(PORT, ()=>console.log(`\n淘星TV: http://localhost:${PORT}  (空闲 ${IDLE_MS/1000}s 自动关引擎, ffmpeg 转码)\n`));
