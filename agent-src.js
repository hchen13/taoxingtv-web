import Java from 'frida-java-bridge';

// 持久单例回调:attach 后建一次、全局引用永不 GC,所有 play/vodPlay 复用。
// (Frida 坑:每次 $new 的注册类实例若被 JS 侧 GC,原生 P2P 线程之后回调它 -> native SIGSEGV 崩溃。
//  这正是本项目 App "每隔几分钟崩一次(电视上不崩)"的根因。)
let CB_CLASS = null, CB_INST = null;
function ensureCB() {
  if (CB_INST) return CB_INST;
  const ITell = Java.use('dnet.ITellMessage');
  CB_CLASS = Java.registerClass({ name: 'com.txtv.Callback', implements: [ITell],
    methods: { tellMessage: function (i) { if (i === 2 || i === 4 || (i >= 100 && i <= 103)) send({ tell: i }); } } });
  CB_INST = CB_CLASS.$new();
  return CB_INST;
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
  dlPoster: function (pic, devPath) {
    return new Promise((resolve, reject) => Java.perform(function () {
      try {
        const CD=Java.use('com.newvod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
        const url = CD.VODBASE_URL.value + pic + '?name='+CD.g_account.value+'&pass='+CD.g_password.value+'&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
        resolve({ ret: VC.icBigFile(url, devPath, null, 0) });
      } catch(e){ reject(''+(e.stack||e)); }
    }));
  },
  vodSearch: function (db, keywords, type, scope) {
    return new Promise((resolve, reject) => Java.perform(function () {
      try {
        const CD=Java.use('com.newvod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
        const url = CD.VODSEARCH_URL.value + '?db='+db+'&keywords='+keywords+'&type='+(type||'all')+'&scope='+(scope||0)+'&name='+CD.g_account.value+'&pass='+CD.g_password.value+'&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
        resolve(VC.icSearch(url));
      } catch(e){ reject(''+(e.stack||e)); }
    }));
  },
  vodUrls: function () {
    return new Promise((resolve, reject) => Java.perform(function () {
      try { const CD=Java.use('com.newvod.coredata.CoreData');
        const g=f=>{try{const v=CD[f].value;return v==null?null:''+v;}catch(e){return null;}};
        resolve({ VODROOT_URL:g('VODROOT_URL'), VODBASE_URL:g('VODBASE_URL'), VODM3U8_URL:g('VODM3U8_URL'), VODSEARCH_URL:g('VODSEARCH_URL'), VODPDATA_URL:g('VODPDATA_URL'), account:g('g_account'), mac:g('g_mac') });
      } catch(e){ reject(''+(e.stack||e)); }
    }));
  },
  // 用应用账号调 icStaticDecode 取任意 VOD 数据(pathUrl 不含 query)
  vodGet: function (pathUrl) {
    return new Promise((resolve, reject) => Java.perform(function () {
      try {
        const CD=Java.use('com.newvod.coredata.CoreData'); const VC=Java.use('dnet.VideoClient');
        const url = pathUrl + '?name='+CD.g_account.value+'&pass='+CD.g_password.value+'&androidid='+CD.g_mac.value+'&lang=cn&ver=408';
        resolve(VC.icStaticDecode(url));
      } catch(e){ reject(''+(e.stack||e)); }
    }));
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
  vodPlay: function (channelId, ip, port, percent) {
    return new Promise((resolve, reject) => Java.perform(function () {
      let step='start';
      try {
        step='stopPrev'; const VC=Java.use('dnet.VideoClient'); try{VC.playbackStop();}catch(e){} try{VC.vodStop();}catch(e){}
        step='cb'; const cb=ensureCB(); const p=parseInt(port,10);   // 复用持久单例,不再每次 $new
        step='vodStart'; const port_=VC.vodStart(channelId, ip, p, ip, p, ip, p, (percent|0), cb, 1);
        resolve({ port: port_ });
      } catch(e){ reject('at['+step+']: '+(e&&(e.stack||e.message||e)||'unknown')); }
    }));
  },
  play: function (chid, startTime) {
    return new Promise((resolve, reject) => Java.perform(function () {
      let step='start';
      try {
        step='stopPrev'; try { Java.use('dnet.VideoClient').playbackStop(); } catch(e){}
        step='cb'; const cb = ensureCB();   // 复用持久单例,不再每次 $new
        step='playbackStart';
        const port = Java.use('dnet.VideoClient').playbackStart(chid, (startTime|0), 2147483647, cb, 0);
        resolve({ port: port });
      } catch(e){ reject('at['+step+']: '+(e&&(e.stack||e.message||e)||'unknown')); }
    }));
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
