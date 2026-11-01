// SnowLuma「连不上卡在哪一步」的判定（纯函数）：
// 每种失败分支必须给出**不同的** state/code，并且 hint 非空、能直接照做
// （AGENTS §1.7：失败路径要有 code + hint 断言，不许静默、不许张冠李戴）。
import assert from 'node:assert/strict';
import {
  decideSnowLumaDiagnosis, portOfUrl, SNOW_DIAG_STATES,
} from '../lib/snowluma-diagnose.js';

const config = { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' };
const ports = (http, ws, webui = false) => ({ http, ws, webui });
const diag = (ctx) => decideSnowLumaDiagnosis({ urls: config, webuiUrl: 'http://127.0.0.1:5099', ...ctx });

// 所有非 ok 的分支都跑一遍，统一钉住：state/code/error/hint 都不能空。
const cases = [];
const push = (name, result, state) => { cases.push({ name, result, state }); return result; };

// 1) 已连接 → ok，且不探端口也给 ok
{
  const r = push('已连接', diag({ snow: { connected: true }, bridge: { running: true, ok: true }, ports: ports(false, false) }), 'ok');
  assert.equal(r.state, SNOW_DIAG_STATES.OK);
  assert.equal(r.code, 'snow.ok');
  assert.equal(r.hint, '', 'ok 不应给任何建议');
  assert.equal(r.level, 'ok');
}

// 2) 桥接没运行 → bridge-down（**旧版的 bug**：这里会被报成 token 不对）
{
  const r = push('桥接没跑', diag({
    snow: null, bridge: { ok: false, running: false }, ports: ports(true, true),
  }), SNOW_DIAG_STATES.BRIDGE_DOWN);
  assert.equal(r.code, 'snow.bridge-down');
  assert.match(r.hint, /桥接没在运行/);
  assert.doesNotMatch(r.hint, /accessToken 不匹配/, '桥接没起时不该让用户去改 accessToken');
  assert.match(r.hint, /启动 QQ 桥接/, '要给出下一步');
}

// 3) 桥接在跑但控制台令牌不对 → bridge-unauthorized（和 OneBot 的 token 是两回事）
{
  const r = push('控制台令牌不对', diag({
    snow: null, bridge: { ok: false, running: true, httpStatus: 401 }, ports: ports(true, true),
  }), SNOW_DIAG_STATES.BRIDGE_UNAUTHORIZED);
  assert.equal(r.code, 'snow.bridge-unauthorized');
  assert.match(r.hint, /consoleToken/);
  assert.match(r.hint, /401/);
}

// 4) wsUrl 和 httpUrl 指到同一个口 → config-swapped（实测 SnowLuma 会回 200 而不是 101）
{
  const r = push('端口配反', decideSnowLumaDiagnosis({
    snow: { connected: false },
    bridge: { running: true, ok: true },
    urls: { wsUrl: 'ws://127.0.0.1:3000', httpUrl: 'http://127.0.0.1:3000' },
    ports: ports(true, true),
  }), SNOW_DIAG_STATES.CONFIG_SWAPPED);
  assert.equal(r.code, 'snow.config-swapped');
  assert.match(r.hint, /wsUrl/, '要说清该改的是 wsUrl');
  assert.match(r.hint, /3001/, '要给出默认正确端口');
}

// 5) WS 口在听但握手失败 → onebot-rejected（这里是 token 真有可能不对的那种）
//    方向必须是「wsUrl 指到 HTTP 口」，旧文案写反成了 httpUrl。
{
  const r = push('WS 握手失败', diag({
    snow: { connected: false, goodError: 'Received network error or non-101 status code.' },
    bridge: { running: true, ok: true }, ports: ports(true, true),
  }), SNOW_DIAG_STATES.ONE_BOT_REJECTED);
  assert.equal(r.code, 'snow.onebot-rejected');
  assert.match(r.hint, /401/, '401 = token 不对，要写出来');
  assert.match(r.hint, /200/, '200 = 端口搞混，要写出来');
  assert.match(r.hint, /wsUrl/, '方向要写对：是 wsUrl 指到了 HTTP 口');
  assert.doesNotMatch(r.hint, /httpUrl 指到了 WebSocket/, '旧文案的方向是错的，不许回来');
  assert.match(r.hint, /non-101/, '把桥接原始报错带出来');
  assert.match(r.hint, /bridge\.log/, '给出日志位置');
}

// 6) HTTP 口通、WS 口不通 → ws-port-closed
{
  const r = push('WS 口没开', diag({
    snow: { connected: false }, bridge: { running: true, ok: true }, ports: ports(true, false),
  }), SNOW_DIAG_STATES.WS_PORT_CLOSED);
  assert.equal(r.code, 'snow.ws-port-closed');
  assert.match(r.hint, /3001/);
}

// 7) 只有控制台在听 → needs-login（warn，不是 fail）
{
  const r = push('停在登录页', diag({
    snow: { connected: false }, bridge: { running: true, ok: true }, ports: ports(false, false, true),
  }), SNOW_DIAG_STATES.NEEDS_LOGIN);
  assert.equal(r.code, 'snow.needs-login');
  assert.equal(r.level, 'warn');
  assert.match(r.hint, /5099/, '要把 WebUI 地址带出来');
}

// 8) 什么都不通 → not-running
{
  const r = push('没运行', diag({
    snow: { connected: false }, bridge: { running: true, ok: true }, ports: ports(false, false, false),
  }), SNOW_DIAG_STATES.NOT_RUNNING);
  assert.equal(r.code, 'snow.not-running');
  assert.match(r.hint, /一键启动/);
}

// 9) 桥接状态根本拿不到（概览里 bridgeStatus 抛错时给的是 {}）→ 不能瞎报 token 错
{
  const r = diag({ snow: null, bridge: {}, ports: ports(false, false, false) });
  assert.equal(r.state, SNOW_DIAG_STATES.NOT_RUNNING, '桥接状态未知时只按端口说话，不许猜 token');
}

// 10) 统一钉住：每条分支都有 state/code/error/hint，且彼此不重复
{
  const seen = new Set();
  for (const { name, result, state } of cases) {
    assert.equal(result.state, state, `${name}：state 不对`);
    assert.ok(result.code && result.code.startsWith('snow.'), `${name}：code 不能空且要有前缀`);
    assert.ok(result.error, `${name}：error 不能空（人读的一行结论）`);
    if (state !== SNOW_DIAG_STATES.OK) {
      assert.ok(result.hint.length >= 12, `${name}：hint 太短，用户照做不了`);
      assert.match(result.hint, /[：:]/, `${name}：hint 要写清「在哪失败 / 怎么改」`);
    }
    assert.equal(result.evidence.connected, state === SNOW_DIAG_STATES.OK, `${name}：evidence.connected 记错了`);
    seen.add(result.code);
  }
  assert.equal(seen.size, cases.length, '分支 code 不能重复（重复 = 用户分不清是哪一种）');
}

// 11) 端口解析：配置为空/端口缺失/写错时回退到 3000/3001，不许抛
{
  assert.equal(portOfUrl('ws://127.0.0.1:3001'), 3001);
  assert.equal(portOfUrl('http://127.0.0.1'), 80);
  assert.equal(portOfUrl('https://127.0.0.1'), 443);
  assert.equal(portOfUrl(''), 0);
  assert.equal(portOfUrl('随便写的'), 0);
  assert.equal(portOfUrl('ws://127.0.0.1:99999'), 0);

  const fallback = decideSnowLumaDiagnosis({
    snow: { connected: false }, bridge: { running: true, ok: true }, urls: {}, ports: ports(true, true),
  });
  assert.equal(fallback.state, SNOW_DIAG_STATES.ONE_BOT_REJECTED, '没配地址时按默认 3000/3001 判');
  assert.equal(fallback.evidence.wsPort, 3001);
  assert.equal(fallback.evidence.httpPort, 3000);
}

console.log(`✅ SnowLuma 连接诊断通过（${cases.length} 条失败分支各有独立 code/hint）`);
