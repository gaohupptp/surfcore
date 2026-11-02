// 各类动态的发布硬门槛（**唯一真源**）
//
// 为什么单独拆一份：
//   以前 `gamefeed.mjs` 的召回窗口和 `daily.mjs` 的发布硬闸各写一份 21/14，
//   两个数字恰好相同，于是 `gamefeed --days 35` 能把 30 天前的视频推到你面前，
//   你 debrief 觉得不错，发的时候被 daily 一句「太旧了（30 天前，上限 21 天）」拒掉。
//   也就是说「放宽 --days」是**假放宽** —— 2026-11-03 的 BV1GFH96bEzt（25 天）就是这条路。
//
//   现在两个命令都 import 这里：改一次，召回和硬闸同时生效，不会再各说各话。
//
// 数值语义：
//   days     —— 发布距今最多几天（超过就不收/不许发）
//   play     —— 播放量下限
//   likeRate —— 点赞率下限（赞/播）
export const KIND_LIMITS = Object.freeze({
  best: Object.freeze({ days: 999, play: 0, likeRate: 0 }),
  game: Object.freeze({ days: 35, play: 2000, likeRate: 0.02 }),
  anime: Object.freeze({ days: 14, play: 5000, likeRate: 0.025 }),
  gaming: Object.freeze({ days: 14, play: 5000, likeRate: 0.025 }),
})

/** 拿某一类的门槛；不认识的 kind 退回最宽松的 best（调用方随后一般会自己报错退出） */
export function limitFor(kind) {
  return KIND_LIMITS[kind] ?? KIND_LIMITS.best
}

/**
 * 算出实际要用的召回窗口。
 *
 * 规则：`--days` 只能**收紧**，不能放宽。放宽没有意义 —— 就算召回来了，
 * daily 那一步也会按同一个上限拒掉，白让你 debrief 一遍。
 *
 * @returns {{days:number, clamped?:boolean, invalid?:boolean, requested?:unknown}}
 */
export function clampRecallDays(requested, kind) {
  const cap = limitFor(kind).days
  if (requested === undefined || requested === null) return { days: cap }

  const n = Number(requested)
  // --days 后面没跟数字（argv 解析成 true）、空串、负数、NaN 都当作"没给对"
  if (requested === true || requested === '' || !Number.isFinite(n) || n <= 0) {
    return { days: cap, invalid: true, requested }
  }
  if (n > cap) return { days: cap, clamped: true, requested: n }
  return { days: Math.max(1, Math.floor(n)) }
}
