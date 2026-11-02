// 六款游戏的「二创动态」轮换（2026-10-21 管理员定）
//
// 规则：每天发一条 AI 二创推荐，六款游戏**按顺序轮换**，不跳、不重复、不让她自己挑。
//   顺序：原神 → 鸣潮 → 绝区零 → 崩坏星穹铁道 → 终末地 → 异环 → 回到原神
//
// 轮换指针只在**发成功之后**才前进（写盘在 daily.mjs 里），失败不算 ✓
import { accountBili, biliState, biliStateDir } from './state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const ROTATION = biliState('game-rotation.json')

export const GAMES = ['原神', '鸣潮', '绝区零', '崩坏星穹铁道', '终末地', '异环']

/** 每个游戏的搜索词（多搜几个，召回率高一点） */
export function queriesFor(game) {
  return [
    `${game} AI 二创`,
    `${game} AI 动画`,
    `${game} AI 视频`,
  ]
}

// ── 标题里认游戏名：忽略标点/空格/繁简/简称 ──────────────────────
//
// 真事（2026-11-03）：BV175J96wEdi 的标题是
//   「Ai代码视角下的【崩坏 · 星穹铁道】｜开拓者看完不烧心~」
// 中间多了一个「 · 」和两个空格，`text.includes('崩坏星穹铁道')` 直接 false，
// 于是这条 17 天、5.4 万播放、13.7% 点赞率的视频被判成"不是这个游戏"。
// 同理还有「崩坏：星穹铁道」「星穹铁道」「崩铁」这些写法。
//
// 做法：先去掉所有空白/标点/符号再比（CJK 串），ASCII 别名（ZZZ/Genshin…）
// 用词边界在原文上比，避免 "zzz" 粘到英文单词里。
export const GAME_ALIASES = Object.freeze({
  原神: Object.freeze(['genshin']),
  鸣潮: Object.freeze(['鳴潮', 'wuthering']),
  绝区零: Object.freeze(['絕區零', '绝区0', 'zzz', 'zenless']),
  崩坏星穹铁道: Object.freeze(['星穹铁道', '崩铁', 'honkai star rail', 'honkai: star rail']),
  终末地: Object.freeze(['終末地', 'endfield']),
  异环: Object.freeze(['異環']),
})

/** 去掉空白、标点（\p{P}）和符号（\p{S}，含 emoji）后转小写 */
export function normalizeForMatch(value) {
  return String(value ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

/** 正名 + 别名 */
export function aliasesFor(game) {
  const g = String(game ?? '').trim()
  if (!g) return []
  return [g, ...(GAME_ALIASES[g] ?? [])]
}

const ASCII_ONLY = /^[\x20-\x7e]+$/
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 标题/简介/分区里是否提到了这款游戏（容忍符号、空格、繁简、简称）。
 * @param {string} text 拼好的文本
 * @param {string} game 正名（GAMES 里那一项）
 */
export function mentionsGame(text, game) {
  const norm = normalizeForMatch(text)
  if (!norm) return false
  const raw = String(text ?? '').toLowerCase()
  return aliasesFor(game).some((alias) => {
    const a = String(alias).toLowerCase().trim()
    if (!a) return false
    if (ASCII_ONLY.test(a)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRe(a)}([^a-z0-9]|$)`).test(raw)
    }
    return norm.includes(normalizeForMatch(a))
  })
}

export function loadRotation() {
  try {
    const j = JSON.parse(fs.readFileSync(ROTATION, 'utf8'))
    return { i: Number.isFinite(Number(j.i)) ? ((Number(j.i) % GAMES.length) + GAMES.length) % GAMES.length : 0, ...j }
  } catch { return { i: 0 } }
}

export function currentGame() {
  return GAMES[loadRotation().i % GAMES.length]
}

/** 发成功后前进一格 */
export function advanceRotation(game) {
  const r = loadRotation()
  const i = (GAMES.indexOf(game) + 1 + GAMES.length) % GAMES.length
  const next = { i, lastGame: game, lastAt: new Date().toISOString() }
  try {
    fs.mkdirSync(path.dirname(ROTATION), { recursive: true })
    fs.writeFileSync(ROTATION, JSON.stringify(next, null, 2) + '\n')
  } catch {}
  return next
}
