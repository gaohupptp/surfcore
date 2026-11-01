# SnowLuma 连接诊断误报成「令牌不对」+ 提示方向写反

## 现象

- 用户看到什么（原话尽量保留）：
  - 概览页红字：`SnowLuma 连接异常（onebot-rejected）：OneBot 端口在监听但桥接连不上：多半是 accessToken 不匹配（对齐 config.json 的 snowluma.accessToken），或 httpUrl 指到了 WebSocket 端口`。
  - 用户原话：「它说 onebot-rejected，我看不懂是在说哪个」；同时他实际能正常收发 QQ 消息。
  - 启动自检弹窗（`index.js:1861`）也在同一窗口期抛同一条，插件日志 `C:\Users\gaohu\.dsh\surfcore\plugin.log` 里留下 `启动检查未通过：… snow=false snowState=onebot-rejected account=true scheduler=false`。
- 复现步骤：
  1. 桥接进程（`src/bridge.js`）因任何原因还没连上（冷启动、SnowLuma 晚于桥接启动、桥接没起、consoleToken 不对）。
  2. 打开 SurfCore 概览页，或在 DSH 启动后 3 分钟窗口内看自检弹窗。
  3. 只要 3000 或 3001 端口有监听，就固定显示上面那条 onebot-rejected。
- 影响面：不丢数据、不改配置、不花钱；但**把用户往错方向带**（去翻 accessToken），且在真凶是「桥接没起」时也会显示，属于会浪费一整晚的错误提示。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 0.2.2-alpha.2（profile `web`，GUI `http://127.0.0.1:7192`） |
| SurfCore 版本 | 0.7.20（HEAD `ccab715`，git 工作区） |
| 安装方式 | git |
| 其它相关版本 | SnowLuma `@snowluma/runtime` 2.2.1，OneBot **v11**（HTTP 3000 / WS 3001 / WebUI 5099，全部绑 127.0.0.1） |

## 根因

- 代码位置（文件:行）：
  - `plugins/surfcore/lib/index.js:1689-1704`（原 `diagnoseSnowLuma`）
  - 调用点 `plugins/surfcore/lib/index.js:681`（概览页，用 `bridge?.snowluma ?? {}`）、`:1294`（安装检查）、`:1861`（启动自检）
  - 前端显示 `plugins/surfcore/lib/client.js:1843-1845`（`bridge.running && state !== 'ok'` 时红字）
- 问题链条（为什么会导致上面的现象）：
  1. 原判据只有一句话：`connected === true` 才 ok；否则只要 3000/3001 任一端口在监听，就返回 `onebot-rejected` + 固定 hint。
  2. 于是「桥接进程根本没起」「桥接在跑但 consoleToken 不对」这两种跟 accessToken 毫无关系的情况，都被说成「多半是 accessToken 不匹配」。
  3. `index.js:681` 在 `bridgeStatus()` 整体失败时传的是空对象 `bridge?.snowluma ?? {}`，判定函数拿不到 `running`/`ok`，仍然落进 onebot-rejected —— 提示与事实完全脱节。
  4. hint 里的方向也写反了：真正的「端口搞混」是 **wsUrl 指到了 HTTP 口**（HTTP 服务对 WS 握手回 200 而不是 101，桥接日志报 `Received network error or non-101 status code.`），原文却写成「httpUrl 指到了 WebSocket 端口」。
- 为什么之前没发现（测试盲区）：
  - `onebot-rejected` 全仓库只有这一个产生点，但**没有任何测试断言过这些 state**（`scripts/` 下搜不到）。
  - 只在「token 真过期」那一次现场验证过（`state\bridge.log.1` 10-31 03:55:33 自愈成功），恰好掩盖了另外几条分支。

## 完整逻辑（给用户看的那一遍）

- **链路**：
  - 谁在说话：DSH（宿主）→ SurfCore 插件（`plugins/surfcore/lib/index.js`）→ 桥接进程（`src/bridge.js`，PID 常驻）→ SnowLuma（OneBot 11 实现）。
  - 两扇门：`httpUrl = http://127.0.0.1:3000`（HTTP 接口，`POST /get_version_info`、`/get_status`），`wsUrl = ws://127.0.0.1:3001`（WebSocket，事件与消息都走这里）。
  - 诊断函数只做一件事：拿三样东西——桥接自己的状态快照、两扇门的端口通不通、WebUI 开没开——拼出一句「现在到底卡在哪」。
- **机制**：这是**契约问题**，不是某行写错。原实现把「连不上」当成单一原因（令牌），而实际至少有 7 种互斥原因。修法就是把判定拆成状态机，每个状态一条专属提示。
- **爆炸半径**：进程数 1（插件进程内纯函数）× 读者 3（概览页、安装检查、启动自检）× 静默=3 → 9 分。不碰用户数据、不碰密钥、不花钱。改的是**提示**，不改连接主流程，所以连得上的人行为不变。
- **取舍**：
  - 路线 A：只在原函数里补几句话（改 hint 文案 + 加几个 if）。成本最低，但判定逻辑仍散在 `index.js`（3077 行的巨型文件）里，没法单测。
  - 路线 B（选它）：把判定抽成无 IO 的纯函数 `lib/snowluma-diagnose.js`，`index.js` 只负责收集事实（bridge 快照 + 三次端口探测 + WebUI 端口）后调用它。
  - 选 B 的理由：纯函数可以直接喂 8 组假数据跑断言，不用起进程、不用真实端口；这正是这个 bug 之前漏掉的东西。成本是多一个文件 + 一个测试脚本。
  - 回滚：删掉 `lib/snowluma-diagnose.js` 与测试脚本，`git checkout -- plugins/surfcore/lib/index.js plugins/surfcore/package.json` 即回到 0.7.20 行为。
- **生效与重启**：判定函数在插件进程内被调用，改完要**重启 DSH**（插件重新加载）才生效；桥接进程不用动。

## 修法

- 改了什么（关键片段）：
  1. **新增** `plugins/surfcore/lib/snowluma-diagnose.js`（纯函数，无 IO、无 import 副作用）：
     - 导出 `portOfUrl()`、`SNOW_DIAG_STATES`、`decideSnowLumaDiagnosis({ bridge, snow, ports, urls, webuiUrl })`。
     - 判定顺序（先因后果，越靠前越基础）：
       `ok` → `bridge-down`（桥接没起）→ `bridge-unauthorized`（桥接在跑但 consoleToken 不对）→ `config-swapped`（wsUrl 与 httpUrl 同端口）→ `onebot-rejected`（WS 口在听但握不上）→ `ws-port-closed`（HTTP 通、WS 口没开）→ `needs-login`（只有 WebUI）→ `not-running`（都不通）。
     - 每个状态码 `code` 以 `snow.` 开头（`snow.bridge-down`、`snow.onebot-rejected` …），带 `error`（一行人话）与 `hint`（下一步动作），并附 `evidence`（`bridgeRunning/bridgeOk/bridgeHttpStatus/connected/httpPort/wsPort/httpOpen/wsOpen/webuiOpen`）方便贴日志。
     - 文案修正：`onebot-rejected` 的 hint 改成「回 401 = accessToken 不对（重启桥接会从 SnowLuma 的 `onebot_<QQ号>.json` 自动对齐）；回 200 = **wsUrl** 指到了 HTTP 口」+ 带上 `goodError` 前 80 字 + 「具体原因看 `surfcore\state\bridge.log` 里 non-101 / 1006 那几行」。`bridge-down` 里明确写「跟 accessToken 无关」。
  2. `plugins/surfcore/lib/index.js`：`import { decideSnowLumaDiagnosis, portOfUrl } from './snowluma-diagnose.js'`（line 69-70）；`diagnoseSnowLuma(bridge = {})` 改成收整个 bridge 快照，已连接就快返回，否则读 `readQqConfig().config.snowluma` 的 `httpUrl/wsUrl` 端口（回退 3000/3001）、`Promise.all` 探测三处端口，再交给纯函数。
  3. 三个调用点改成传整个 bridge：`:681` 传 `bridge ?? {}`；`:1294` 先 `bridgeStatus().catch(() => ({}))`；`:1861` 传 `bridge`。
  4. **新增** `plugins/surfcore/scripts/test-snowluma-diagnose.mjs`（11 组断言，见下）。
  5. `plugins/surfcore/package.json` 的 `test` 链在 `test-snowluma-install.mjs` 之后插入该脚本。
- 为什么选这个方案：纯函数 + 端口探测是唯一能同时满足「8 条分支各自可测」和「不改连接主流程」的做法。更简单的方案（只改文案）解决不了「桥接没起被说成令牌不对」这个真正的误报。
- 回滚方式：见上（删两个新文件 + `git checkout` 两个被改文件），无需动配置、无需清状态。

## 验证

- 自动化：
  - `node --check lib/index.js`、`node --check lib/snowluma-diagnose.js` → 无输出（语法 OK）。
  - `node scripts/test-snowluma-diagnose.mjs` → `✅ SnowLuma 连接诊断通过（8 条失败分支各有独立 code/hint）`。
  - `cd plugins/surfcore && npm test` → 全链路绿（含 host smoke `SMOKE OK`、`/dsh-surfcore/api/overview 200 true`、client contract、token 服务 39 项、platform-start、pet 与 updates 系列）。
  - 根目录 `npm run test:audit` → **87/89**，两个失败均为本次改动无关的既有问题：`test-agent-preset-patches.mjs`（`presets\qq-chat.patch.yml` 与源不一致，脚本自己提示跑 `node scripts/build-agent-preset-patches.mjs`）、`test-voice-pack-import.mjs`（本机音色引擎在运行，5 项均因「音色引擎仍在运行，不能覆盖」失败）。本次只改 4 个文件（`git status` 可查），未触碰 preset 与语音包。
  - 根目录 `npm run test:regressions` → `全部通过`（R1–R16 全 PASS）。
- 失败路径（用户看到什么 / 下一步 / 失败分支断言）：
  - 桥接没起 → 红字「桥接进程没在跑，跟 accessToken 无关」+ 下一步「先启动桥接」。
  - 令牌被拒 → 「桥接在跑但 consoleToken 不对」+ 下一步「用 state\bridge.token 里的令牌」。
  - 端口配反 → 「wsUrl 和 httpUrl 写成了同一个端口」。
  - WS 口没开 → 「HTTP 通、WebSocket 口没开」。
  - 断言钉住：8 条分支 code 互不重复、`code` 以 `snow.` 开头、`error` 非空、`hint` 长度 ≥12 且含冒号；专门断言「bridge-down 的 hint 不许出现 accessToken 不匹配」「onebot-rejected 的 hint 必须含 wsUrl 且不许出现旧文案 httpUrl 指到了 WebSocket」「跨进程日志指引必须含 bridge.log」。
- 手工/集成验证（贴关键输出）：
  - 实测当时的真实状态（修复前就在正常连）：`{"connected":true,"accountOnline":true,"good":true,"goodSource":"get_status","lastPacketAgoMs":2698,"lastPacketKind":"meta_event/heartbeat"}`。
  - 握手探测：`ws://127.0.0.1:3001` 不带令牌 → 401；带正确令牌 → Open；带错令牌 → 401；`ws://127.0.0.1:3000` → **200 而非 101**（这正是 `non-101 status code` 的来源，也印证 hint 方向写反）。
- 没验证到的部分（老实写）：
  - 重启 DSH 后真实界面上的红字/弹窗文案**未在本次会话内验证**（需要重启宿主，用户在跑活）；只验证了函数返回值与端口探测。
  - `portOpen()` 在极慢机器上的超时表现没压测。

## 遗留 / 后续

- 需要补的测试：把 `bridge-down`/`bridge-unauthorized` 两条分支用真实 `bridgeStatus()` 快照再钉一次（目前是手工构造的假快照）；`portOpen` 的超时与 IPv6 回退。
- 需要改的文档：已同步 `docs/PITFALLS.md #92`、`docs/HANDOFF.md` 新快照、`docs/RELEASE-QUEUE.md` 待发布批次。
- 押后未做：**token 单一来源**（现在 `config.json` 抄一份 + SnowLuma 的 `onebot_<QQ号>.json` 一份，运行时只读后者可少一处漂移）——需要在发布会话里评估，本轮不动连接主流程。
