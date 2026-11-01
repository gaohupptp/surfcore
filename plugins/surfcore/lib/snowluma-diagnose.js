/**
 * SnowLuma「连不上到底卡在哪一步」的判定（纯函数，不碰 IO）。
 *
 * 为什么单独拆出来（2026-11-02，用户反馈「提示说 token 不对，可我 token 明明是好的」）：
 * 1. 旧判定只有一个分支：**OneBot 端口在听 + 桥接没连上 ⇒ 一定是 token 不对**。
 *    可这条路上至少有四种完全不同的原因（桥接没起 / 控制台令牌不对 / 端口配反 /
 *    SnowLuma 的 WS 拒绝握手），提示却只有一句话，用户照着改 token 越改越迷糊。
 * 2. 旧提示把方向写反了：实测「wsUrl 指到 HTTP 口」时 SnowLuma 回 200 而不是 101，
 *    桥接报 `non-101 status code`；旧文案写的是「httpUrl 指到了 WebSocket 端口」。
 * 3. 纯函数才能把每条分支钉进测试（AGENTS §1.7：失败路径必须有 code + hint 断言）。
 *
 * 调用方（`lib/index.js`）只负责把「桥接状态快照 + 探到的端口」喂进来。
 */

/**
 * 从 URL 里取端口；取不到返回 0（空值 / 非法 URL / 相对路径）。
 * `ws://host` 和 `http://host` 不带端口时按协议给默认值（80/443）。
 * @param {unknown} value
 * @returns {number}
 */
export function portOfUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  try {
    const url = new URL(text);
    if (url.port) {
      const port = Number(url.port);
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
    }
    const proto = url.protocol.toLowerCase();
    if (proto === 'http:' || proto === 'ws:') return 80;
    if (proto === 'https:' || proto === 'wss:') return 443;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * 诊断状态的稳定枚举。**改动会进 UI（原样显示 state）和 plugin.log，别随手改名。**
 * 旧的 `not-running` / `needs-login` / `onebot-rejected` 保留原值，免得前端和日志对不上。
 */
export const SNOW_DIAG_STATES = Object.freeze({
  OK: 'ok',
  BRIDGE_DOWN: 'bridge-down',
  BRIDGE_UNAUTHORIZED: 'bridge-unauthorized',
  CONFIG_SWAPPED: 'config-swapped',
  ONE_BOT_REJECTED: 'onebot-rejected',
  WS_PORT_CLOSED: 'ws-port-closed',
  NEEDS_LOGIN: 'needs-login',
  NOT_RUNNING: 'not-running',
});

const HINT_LOG = '具体原因看 surfcore\\state\\bridge.log 里 non-101 / 1006 那几行。';

/** 人读的一行结论（`error` 字段，给日志和弹窗用；`state` 给机器）。 */
const STATE_LABELS = Object.freeze({
  [SNOW_DIAG_STATES.OK]: '已连接',
  [SNOW_DIAG_STATES.BRIDGE_DOWN]: 'QQ 桥接没在运行',
  [SNOW_DIAG_STATES.BRIDGE_UNAUTHORIZED]: '桥接控制台令牌不对',
  [SNOW_DIAG_STATES.CONFIG_SWAPPED]: 'wsUrl 与 httpUrl 指到了同一个端口',
  [SNOW_DIAG_STATES.ONE_BOT_REJECTED]: 'OneBot 端口在听，但 WebSocket 没握手成功',
  [SNOW_DIAG_STATES.WS_PORT_CLOSED]: 'SnowLuma 的 WebSocket 口没开',
  [SNOW_DIAG_STATES.NEEDS_LOGIN]: 'SnowLuma 停在登录页',
  [SNOW_DIAG_STATES.NOT_RUNNING]: 'SnowLuma 没在运行',
});

/**
 * @param {object} ctx
 * @param {{running?:boolean, ok?:boolean, httpStatus?:number, error?:string}} [ctx.bridge]
 *        桥接控制台的状态快照（`bridgeStatus()` 的返回值）；拿不到就给 `{}`。
 * @param {{connected?:boolean, accountOnline?:boolean, good?:boolean, goodError?:string} | null} [ctx.snow]
 *        快照里的 `bridge.snowluma`；桥接没跑时是 null。
 * @param {{http?:boolean, ws?:boolean, webui?:boolean}} [ctx.ports]
 *        探活结果：http/ws 是配置里的那两个口，webui 是 SnowLuma 控制台口。
 * @param {{httpUrl?:string, wsUrl?:string}} [ctx.urls] 配置里的地址（只用来判断端口是否配反）。
 * @param {string} [ctx.webuiUrl] SnowLuma 控制台地址（拼进「去扫码」的提示）。
 * @returns {{state:string, code:string, error:string, hint:string, level:'ok'|'warn'|'fail', evidence:object}}
 */
export function decideSnowLumaDiagnosis({ bridge = {}, snow = null, ports = {}, urls = {}, webuiUrl = '' } = {}) {
  const httpPort = portOfUrl(urls.httpUrl) || 3000;
  const wsPort = portOfUrl(urls.wsUrl) || 3001;
  const httpOpen = ports.http === true;
  const wsOpen = ports.ws === true;
  const webuiOpen = ports.webui === true;
  const bridgeRunning = bridge?.running;
  const bridgeOk = bridge?.ok;

  const evidence = {
    bridgeRunning: bridgeRunning === undefined ? null : Boolean(bridgeRunning),
    bridgeOk: bridgeOk === undefined ? null : Boolean(bridgeOk),
    bridgeHttpStatus: bridge?.httpStatus ?? null,
    connected: snow?.connected === true,
    httpPort,
    wsPort,
    httpOpen,
    wsOpen,
    webuiOpen,
  };

  const fail = (state, code, hint) => ({
    state, code, hint, level: /** @type {'warn'|'fail'} */ ('fail'), error: STATE_LABELS[state] ?? state, evidence,
  });
  const warn = (state, code, hint) => ({
    state, code, hint, level: /** @type {'warn'} */ ('warn'), error: STATE_LABELS[state] ?? state, evidence,
  });

  // ① 已经连上：不再探端口，也不给任何建议。
  if (snow?.connected === true) {
    return {
      state: SNOW_DIAG_STATES.OK, code: 'snow.ok', hint: '', level: 'ok', error: STATE_LABELS[SNOW_DIAG_STATES.OK], evidence,
    };
  }

  // ② 桥接进程都没起：跟 token 一点关系都没有（旧版在这里误报 token 不对）。
  if (bridgeRunning === false) {
    return fail(SNOW_DIAG_STATES.BRIDGE_DOWN, 'snow.bridge-down',
      'QQ 桥接没在运行：设置 → SurfCore → 概览 → 「启动 QQ 桥接」（或双击 surfcore 目录的 start.bat）。桥接没起时，SnowLuma 连不连得上跟 accessToken 无关。');
  }

  // ③ 桥接在跑，但控制台拿不到状态 → consoleToken 的问题，不是 OneBot 的 token。
  if (bridgeRunning === true && bridgeOk === false) {
    const status = bridge?.httpStatus ?? 0;
    return fail(SNOW_DIAG_STATES.BRIDGE_UNAUTHORIZED, 'snow.bridge-unauthorized',
      `桥接端口在监听，但控制台不认这个令牌（HTTP ${status || '?'}）：重启桥接会自动对齐 state/console-token；还不行就是 config.json 的 consoleToken 被改过。这一步和 SnowLuma 的 accessToken 是两回事。`);
  }

  // ④ 配置把两个口指成同一个：桥接拿 HTTP 口当 WebSocket 连，SnowLuma 回 200，日志里是 non-101。
  if (wsPort && httpPort && wsPort === httpPort) {
    return fail(SNOW_DIAG_STATES.CONFIG_SWAPPED, 'snow.config-swapped',
      `配置里 wsUrl 和 httpUrl 都指向 ${httpPort} 端口：桥接会拿 HTTP 口当 WebSocket 连（SnowLuma 回 200 而不是 101）。把 wsUrl 改成 SnowLuma 的 WebSocket 端口（默认 3001），httpUrl 保持 HTTP 端口（默认 3000）。`);
  }

  // ⑤ WS 口在听但没连上：这才是「token 不对 / 端口配反」真正对应的情况。
  if (wsOpen) {
    const reported = String(snow?.goodError ?? '').trim();
    const head = reported ? `桥接报：${reported.slice(0, 80)}。` : '';
    return fail(SNOW_DIAG_STATES.ONE_BOT_REJECTED, 'snow.onebot-rejected',
      `${head}OneBot 的 WebSocket 口（${wsPort}）在监听，但桥接没握手成功：回 401 = accessToken 不对（重启桥接会从 SnowLuma 的 onebot_<QQ号>.json 自动对齐）；回 200 = wsUrl 指到了 HTTP 口。${HINT_LOG}`);
  }

  // ⑥ HTTP 口通、WS 口不通：SnowLuma 没开 WS 服务，或者 wsUrl 写错了端口。
  if (httpOpen && !wsOpen) {
    return fail(SNOW_DIAG_STATES.WS_PORT_CLOSED, 'snow.ws-port-closed',
      `SnowLuma 的 HTTP 口（${httpPort}）在听，但 WebSocket 口（${wsPort}，取自 wsUrl）没开：在 SnowLuma 里确认「OneBot WebSocket 服务」已开启，或把 wsUrl 改成它实际监听的端口。`);
  }

  // ⑦ 两个 OneBot 口都不通、控制台开着 → 多半停在登录页。
  if (webuiOpen) {
    return warn(SNOW_DIAG_STATES.NEEDS_LOGIN, 'snow.needs-login',
      `SnowLuma 已启动但还没登录：打开 ${webuiUrl || 'SnowLuma 控制台'} 扫码/登录`);
  }

  // ⑧ 什么都不通 → 没运行。
  return fail(SNOW_DIAG_STATES.NOT_RUNNING, 'snow.not-running',
    'SnowLuma 没在运行：设置 → SurfCore → 概览 → 一键启动（会按需打开控制台）');
}
