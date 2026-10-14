import Java from 'frida-java-bridge';
import { javaNetwork, shutdownJavaNetwork } from './agent-workers.js';

const callbackState = { last: 0, ended: 0, count: 0 };
// App.setClassRef 注册的直播/点播回调类不同。JNI 缓存的 methodID 必须
// 配合对应类的实例；仅实现 ITellMessage 的内存 DEX 对象并不足够。
const playbackCallbacks = {
  live: { className: 'com.wys.iptvgo.activity.TimeShiftPlayActivity', errorMethod: 'lambda$tellMessage$2$TimeShiftPlayActivity' },
  vod: { className: 'com.newvod.activity.VodPlayActivity', errorMethod: 'lambda$tellMessage$1$VodPlayActivity' },
};
// 后台 Activity 没有初始化界面，原版错误提示与重播逻辑会操作空播放器。
// 接管所有通知，再在主线程创建并长期保留与原生注册类匹配的回调实例。
Java.perform(() => {
  for (const [kind, entry] of Object.entries(playbackCallbacks)) {
    try {
      const Activity = Java.use(entry.className);
      Activity.tellMessage.overload('int').implementation = function (code) {
        callbackState.last = code; callbackState.count++;
        if (code === 2) callbackState.ended = 1;
        send({ tell: code, playbackKind: kind });
      };
      // 防止此前已经排入队列的原版错误 Runnable 操作未初始化的播放器。
      try {
        Activity[entry.errorMethod].overload('java.lang.String').implementation = function (message) {
          send({ playbackCallbackWarning: kind + ': ' + String(message) });
        };
      } catch (e) { send({ playbackCallbackWarning: kind + ' 错误提示防护: ' + String(e) }); }
      entry.guarded = true;
      send({ playbackCallbackGuard: kind });
    } catch (e) { send({ playbackCallbackGuardError: kind + ': ' + String(e) }); }
  }
});
function ensurePlaybackCB(kind) {
  const entry = playbackCallbacks[kind];
  if (entry.instance) return Promise.resolve(entry.instance);
  if (entry.pending) return entry.pending;
  entry.pending = new Promise((resolve, reject) => Java.perform(() => {
    Java.scheduleOnMainThread(() => {
      try {
        if (!entry.guarded) throw new Error('后台播放回调防护未就绪');
        const Activity = Java.use(entry.className);
        entry.instance = Java.retain(Java.cast(Activity.$new(), Java.use('dnet.ITellMessage')));
        resolve(entry.instance);
      } catch (e) { reject(new Error('App 原生播放回调创建失败: ' + (e.stack || e))); }
    });
  })).catch(e => { entry.pending = null; throw e; });
  return entry.pending;
}

function dumpList(listVal, ChannelCls) {
  if (!listVal) return [];
  const n = listVal.size(); const out = [];
  for (let i = 0; i < n; i++) {
    const ch = Java.cast(listVal.get(i), ChannelCls);
    const g = f => { try { const v = ch[f].value; return v == null ? null : '' + v; } catch(e){ return null; } };
    out.push({ name:g('videoName'), channelId:g('channelId'), sort:g('sort'), link:g('link'), epg:g('epg'), index: parseInt(g('index')||'0',10) });
  }
  return out;
}

rpc.exports = {
  shutdownNetwork: shutdownJavaNetwork,
  dlPoster: function (pic, devPath) {
    return javaNetwork('posters', () => {
      const CD=Java.use('com.newvod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
      const url = CD.VODBASE_URL.value + pic + '?name='+CD.g_account.value+'&pass='+CD.g_password.value+'&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
      return { ret: VC.icBigFile(url, devPath, null, 0) };
    });
  },
  dlPosterOld: function (pic, devPath) {
    return javaNetwork('posters', () => {
      const CD=Java.use('com.vod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
      const url=CD.VODBASE_URL.value+'vod/pic/'+pic+'?name='+CD.g_account.value+'&pass='+CD.g_password.value+
        '&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
      return {ret:VC.icBigFile(url,devPath,null,0)};
    });
  },
  vodSearch: function (db, keywords, type, scope) {
    return javaNetwork('metadata', () => {
      const CD=Java.use('com.newvod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
      const url = CD.VODSEARCH_URL.value + '?db='+db+'&keywords='+keywords+'&type='+(type||'all')+'&scope='+(scope||0)+'&name='+CD.g_account.value+'&pass='+CD.g_password.value+'&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
      return VC.icSearch(url);
    });
  },
  // 电视首页“点播”使用旧 com.vod 目录；它的拼音索引与“环球剧场”不同。
  vodSearchOld: function (keywords) {
    return javaNetwork('metadata', () => {
      const CD=Java.use('com.vod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
      const url=CD.VODSEARCH_URL.value+'?name='+CD.g_account.value+'&pass='+CD.g_password.value+
        '&androidid='+CD.g_mac.value+'&lang=cn&ver=408&keywords='+keywords+'&im=pinyin';
      return VC.icSearch(url);
    });
  },
  vodGetOld: function (path) {
    return javaNetwork('metadata', () => {
      const CD=Java.use('com.vod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
      const url=CD.VODBASE_URL.value+path+'?name='+CD.g_account.value+'&pass='+CD.g_password.value+
        '&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
      return VC.icStaticDecode(url);
    });
  },
  vodUrls: function () {
    return new Promise((resolve, reject) => Java.perform(function () {
      try { const CD=Java.use('com.newvod.coredata.CoreData');
        const g=f=>{try{const v=CD[f].value;return v==null?null:''+v;}catch(e){return null;}};
        resolve({ VODROOT_URL:g('VODROOT_URL'), VODBASE_URL:g('VODBASE_URL'), VODM3U8_URL:g('VODM3U8_URL'), VODSEARCH_URL:g('VODSEARCH_URL'), VODPDATA_URL:g('VODPDATA_URL'), account:g('g_account'), mac:g('g_mac') });
      } catch(e){ reject(''+(e.stack||e)); }
    }));
  },
  vodUrlsOld: function () {
    return new Promise((resolve, reject) => Java.perform(function () {
      try { const CD=Java.use('com.vod.coredata.CoreData');
        const g=f=>{try{const v=CD[f].value;return v==null?null:''+v;}catch(e){return null;}};
        resolve({ VODROOT_URL:g('VODROOT_URL'), VODBASE_URL:g('VODBASE_URL') });
      } catch(e){ reject(''+(e.stack||e)); }
    }));
  },
  // 用应用账号调 icStaticDecode 取任意 VOD 数据(pathUrl 不含 query)
  vodGet: function (pathUrl) {
    return javaNetwork('metadata', () => {
      const CD=Java.use('com.newvod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
      const url = pathUrl + '?name='+CD.g_account.value+'&pass='+CD.g_password.value+'&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
      return VC.icStaticDecode(url);
    });
  },
  dump: function () {
    return new Promise((resolve, reject) => Java.perform(function () {
      try {
        const CD = Java.use('com.wys.iptvgo.coredata.ChannelData');
        const Channel = Java.use('com.wys.iptvgo.coredata.Channel');
        resolve({ live: dumpList(CD.listChannel.value, Channel),
                  backplay: dumpList(CD.listBackplayChannel.value, Channel),
                  expiredTime: (CD.expiredTime.value||'')+'' });
      } catch (e) { reject('' + (e.stack || e)); }
    }));
  },
  // 直播: startTime=0; 返回本地端口
  probeStream: function (port, maxMs) {
    return new Promise((resolve, reject) => Java.perform(function () {
      try {
        const URL = Java.use('java.net.URL');
        const conn = Java.cast(URL.$new('http://127.0.0.1:'+port+'/').openConnection(), Java.use('java.net.HttpURLConnection'));
        conn.setConnectTimeout(5000); conn.setReadTimeout(12000);
        const is = conn.getInputStream();
        const buf = Java.array('byte', Array(65536).fill(0));
        let total=0, t0=Date.now(), eof=false;
        while (Date.now()-t0 < maxMs){ const n=is.read(buf); if(n<0){ eof=true; break; } total+=n; }
        try{is.close();}catch(e){}
        resolve({ bytes: total, ms: Date.now()-t0, eof: eof });
      } catch(e){ reject(''+(e.stack||e)); }
    }));
  },
  vodPlay: function (channelId, ip, port, percent, mode) {
    return ensurePlaybackCB('vod').then(cb => new Promise((resolve, reject) => Java.perform(function () {
      let step='start';
      try {
        step='stopPrev'; const VC=Java.use('dnet.VideoClient'); try{VC.playbackStop();}catch(e){} try{VC.vodStop();}catch(e){}
        const p=parseInt(port,10);
        step='vodStart'; const port_=VC.vodStart(channelId, ip, p, ip, p, ip, p, (percent|0), cb, mode===0?0:1);
        resolve({ port: port_, callback: 'activity' });
      } catch(e){ reject('at['+step+']: '+(e&&(e.stack||e.message||e)||'unknown')); }
    })));
  },
  play: function (chid, startTime) {
    return ensurePlaybackCB('live').then(cb => new Promise((resolve, reject) => Java.perform(function () {
      let step='start';
      try {
        step='stopPrev'; const VC=Java.use('dnet.VideoClient'); try{VC.playbackStop();}catch(e){} try{VC.vodStop();}catch(e){}
        step='playbackStart';
        const port = VC.playbackStart(chid, (startTime|0), 2147483647, cb, 0);
        resolve({ port: port, callback: 'activity' });
      } catch(e){ reject('at['+step+']: '+(e&&(e.stack||e.message||e)||'unknown')); }
    })));
  },
  // —— 登录相关(网页UI登录,全后台,用户不碰模拟器)——
  loginState: function () {
    return new Promise((resolve, reject) => Java.perform(function () {
      try {
        const CD = Java.use('com.newvod.coredata.CoreData');
        const ChD = Java.use('com.wys.iptvgo.coredata.ChannelData');
        const acct = CD.g_account.value || '';
        let ch = 0; try { ch = ChD.listChannel.value.size(); } catch(e){}
        resolve({ account: acct, activated: (acct.length>0 && ch>0), channels: ch });
      } catch(e){ reject('' + (e.stack||e)); }
    }));
  },
  // 温和重授权:复刻 LoginActivity 的挂表、播放选项及 HomeActivity 的设备授权顺序。
  // 为什么需要:普通冷启动(monkey拉起)后 activatedTime 一直是0,vodStart/playbackStart 直接返回
  // -1000(hint_master_or_option_error=没挂表/没授权)。原生靠首页UI流程跑这两步;我们无头绕过了UI,
  // 所以必须自己调。这比 am force-stop 整个App温和得多(force-stop+快速重启本身就是崩溃源)。
  reAuth: function () {
    return new Promise((resolve) => Java.perform(function () {
      const out = { chart: null, option: null, auth: null, master: null, err: null };
      try {
        const VC = Java.use('dnet.VideoClient');
        const CD = Java.use('com.wys.iptvgo.coredata.CoreData');
        const master = '' + CD.master.value; out.master = master;
        try { out.chart = VC.icChart(master); } catch (e) { out.err = 'chart:' + (e.message || e); }
        // LoginActivity 在挂表后还会加载播放选项；缺这步时 vodStart 可返回 -1000。
        try {
          const optionUrl = CD.FAKE_OPTION_URL.value;
          if (optionUrl) out.option = VC.icFakeOption(optionUrl);
          else out.err = 'option URL 未就绪';
        } catch (e) { out.err = 'option:' + (e.message || e); }
        const c = master.indexOf(':');
        const ip = master.substring(0, c), port = parseInt(master.substring(c + 1), 10);
        const lang = '' + CD.LANGS.value[CD.langIndex.value];
        const url = CD.AUTH_URL.value + '?name=' + CD.g_account.value + '&pass=' + CD.g_password.value +
                    '&androidid=' + CD.g_mac.value + '&lang=' + lang + '&ver=408';
        const ctx = Java.use('android.app.ActivityThread').currentApplication();
        // 原生 HomeActivity 可能正在并发授权；保留它写入的成功标记，避免本次超时把原生结果清掉。
        const activated = ['com.wys.iptvgo.coredata.CoreData', 'com.newvod.coredata.CoreData',
          'com.vod.coredata.CoreData', 'com.mtv.coredata.CoreData', 'com.wys.iptvgo.coredata.coretv.CoreData']
          .map(name => Java.use(name));
        for (let i = 0; i < 2; i++) {
          try { out.auth = VC.icAuth(ctx.getAssets(), url, ip, port, ip, port, ip, port); } catch (e) { out.err = 'auth:' + (e.message || e); break; }
          if (out.auth === 0) {
            const now=Java.use('java.lang.System').currentTimeMillis();
            for (const c of activated) c.activatedTime.value = now;
            break;
          }
        }
      } catch (e) { out.err = '' + (e.message || e); }
      resolve(out);
    }));
  },
  // 保留诊断接口；直播、点播各自由 APK 注册的原生类承接。
  pollTell: function (reset) {
    const result = { mode: Object.values(playbackCallbacks).some(entry => entry.instance) ? 'activity' : 'none', ...callbackState };
    if (reset) { callbackState.last = 0; callbackState.ended = 0; callbackState.count = 0; }
    return result;
  },
  // 引擎真实就绪判据(原生:icChart挂表+icAuth授权成功后 activatedTime=毫秒时间戳;默认0/失败-1)。activatedTime>0 且频道已加载 才算引擎挂表+授权完成、可安全 vodStart。替代冷启动盲等12s——盲等常常还没授权就播,vodStart直接给死端口/-1000
  engineReady: function () {
    return new Promise((resolve) => Java.perform(function () {
      try {
        const CD = Java.use('com.wys.iptvgo.coredata.CoreData');
        const ChD = Java.use('com.wys.iptvgo.coredata.ChannelData');
        let at = 0; try { at = parseInt(''+CD.activatedTime.value,10)||0; } catch(e){}
        let ch = 0; try { ch = ChD.listChannel.value.size(); } catch(e){}
        resolve({ activated: at>0, activatedTime: at, channels: ch });
      } catch(e){ resolve({ activated:false, activatedTime:0, channels:0, err:''+(e.message||e) }); }
    }));
  },
  readCreds: function () {
    return new Promise((resolve, reject) => Java.perform(function () {
      try { const CD = Java.use('com.newvod.coredata.CoreData');
        resolve({ account: CD.g_account.value||'', password: CD.g_password.value||'', mac: CD.g_mac.value||'' });
      } catch(e){ reject('' + (e.stack||e)); }
    }));
  },
  saveCreds: function (account, password) {
    return new Promise((resolve, reject) => Java.perform(function () {
      try {
        const ctx = Java.use('android.app.ActivityThread').currentApplication();
        const SU = Java.use('com.common.util.SettingUtil');
        const DH = Java.use('com.common.util.DeviceHelper');
        const mac = '' + DH.getAndroidId(ctx);
        const setS = SU.setConfig.overload('android.content.Context','java.lang.String','java.lang.String');
        const setB = SU.setConfig.overload('android.content.Context','java.lang.String','boolean');
        setS.call(SU, ctx, 'name', '' + account);
        setS.call(SU, ctx, 'pass', '' + password);
        setS.call(SU, ctx, 'mac', mac);
        setB.call(SU, ctx, 'autologin', true);
        resolve({ ok: true, mac: mac });
      } catch(e){ reject('' + (e.stack||e)); }
    }));
  },
  stop: function () {
    return new Promise((resolve) => Java.perform(function () {
      const VC=Java.use('dnet.VideoClient'); try{VC.playbackStop();}catch(e){} try{VC.vodStop();}catch(e){} resolve(true);
    }));
  }
};
