# 📺 淘星TV · 浏览器版

把小米电视上的「淘星TV」IPTV/点播 APK 跑成一个**自定义网页播放器**——原生 App 在后台无头模拟器里按需运行,你只在浏览器里操作:更好的界面、更顺的播放、中文搜索、倍速、人声增强……局域网内任何设备(电脑 / 手机 / 平板)打开网页即可看。

> 这是给**自己已购买的服务**做的自用客户端。**本项目不含、也不分发任何 APK**——请使用你自己从服务商处获得的 APK。

![界面截图](docs/screenshot.png)

## ✨ 主要特性

- **🔊 人声增强**：对白小、爆炸/音效大的片子,一键把人声拉清晰(Web Audio 动态压缩,默认开启,藏在「⋯ 更多」里)。
- **🔎 中文搜索**：直接搜中文片名(不用拼音首字母),前缀匹配优先。
- **⏩ 倍速播放**:0.75 / 1 / 1.25 / 1.5 / 2×。
- **🌊 深缓冲丝滑**:模仿原生 mpv 的深读缓冲——服务端 2× 读 + 前端上报缓冲、到 ~20 秒背压节流,缓冲稳定在 16-22 秒(有界不撑爆内存、抖动自动回填),P2P 抖动几乎无感,和电视一样顺。
- **🔐 网页登录(全后台)**:首次在网页输账号密码即可,凭据本地持久化、登出后自动登录——**全程不碰模拟器**。
- **📺 直播 + 点播**:355+ 直播频道(带台标)、电影/剧集/综艺/动漫等点播(带海报),点播支持选集、上/下集、片尾自动下一集。
- **🎬 播放体验**:进度条三色(已播/已缓冲/未缓冲)、单击暂停、双击全屏、空格/方向键(±15秒 seek、音量)、可收起侧栏让视频占满整页、刷新停留在当前进度、最近播放列表。
- **⚡ 按需 + 省资源**:打开网页才唤醒模拟器(约几秒),不看时空闲自动释放内存;常驻的只有一个 ~40MB 的 Node 守护。

## 🧩 工作原理

```
浏览器 (网页UI, mpegts.js)
   │  HTTP / MPEG-TS
   ▼
Node 服务 (server.js)  ── Frida 注入 ──▶  Android 模拟器里的淘星TV APK
   │  ffmpeg 容错解码+硬件重编码                    (VideoClient P2P 取流)
   ▼
localhost:8090 (或 http://txtv)
```

- APK 是 ARM 的,用 **ARM64 Android TV 模拟器**原生跑(Apple Silicon 上不用转译)。
- 用 **Frida** 调用 APP 内部的 `VideoClient.playbackStart / vodStart`(P2P 取流,返回本地 MPEG-TS 端口)、`icSearch / icStaticDecode`(点播目录/搜索)等。
- **ffmpeg** 容错解码 + VideoToolbox 硬件重编码成浏览器能稳定解码的 H.264,`mpegts.js` 播放。
- 登录 = 用 Frida 把账号密码写进 APP 的 SharedPreferences,重启 APP 走它自带的启动自动登录+激活流程。

## 🛠 环境要求

- **macOS(Apple Silicon 推荐)**、Node 18+、`ffmpeg`(`brew install ffmpeg`)
- **Android SDK + 模拟器**,一个 **ARM64 Android TV 系统镜像**(如 `system-images;android-33;android-tv;arm64-v8a`)
- **已 root 的模拟器**(rootAVD + Magisk)+ 对应架构的 **frida-server**(arm64)
- **你自己的淘星TV APK**(`com.wys.iptvgo`)+ 一个有效账号

> 项目当前按作者的 macOS/Homebrew 环境编写(路径见 `start.sh` 里的环境变量,可覆盖)。其他环境需自行调整。

## 🚀 快速开始

```bash
# 1. 装依赖
npm install

# 2. 下载对应架构的 frida-server(arm64)放到项目根目录并命名为 frida-server
#    https://github.com/frida/frida/releases  (版本需与 npm 的 frida 主版本一致)

# 3. 准备模拟器:创建 AVD、安装你的 APK、root、推送并启动 frida-server
#    (AVD 名默认 TaoxingTV,可用环境变量 AVD 覆盖)

# 4. 启动服务(常驻守护,模拟器按需起/闲时关)
./start.sh              # 或 node server.js
```

浏览器打开 **http://localhost:8090**。首次会让你输账号密码登录(之后自动登录)。

局域网其他设备用这台机器的 IP:8090 访问即可。可选:用 nginx 反代到 80 端口做成 `http://<主机名>` 免端口访问(**流媒体反代务必 `proxy_buffering off`**)。

## ⚠️ 声明

- 仅供**已购买服务的自用**,请遵守服务商条款与当地法律,尊重版权。
- **不分发 APK / 账号 / 任何内容**;凭据只存在你本地(`creds.json`,已在 `.gitignore`,永不进仓库)。
- 逆向仅用于互操作性(让自己买的服务在更好的界面上看)。

---
🤖 在 [Claude Code](https://claude.com/claude-code) 协助下开发
