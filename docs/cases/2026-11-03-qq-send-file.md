# 新增 QQ 文件发送工具（私聊 `qq_send_file` + 群 `qq_send_group_file`）

> 2026-11-03 · 编辑会话 · 功能新增（非 bug 修复），但踩坑过程与踩坑结论按 case 记录。

## 现象

- 用户需求（原话大意）：让模型能把本机文件直接发给 QQ 好友和 QQ 群，「一步到位」；同时必须满足 7 条约束——
  文件夹白名单、收发对象白名单（私聊/群分别校验）、合理上传超时、上传后自动发原生文件消息且**不重复发送**、
  两个工具**默认关闭**、不得绕过既有发送安全限制与审计、私聊与群聊**分别测试**。
- 改动前的状态：SurfCore 只有文本/表情/语音发送，**没有任何文件发送能力**；桥接里也**没有任何文件路由**
  （`grep file_id` / `type:"file"` / `sendC2cFile` 在 `src/bridge.js` 零命中）。
- 影响面：新增能力，不改既有行为；两个开关默认 `false`，不打开就不会出现在工具列表里。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 · DSH 0.2.2-alpha.2 |
| SurfCore 版本 | 0.8.6（未 bump / 未 tag / 未 push） |
| 安装方式 | 本地 git 工作区 `D:\dsh-fatfish-plugin\surfcore` |
| 其它 | SnowLuma（打包版 `index.mjs`，`127.0.0.1:3000`）、Web GUI `127.0.0.1:10886`、桥接 `127.0.0.1:3100` |

## 根因（这里指"为什么不能直接照抄语音那套"）

- **SnowLuma 的两个 action 自带发送，不需要二次补发**：
  - `upload_private_file`（`snowluma\index.mjs:10053-10096`）上传完自己 `ctx.sendPrivateMessage(..., [{type:'file', ...}])`。
  - `upload_group_file`（`:10022-10052`）只传 5 个参数 → `GroupFileApi.upload(..., publishFile = uploadFile)`（`:287784`）
    → 命中 `if (publishFile) await this.publish(groupId, fileId)`（`:287823-287827`），失败还会 `throw`。
  - 结论：调用方**再补发一次就是重复消息**。这直接决定了「一步到位」的实现方式。
- **直连 SnowLuma 会绕过桥接的全部闸门**：模式门禁、会话令牌、白名单、静默、限速、活动记录都在桥接里；
  MCP 直连 `:3000` 等于把文件发送变成无审计通道（与语音当年"直连被 prompt injection 利用"是同一类问题）。
- **两道 300 秒墙**：
  - 客户端 `fetch`（undici）自带 300s `headersTimeout` —— 上传大文件必然超时；仓库里
    `src/mcp-snowluma-safe.js:226-233` 的注释与 issue #24 已经踩过。
  - Node `http.Server` 的 `requestTimeout` 默认 300s，但它**只覆盖"接收请求"**，不覆盖"等待响应"，
    加它并不能解决长上传——方案 v2 里曾误加 `server.requestTimeout`，复审时已删除。
- **路径安全**：模型可控的 `filePath` 等于任意本机读 → 必须白名单目录 + `realpath` 复核（防 junction/symlink 逃逸）。

## 完整逻辑（给用户看的那一遍）

- **链路**：DSH 模型 → MCP 工具 `qq_send_file` / `qq_send_group_file`（`src/mcp-snowluma-safe.js`）
  → `POST /api/send/file`（`src/bridge.js`，新增端点）→ `onebotCallLong('upload_private_file'|'upload_group_file')`
  → SnowLuma（`node:http`，长超时）→ QQ 服务端 → 对方 QQ。
  成功路径落 `state/bridge.log` 的 `[send-file]` 行、`state/qq-activity.log` 的 `[send-file]` 行，并 `saveSocialV2State()`。
- **机制**：MCP 端用 `agentApiLongPoll`（`node:http`，自管计时器）绕开 undici 的 300s；
  桥接端用新增的 `onebotCallLong`（同样 `node:http`）绕开第二道墙。两侧超时**同公式**：
  `estSeconds = ceil(size / 512KiB)`，桥接取 `clamp(60, 280, est+20)` 秒，MCP 再 `+30s` 且上限 600s，
  保证桥接先报错、MCP 后放弃，错误信息才具体。
- **一次性发送**：一次 action 调用内含"上传 + 发文件消息"，桥接与 MCP 都**不再补发**，从结构上排除重复。
- **爆炸半径**：新增端点只被两个新工具调用；老端点零改动；失败时回滚 `sendTimes` 并发 `noteSendFailure`。
  不碰用户数据、不碰密钥；`allowedDirs` 默认为空 = 默认拒绝（fail-closed）。
- **取舍**：
  - A. MCP 直连 SnowLuma（实现最短，几十行）→ **否**：绕过全部闸门，违反用户"不得绕过"。
  - B. 桥接中转（选中）→ 多一个端点，但白名单/模式/令牌/限速/审计全部复用既有闸门，且两跳都能用 `node:http` 长连接。
  - C. 上传与发送拆成两次 MCP 工具 → 否：用户要"一步到位"，且拆开就存在"上传了没发出去"的中间态。
- **生效与重启**：桥接改的是运行中的守护进程（`start.bat` 的 `:loop node src/bridge.js`），
  必须重启桥接；MCP 工具由 DSH 以 stdio 拉起，必须重启 DSH（或新开会话）才会重新注册；
  SnowLuma **不用重启**（它本来就有这两个 action）。

## 修法

改动 6 个文件 + 新增 1 份文档（备份在 `~/.dsh/_quarantine/qq_send_file-20261103-070451/`）：

1. `src/bridge.js`（6 处）
   - 默认开关表：`sendFile: false`、`sendGroupFile: false`。
   - 新增 `cfg.socialV2.file = { allowedDirs: [], maxBytes: 100MiB, maxPathChars: 260, maxNameChars: 100, maxFolderChars: 64, ... }`。
   - 新增四个助手：`onebotCallLong`（`node:http` + 自管 `setTimeout` + `timeout: 0` + 4MB 响应上限）、
     `resolveSendableFile`（绝对路径/`file://` → `realpath` → 普通文件 → 非空 → 大小上限 → 白名单前缀判定）、
     `sanitizeSendFileName`、`sanitizeSendFolder`。
   - 新增 `POST /api/send/file`：闸门顺序 = 模式 → 暂停 → 目标非空 → reserved2 令牌 → `agentTokenOk`
     → `v2ToolEnabled(sendFile|sendGroupFile)` → 静默 → key 正则 → `modeAllowed`
     → 路径白名单 → `assertOutboundAuditOk` → 名字/文件夹净化 → 鱼群/Token 守卫 → 限速
     → `onebotCallLong` → 成功记账 / 失败回滚 + 502（带"可能已发出，先确认"的 hint）。
   - 配置保存守卫子对象列表加 `'file'`；`toolFlags` 与 `toolMap` 各加两项。
2. `src/mcp-snowluma-safe.js`（2 处）：`TOOL_CONFIG_FLAGS` 加两个映射；
   新增 `uploadTimeoutMsFor` / `fileSendErrorText` 与两个 `server.tool`（`qq_send_file`、`qq_send_group_file`）。
3. `config.json`：`tools.sendFile=true`、`tools.sendGroupFile=true`（测试期开启）；
   新增 `socialV2.file.allowedDirs = ["D:\\QQ文件发送区"]` 等。
4. `public/console.html`：高级设置里加两个开关勾选框。
5. `plugins/surfcore/lib/client.js`：`TOOL_LABELS` 加 `sendFile: "发文件"`、`sendGroupFile: "发群文件"`。
6. `scripts/test-voice.mjs:217`：原断言 `includes("'sendVoice']")` 因数组变长而失效，改为正则取 `toolFlags` 行后断言三项都在。
7. 新增 `docs/cases/2026-11-03-qq-send-file.md`（本文）。

- 为什么选这个方案：复用既有闸门 = 用户"不得绕过安全限制"的唯一自洽解法；`node:http` 是仓库已有的成熟范式
  （`agentApiLongPoll` 已经在用），不需要新依赖。
- 回滚方式：用备份目录五个文件覆盖回去 → 重启桥接 → 重启 DSH；`config.json` 删掉 `socialV2.file` 与两个 flag 即可回到原样。

## 验证

- 自动化：
  - `node --check src/bridge.js`、`node --check src/mcp-snowluma-safe.js`、`node --check plugins/surfcore/lib/client.js` → 全 0。
  - `node scripts/test-voice.mjs` → 83 通过 0 失败（修断言后）。
  - `npm run test:regressions` → 全绿。
  - `npm run test:mcp-servers` → snowluma **37 tools**，含 `qq_send_file` / `qq_send_group_file`。
  - `npm run test:audit` → 见下方"未验证/已知失败"，4 条失败均与本改动无关且事先存在。
- 手工/集成（真实发送，非模拟）：
  - 私聊：`POST /api/send/file {kind:'private',userId:'925868501',filePath:'D:\\QQ文件发送区\\测试文件-中文名.txt'}`
    → `200 {"ok":true,"file_id":"776cdde7…","name":"测试文件-中文名.txt","size":67}`（1145ms）。
  - 群聊：`{kind:'group',groupId:'748255607',filePath:'…\\群文件测试-中文名.txt'}` → `200 {"ok":true,"file_id":"/44843051…","size":43}`（878ms）。
  - 日志：`state/bridge.log` = `[send-file] … upload_private_file … 超时 60s` → `成功 file_id=…`；`state/qq-activity.log` 有两条 `[send-file]`。
- 失败路径（全部实测，均为可行动报错）：

| 用例 | HTTP | 用户看到 |
| --- | --- | --- |
| 相对路径 | 400 | `filePath 必须是绝对路径（或 file:// 绝对路径）` |
| `C:/Windows/win.ini` | 403 | `该文件不在允许发送的目录内（socialV2.file.allowedDirs），已拒绝` |
| 文件不存在 | 400 | `文件不存在或无法访问: 不存在.txt` |
| 目录 | 400 | `filePath 不是普通文件（目录/设备文件都不允许）` |
| 101MiB 稀疏文件 | 400 | `文件过大（105906176 字节 > 上限 104857600 字节）` |
| junction `逃逸\win.ini` | 403 | 同白名单拒绝（`realpath` 生效，逃不出去） |
| `name:"bad:name.txt"` | 400 | `name 含非法字符（不能有 / \ : * ? " < > \| 或控制字符）` |
| `name` 101 字符 | 400 | `name 过长（>100 字符）` |
| key 与目标不一致 | 403 | `agent token 无效` |
| `folder:"../x"` | 400 | `folder 必须以 / 开头（例如 /文档）` |
| 无 token | 403 | `reserved2 模式发送必须携带 agent token` |
| 坏 token | 403 | `未授权：智能体调用携带的会话令牌无效` |
| 0 字节文件 | 400 | `文件为空，拒绝发送` |
| `file:///C:/不存在/none.txt` | 400 | `文件不存在或无法访问: none.txt`（证明 `file://` 解析正常） |

- **没验证到的部分**：群文件在 QQ 客户端到底显示成"原生文件卡片"还是只进群文件列表——源码只能证明
  上传后额外发了 OIDB `0x6D9/4`（`OidbGroupSendFileReq`）且失败会抛错，渲染形式需人在客户端确认。
  `sendFile=false` 时的 403 分支未实测（改开关要写配置并重启桥接）。

## 遗留 / 后续

- 需要用户在 QQ 客户端确认：私聊文件气泡、群文件卡片/列表的最终呈现。
- 需要补的测试：把 `/api/send/file` 的 14 条失败路径固化成 `scripts/test-send-file.mjs` 并登记进 `test-audit`。
- 需要改的文档：`docs/` 里的工具清单（若有"可用工具一览"）补两个新工具名；`config.json` 的 `socialV2.file` 说明。
- 已知的 4 条既有失败（与本改动无关）：`test-voice-system.mjs`、`test-voice-pack-import.mjs`、
  `test-agent-preset-patches.mjs`（preset patch 漂移，跑 `node scripts/build-agent-preset-patches.mjs`）、
  `test-release-manifest.mjs`（release 清单相对 git HEAD 过期）。
