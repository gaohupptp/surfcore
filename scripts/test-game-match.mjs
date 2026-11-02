// 游戏名识别 + 发布天数门槛（2026-11-03 那两条卡住的视频）
//
// 背景（真实故障）：
//   1. BV1GFH96bEzt —— 25 天前发布。gamefeed 的召回窗口是 21 天、daily 的硬闸也是 21 天，
//      但它其实已经被召回出来了（因为轮换卡住），最后死在 daily 的「太旧了（26 天 > 21）」。
//      → 两个 21/14 各写一份、`--days` 假放宽，抽成 lib/kind-limits.mjs 一份。
//   2. BV175J96wEdi —— 标题「Ai代码视角下的【崩坏 · 星穹铁道】｜…」，中间多了「 · 」，
//      `text.includes('崩坏星穹铁道')` 为 false，被判成"不是这个游戏"。
//      → 改用 lib/games.mjs 的 mentionsGame()，忽略空白/标点/符号，并认可简称。
//
// 这个测试不联网、不读用户状态：纯函数 + 源码静态检查。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES, GAME_ALIASES, mentionsGame, normalizeForMatch, aliasesFor } from '../plugins/surfcore/tools/lib/games.mjs';
import { KIND_LIMITS, limitFor, clampRecallDays } from '../plugins/surfcore/tools/lib/kind-limits.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

console.log('游戏名识别 · 真实标题');
check('「崩坏 · 星穹铁道」带间隔号也算（BV175J96wEdi 原题）', () => {
  assert.equal(mentionsGame('Ai代码视角下的【崩坏 · 星穹铁道】｜开拓者看完不烧心~', '崩坏星穹铁道'), true);
});
check('全角冒号变体也算', () => {
  assert.equal(mentionsGame('【崩坏：星穹铁道】AI 短片', '崩坏星穹铁道'), true);
});
check('简称「星穹铁道」也算', () => {
  assert.equal(mentionsGame('星穹铁道 二创合集', '崩坏星穹铁道'), true);
});
check('黑话「崩铁」也算', () => {
  assert.equal(mentionsGame('崩铁 AI 动画来了', '崩坏星穹铁道'), true);
});
check('emoji 与紧贴的括号不影响（BV1GFH96bEzt 原题）', () => {
  assert.equal(mentionsGame('⚡️开拓者X流萤 APT⚡️【崩坏星穹铁道】【AI MV大赛】', '崩坏星穹铁道'), true);
});
check('繁体「鳴潮」也算', () => {
  assert.equal(mentionsGame('鳴潮二創', '鸣潮'), true);
});
check('「绝区 0」/「ZZZ」也算', () => {
  assert.equal(mentionsGame('绝区 0 的新角色', '绝区零'), true);
  assert.equal(mentionsGame('ZZZ 同人动画', '绝区零'), true);
  assert.equal(mentionsGame('zenless zone zero', '绝区零'), true);
});

console.log('游戏名识别 · 不该误触发');
check('别的游戏不串台', () => {
  assert.equal(mentionsGame('崩坏学园2 的同人', '崩坏星穹铁道'), false);
  assert.equal(mentionsGame('原神 5.0 前瞻', '崩坏星穹铁道'), false);
  assert.equal(mentionsGame('鸣潮 新版本', '原神'), false);
});
check('zzz 不能粘到英文单词里', () => {
  assert.equal(mentionsGame('zzzZzzzz', '绝区零'), false);
  assert.equal(mentionsGame('puzzlezzz game', '绝区零'), false);
});
check('空文本 / 空游戏名一律 false', () => {
  assert.equal(mentionsGame('', '原神'), false);
  assert.equal(mentionsGame('原神', ''), false);
  assert.equal(mentionsGame(null, '原神'), false);
  assert.equal(mentionsGame('原神', null), false);
});
check('normalizeForMatch 只剥空白/标点/符号', () => {
  assert.equal(normalizeForMatch('崩坏 · 星 穹—铁 道'), '崩坏星穹铁道');
  assert.equal(normalizeForMatch('AI 动画'), 'ai动画');
});
check('每个 GAMES 项都有正名 + 至少能匹配自己', () => {
  for (const g of GAMES) {
    assert.ok(aliasesFor(g).includes(g), `${g} 的别名表里没有正名`);
    assert.equal(mentionsGame(`今天的 ${g} 二创`, g), true, `${g} 匹配不了自己`);
  }
  assert.deepEqual(Object.keys(GAME_ALIASES).sort(), [...GAMES].sort());
});

console.log('天数门槛 · 唯一真源');
check('game 放宽到 35 天，其余不动', () => {
  assert.equal(KIND_LIMITS.game.days, 35);
  assert.equal(KIND_LIMITS.anime.days, 14);
  assert.equal(KIND_LIMITS.gaming.days, 14);
  assert.equal(KIND_LIMITS.best.days, 999);
  assert.equal(limitFor('game').days, 35);
  assert.equal(limitFor('不存在'), KIND_LIMITS.best);
});
check('门槛是冻结的，免得运行时被改', () => {
  assert.equal(Object.isFrozen(KIND_LIMITS), true);
  assert.equal(Object.isFrozen(KIND_LIMITS.game), true);
});
check('clampRecallDays：不传就用上限', () => {
  assert.deepEqual(clampRecallDays(undefined, 'game'), { days: 35 });
  assert.deepEqual(clampRecallDays(null, 'anime'), { days: 14 });
});
check('clampRecallDays：收紧可以', () => {
  assert.deepEqual(clampRecallDays(7, 'game'), { days: 7 });
  assert.deepEqual(clampRecallDays('10', 'game'), { days: 10 });
  assert.deepEqual(clampRecallDays(3.9, 'game'), { days: 3 });
});
check('clampRecallDays：放宽被夹回上限并标记 clamped', () => {
  assert.deepEqual(clampRecallDays(50, 'game'), { days: 35, clamped: true, requested: 50 });
  assert.deepEqual(clampRecallDays(30, 'anime'), { days: 14, clamped: true, requested: 30 });
});
check('clampRecallDays：垃圾输入不再静默变成 NaN/1', () => {
  for (const bad of ['abc', '', true, -5, 0, Number.NaN, Infinity]) {
    const r = clampRecallDays(bad, 'game');
    assert.equal(r.days, 35, `输入 ${String(bad)} 应回退到 35，实际 ${r.days}`);
    assert.equal(r.invalid, true, `输入 ${String(bad)} 应标记 invalid`);
  }
});

console.log('接线检查 · 别再退回 includes()');
check('gamefeed.mjs 用 mentionsGame，不再用 text.includes(GAME)', () => {
  const src = fs.readFileSync(path.join(root, 'plugins/surfcore/tools/commands/gamefeed.mjs'), 'utf8');
  assert.equal(/text\.includes\(\s*GAME\s*\)/.test(src), false);
  assert.equal(/mentionsGame\(/.test(src), true);
  assert.equal(/clampRecallDays\(/.test(src), true);
});
check('daily.mjs 用 mentionsGame，且门槛从 lib 导入', () => {
  const src = fs.readFileSync(path.join(root, 'plugins/surfcore/tools/commands/daily.mjs'), 'utf8');
  assert.equal(/text\.includes\(\s*game\s*\)/.test(src), false);
  assert.equal(/mentionsGame\(/.test(src), true);
  assert.equal(/const LIMITS = KIND_LIMITS/.test(src), true);
  assert.equal(/days: 21/.test(src), false, 'daily.mjs 里不该再出现写死的 21 天');
});
check('gamefeed.mjs 里不再有写死的 21/14 窗口', () => {
  const src = fs.readFileSync(path.join(root, 'plugins/surfcore/tools/commands/gamefeed.mjs'), 'utf8');
  assert.equal(/'game' \? 21 : 14/.test(src), false);
});

console.log(`\n${process.exitCode ? '❌' : '✅'} 游戏名识别与天数门槛：${passed} 组通过`);
if (process.exitCode) process.exit(process.exitCode);
