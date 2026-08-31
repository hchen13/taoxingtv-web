import Java from 'frida-java-bridge';

// 持久单例回调:attach 后建一次、全局引用永不 GC,所有 play/vodPlay 复用。
// (Frida 坑:每次 $new 的注册类实例若被 JS 侧 GC,原生 P2P 线程之后回调它 -> native SIGSEGV 崩溃。
//  这正是本项目 App "每隔几分钟崩一次(电视上不崩)"的根因。)
// 回调实例:优先用预编译的**真实 DEX 类** com.txtv.NativeCB(/data/local/tmp/txtvcb.dex)。
// 为什么:Java.registerClass 造的类会(a)污染 ART DexCache -> FATAL IncompatibleClassChangeError,
// (b)让原生P2P线程回调时走 Frida 匿名内存 -> SIGSEGV(CallVoidMethodV)。两种崩溃实测都由它引起
// (电视上无 Frida 故从不崩)。真实 DEX 类是普通 ART 类,回调走标准 JNI,且它只写静态字段、
// 不从原生线程调 send() 回 JS,彻底移除崩溃路径。tell 码由 pollTell() 轮询读取。
// 回调实现类的 DEX(预编译的真实 Java 类 com.txtv.NativeCB,内嵌base64,约900字节)。
// 为什么不用 Java.registerClass:它造的类方法体是跳回 Frida JS 运行时的原生跳板,
// 原生P2P线程回调它时崩溃(SIGSEGV: art::JNI::CallVoidMethodV -> <anonymous> Frida内存),
// 且会污染 ART DexCache 引发 FATAL IncompatibleClassChangeError。实测这两类崩溃就是
// "App每隔几分钟崩"的根因(电视上无Frida故从不崩,用户已验证同内容在电视可完整播放)。
// NativeCB 是普通 ART 类、纯 Java 字节码,回调走标准 JNI,零 Frida 参与;它只写静态字段,
// 不从原生线程回调JS(那也是崩溃路径),tell 码由 pollTell() 轮询读取。
const CB_DEX_B64 = 'ZGV4CjAzNQAokF7Yl7n+65r8YdNy7FuQ7GOXjYC2FmGcAwAAcAAAAHhWNBIAAAAAAAAAAPwCAAAOAAAAcAAAAAUAAACoAAAAAgAAALwAAAADAAAA1AAAAAQAAADsAAAAAQAAAAwBAABwAgAALAEAALIBAAC8AQAAxAEAAMcBAADcAQAA8QEAAAUCAAAUAgAAFwIAABsCAAAiAgAALQIAADMCAABAAgAAAgAAAAMAAAAEAAAABQAAAAcAAAAHAAAABAAAAAAAAAAIAAAABAAAAKwBAAABAAAACQAAAAEAAAAKAAAAAQAAAAsAAAABAAAAAAAAAAEAAAABAAAAAQABAAwAAAADAAAAAQAAAAEAAAABAAAAAwAAAKQBAAAGAAAAAAAAAN8CAAAAAAAAAQAAAAAAAACQAQAACAAAABIAZwACAGcAAQBnAAAADgABAAEAAQAAAJYBAAAEAAAAcBADAAAADgAEAAIAAAAAAJoBAAAOAAAAZwMCAGAAAAASEbAQZwAAABIgMwMEAGcBAQAOAAQADjwtAAMADgAIAQAOh1oAAAAAAQAAAAIAAAABAAAAAAAIPGNsaW5pdD4ABjxpbml0PgABSQATTGNvbS90eHR2L05hdGl2ZUNCOwATTGRuZXQvSVRlbGxNZXNzYWdlOwASTGphdmEvbGFuZy9PYmplY3Q7AA1OYXRpdmVDQi5qYXZhAAFWAAJWSQAFY291bnQACWVuZGVkRmxhZwAEbGFzdAALdGVsbE1lc3NhZ2UAnAF+fkQ4eyJiYWNrZW5kIjoiZGV4IiwiY29tcGlsYXRpb24tbW9kZSI6ImRlYnVnIiwiaGFzLWNoZWNrc3VtcyI6ZmFsc2UsIm1pbi1hcGkiOjIxLCJzaGEtMSI6ImZhY2VkZjQxYmJkMjhiNTYzZDFlOWUwOWM1ZjcyZDdjNWNhNTk4ZDUiLCJ2ZXJzaW9uIjoiOC4yLjItZGV2In0AAwACAQBJAUkBSQCIgASsAgGBgATMAgIB5AIAAAANAAAAAAAAAAEAAAAAAAAAAQAAAA4AAABwAAAAAgAAAAUAAACoAAAAAwAAAAIAAAC8AAAABAAAAAMAAADUAAAABQAAAAQAAADsAAAABgAAAAEAAAAMAQAAASAAAAMAAAAsAQAAAyAAAAMAAACQAQAAARAAAAIAAACkAQAAAiAAAA4AAACyAQAAACAAAAEAAADfAgAAABAAAAEAAAD8AgAA';
let CB_INST = null, CB_NATIVE = null, CB_LOADER = null, CB_ACT = null, CB_MODE = 'none', CB_FAIL = '';
function ensureCB() {
  if (CB_ACT) return CB_ACT;          // 优先:App自己的Activity实例(方法齐全)
  if (CB_INST) return CB_INST;
  try {
    const B64 = Java.use('android.util.Base64');
    const BB = Java.use('java.nio.ByteBuffer');
    const IMDCL = Java.use('dalvik.system.InMemoryDexClassLoader');   // 内存加载,不落盘=不受SELinux/权限限制
    const bytes = B64.decode(CB_DEX_B64, 0);
    CB_LOADER = IMDCL.$new(BB.wrap(bytes), Java.use('android.app.ActivityThread').currentApplication().getClassLoader());   // 全局保存:loader被回收会导致类卸载->原生持有的methodID失效
    const f = Java.ClassFactory.get(CB_LOADER);    // 必须用指向该loader的factory:Java.use默认只查App的loader,找不到我们内存加载的类
    CB_NATIVE = f.use('com.txtv.NativeCB');
    // Java.retain = 建立**全局强引用(JNI global ref)**。原生 vodStart 会把这个回调对象存起来,
    // 之后由P2P线程长期回调;若只是局部引用,调用返回后引用失效 -> 原生再回调即
    // SIGSEGV(CallVoidMethodV, fault addr 0x0 空指针)。这正是"播几分钟后崩"的机制。
    CB_INST = Java.retain(Java.cast(CB_NATIVE.$new(), Java.use('dnet.ITellMessage')));
    CB_MODE = 'dex'; return CB_INST;
  } catch (e) { CB_FAIL = '' + (e.message || e); }
  const ITell = Java.use('dnet.ITellMessage');   // 退路:仍用注册类(有崩溃风险)
  const C = Java.registerClass({ name: 'com.txtv.Callback', implements: [ITell],
    methods: { tellMessage: function (i) { if (i === 2 || i === 4 || (i >= 100 && i <= 103)) send({ tell: i }); } } });
  CB_INST = Java.retain(C.$new()); CB_MODE = 'registerClass(dex失败:' + CB_FAIL + ')';
  return CB_INST;
}
// 在**主线程**预建 App 自己的 VodPlayActivity 实例作为回调(Activity构造需要Looper,只能在主线程)。
// 动机:原生可能在回调对象上查找 tellMessage 以外的方法(GetMethodID);极简类没有->返回NULL->
// 带NULL调用即 SIGSEGV(fault addr 0x0)。真机上原生收到的正是 VodPlayActivity,方法齐全。
// 预建成功则 ensureCB 优先返回它;失败则回落到内存DEX类。
try {
  Java.perform(function () {
    Java.scheduleOnMainThread(function () {
      try {
        const A = Java.use('com.newvod.activity.VodPlayActivity');
        CB_ACT = Java.retain(Java.cast(A.$new(), Java.use('dnet.ITellMessage')));
        CB_MODE = 'activity';
      } catch (e) { CB_FAIL += 'act:' + (e.message || e) + ' | '; }
    });
  });
} catch (e) { CB_FAIL += 'actsched:' + (e.message || e) + ' | '; }

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
  // 温和重授权:复刻原生 HomeActivity.doAuth() 的 icChart(挂表) -> icAuth(设备授权)。
  // 为什么需要:普通冷启动(monkey拉起)后 activatedTime 一直是0,vodStart/playbackStart 直接返回
  // -1000(hint_master_or_option_error=没挂表/没授权)。原生靠首页UI流程跑这两步;我们无头绕过了UI,
  // 所以必须自己调。这比 am force-stop 整个App温和得多(force-stop+快速重启本身就是崩溃源)。
  reAuth: function () {
    return new Promise((resolve) => Java.perform(function () {
      const out = { chart: null, auth: null, master: null, err: null };
      try {
        const VC = Java.use('dnet.VideoClient');
        const CD = Java.use('com.wys.iptvgo.coredata.CoreData');
        const master = '' + CD.master.value; out.master = master;
        try { out.chart = VC.icChart(master); } catch (e) { out.err = 'chart:' + (e.message || e); }
        const c = master.indexOf(':');
        const ip = master.substring(0, c), port = parseInt(master.substring(c + 1), 10);
        const lang = '' + CD.LANGS.value[CD.langIndex.value];
        const url = CD.AUTH_URL.value + '?name=' + CD.g_account.value + '&pass=' + CD.g_password.value +
                    '&androidid=' + CD.g_mac.value + '&lang=' + lang + '&ver=408';
        const ctx = Java.use('android.app.ActivityThread').currentApplication();
        CD.activatedTime.value = 0;
        for (let i = 0; i < 2; i++) {
          try { out.auth = VC.icAuth(ctx.getAssets(), url, ip, port, ip, port, ip, port); } catch (e) { out.err = 'auth:' + (e.message || e); break; }
          if (out.auth === 0) { CD.activatedTime.value = Java.use('java.lang.System').currentTimeMillis(); break; }
        }
      } catch (e) { out.err = '' + (e.message || e); }
      resolve(out);
    }));
  },
  // 轮询原生回调状态(替代从原生线程 send() 回JS:那条路径正是SIGSEGV来源)。reset=true 时清零,供每次播放开始前重置
  pollTell: function (reset) {
    return new Promise((resolve) => Java.perform(function () {
      try {
        if (!CB_NATIVE) return resolve({ mode: CB_MODE, fail: CB_FAIL, last: 0, ended: 0, count: 0 });
        const r = { mode: CB_MODE, fail: CB_FAIL, last: CB_NATIVE.last.value, ended: CB_NATIVE.endedFlag.value, count: CB_NATIVE.count.value };
        if (reset) { CB_NATIVE.last.value = 0; CB_NATIVE.endedFlag.value = 0; CB_NATIVE.count.value = 0; }
        resolve(r);
      } catch (e) { resolve({ mode: CB_MODE, err: '' + (e.message || e) }); }
    }));
  },
  // 引擎真实就绪判据(原生:icChart挂表+icAuth授权成功后 activatedTime=毫秒时间戳;默认0/失败-1)。activatedTime>0 且频道已加载 才算引擎挂表+授权完成、可安全 vodStart。替代冷启动盲等12s——盲等常常还没授权就播,vodStart直接给死端口/-1000
  engineReady: function () {
    return new Promise((resolve) => Java.perform(function () {
      try {
        const CD = Java.use('com.newvod.coredata.CoreData');
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
