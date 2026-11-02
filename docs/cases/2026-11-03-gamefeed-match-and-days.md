# 2026-11-03 `gamefeed` 认不出「崩坏 · 星穹铁道」，天数上限两边各写一份

## 现象

- 用户原话：「今天B站：V1GFH96bEzt 发布太旧（26 天 > 21）【卡住】；BV175J96wEdi 标题写「崩坏 · 星穹铁道」，中间多了个间隔号，就对不上【卡住】；今天鲸鱼娘再给我推送信息时说：gamefeed 的天数能不能放宽一点，或者容许标题里带符号的变体。」
- 复现：
  - `node plugins/surfcore/tools/bili.mjs gamefeed --game 崩坏星穹铁道` → 候选里**永远不会**出现 `BV175J96wEdi`（17 天、5.4 万播放、13.7% 点赞率，完全够格）。
  - 手动把 `BV1GFH96bEzt`（25 天、3.3 万播放、10.7% 点赞率）交给 `daily --kind game --bvid …` → `✗ 太旧了（25 天前，上限 21 天）`，`process.exit(5)`。
- 影响面：只影响二类（游戏 AI 二创）选题。不丢数据、不花钱；表现是「连续几天没有可发的候选」或「明明有合适的视频却发不出去」。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 0.2.2-alpha.2（web profile） |
| SurfCore 版本 | 0.8.6（`59ec306`），另挂本地分支 `pr/gif-middleware`（GIF 中间层，未合并） |
| 安装方式 | git 仓库 + junction（`~/.dsh/plugins/surfcore → 仓库根`） |
| 其它相关版本 | B 站 `wbi/search/type` 接口、ffmpeg 无关 |

## 根因

两条独立的根因，各自都能单独卡住一整天：

1. **天数上限写了两份，且 `--days` 是假放宽**
   - `plugins/surfcore/tools/commands/gamefeed.mjs`（旧 28 行）：`const DAYS = Number(opt.days ?? (FOR === 'game' ? 21 : 14))`
   - `plugins/surfcore/tools/commands/daily.mjs`（旧 151-156 行）：`LIMITS = { game: { days: 21, … }, anime: { days: 14, … }, gaming: { days: 14, … } }`，在 214 行 `if (days > L.days) bad.push('太旧了…')` 后 `exit(5)`
   - 两个数恰好相同，所以「gamefeed 放宽 `--days`」看起来有效，实际只是把 video 推到 daily 面前再被拒。
   - `BV1GFH96bEzt` 是 25 天前发布（用户记成 26，取决于时分），超过 21 → 死在 daily。

2. **标题匹配用裸 `includes()`，不认标点/简称**
   - `gamefeed.mjs`（旧 92 行）`if (!text.includes(GAME)) continue`；`daily.mjs`（旧 207 行）`if (!text.includes(game)) bad.push(…)`
   - `BV175J96wEdi` 标题为 `Ai代码视角下的【崩坏 · 星穹铁道】｜开拓者看完不烧心~`，中间有空格和间隔号 `·`，`includes('崩坏星穹铁道')` 为 `false` → 被判成「不是这款游戏」。
   - 同类写法还有 `崩坏：星穹铁道`、`星穹铁道`、`崩铁`、`絕區零`、`ZZZ` 等。

为什么之前没发现：这两个上限从 2026-10-21 定下来后一直没碰过；`GAMES` 里的名字都是无标点写法，测试和日常自测刚好都用了规范写法，没人用带 `·` 的标题验证过。

## 完整逻辑（给用户看的那一遍）

- **链路**：`bili.mjs gamefeed` 负责「搜 B 站 → 过滤 → 排序 → 给候选」；`bili.mjs daily` 负责「校验 + 组装 + 发布」。两者是**两个独立进程**，只共享本地状态文件，不共享代码常量——这正是天数会各写一份的原因。
- **机制**：`gamefeed` 用 `pubdate` 和窗口比较决定「召回与否」；`daily` 用同样的 `pubdate` 和它自己那份上限决定「许不许发」。同一件事（一个视频太旧没有）被问了两遍，答案的来源却是两份拷贝。
- **爆炸半径**：2 个进程 × 各 1 处读取 × 静默（用户只会看到「没有新的了」，不会看到「配置不一致」）= 3 分。不碰密钥、不花钱，最坏情况是连续几天发不出二类动态，轮换指针因此不前进，越积越旧。
- **取舍**：
  - A（选）：抽 `lib/kind-limits.mjs` 做唯一真源，`gamefeed` 的默认窗口和 `daily` 的硬闸都从它取；`--days` 改成「只能收紧」，超出上限时**打警告并夹回**。
  - B（弃）：只把两处数字都改成 35。改动更小，但下一次谁改一处忘了另一处，同样的故障会以「候选都合格却发不出去」的形式重演。
  - C（弃）：只在 `daily` 加 `--force` 绕过天数。会把「太旧」这条质量约束变成可选项，且模型会滥用。
- **生效与重启**：两个命令都是**每次调用新起 node 进程**，改完下一次调用就生效；不需要重启 DSH（`gamefeed`/`daily` 不在宿主进程里常驻）。

## 修法

- 新增 `plugins/surfcore/tools/lib/kind-limits.mjs`：`KIND_LIMITS`（冻结）+ `limitFor(kind)` + `clampRecallDays(requested, kind)`。二类天数 **21 → 35**，其余不变（`best 999` / `anime 14` / `gaming 14`）。
- `plugins/surfcore/tools/lib/games.mjs` 新增：`GAME_ALIASES`（每款游戏的正名别名表）、`normalizeForMatch()`（剥掉空白/`\p{P}`/`\p{S}` 再小写）、`aliasesFor()`、`mentionsGame(text, game)`（CJK 别名走归一化包含，ASCII 别名如 `zzz`/`genshin` 走词边界，避免粘到英文单词里）。
- `gamefeed.mjs`：`DAYS` 改为 `clampRecallDays(opt.days, FOR).days`；`--days` 非法时打警告并回退默认、超上限时打警告并夹回；游戏名判断换成 `mentionsGame(text, GAME)`。
- `daily.mjs`：`LIMITS` 改为 `KIND_LIMITS`；游戏名判断换成 `mentionsGame(text, game)`，错误文案补上「简称/符号变体也算」。
- 回滚：`git revert <commit>` 即可；没有状态文件格式变化，无需迁移。

## 验证

- 自动化：`node scripts/test-game-match.mjs` → **21 组全过**（真实标题、误触发、门槛唯一真源、`clampRecallDays` 六种垃圾输入、以及两条「别再退回 `includes()`」的源码静态检查）。
- 已登记进 `scripts/test-audit.mjs` 的 `tests` 数组。
- 两条被卡住的视频按新规则重算：
  ```
  BV1GFH96bEzt days=25 likeRate=10.7% ✅ 通过
  BV175J96wEdi days=17 likeRate=13.7% ✅ 通过
  ```
- 端到端：`bili.mjs gamefeed --game 崩坏星穹铁道 --no-remember --n 6` 跑通，候选里出现了 `崩铁新BOSS…`（走别名命中）等条目。
- 失败路径（用户看到什么）：`--days abc` → `⚠ --days 不是有效天数（收到「abc」），已按默认 35 天取`；`--days 50` → `⚠ 「二类（游戏 AI 二创）」的发布上限是 35 天：--days 50 只能收紧、不能放宽（放宽会被 daily 以「太旧了」拒掉）`。
- 没验证到的：真实发布链路（`daily` 真正发出去）没跑，只用 `--dry` 之前的校验逻辑核对过；别名表是否覆盖所有民间写法（例如「星铁」「崩壞星穹鐵道」）只做了常见几种。

## 遗留 / 后续

- 别名词表可以继续补（尤其繁体全称「崩壞星穹鐵道」目前靠 `星穹铁道` 别名兜住，因为归一化后 `崩壞星穹鐵道` ≠ `崩坏星穹铁道`）。
- `gamefeed` 的 3 天冷却与 30 天备忘仍是手写，`lib/feed-core.mjs` 里已有等价的 `filterRecentlyPicked` / `prunePickedMap`，可择机收敛（本轮不动，避免扩大改动面）。
- `docs/cases/README.md` 已登记；`docs/PITFALLS.md` 新增 #102；`docs/HANDOFF.md` 顶部加了快照；`docs/RELEASE-QUEUE.md` 追加批次（**未改 version、未打 tag**）。
