# 双语翻译（transCover）生命周期缺陷：问题清单、修复与验证记录

- 记录日期：2026-11-23（含 PR #1 review 后的缺陷修复与复核，见第 8 节）
- 代码基线：`custom-llm` 分支 `727e778`（feat: 官方数据源 + 自有 LLM 兜底翻译），fork 自 `biuuu/ShinyColors`
- 需求范围：双语翻译浮层「点击跳过场景后译文残留，直到下一次触发双语翻译才被替换」及其同类触发问题
- 本次处置：**仅修复 P0**；P1/P2 暂不处理，仅当与 P0 同一根因 / 同类触发且不处理会影响 P0 修复效果时，作为例外同批处理（见第 3 节）
- 本轮未做浏览器内真机实测，验证方式与结论见第 6 节

---

## 1. 分析前提与已知边界条件

1. `config.transCover === 'on'` 时启用双语翻译；菜单切换会 `location.reload()`，模块级状态每次刷新重置。
2. 浮层 `#sczh-trans-cover` 是 `document.body` 下的常驻单例（`htmlInserted` 布尔），游戏 SPA 切换场景不会销毁它。
3. 显示入口唯一：`TrackManager.prototype.currentTrack` getter 包装 → `handleTrackChange()`；`transCover()` 全仓库仅 3 处调用。
4. 译文以打字机方式显示（100ms/字），`setInterval` 的 timer id 挂在 DOM 元素 `_typewriterTimerId` 上。
5. 译文数据由 `scnModule.load` 包装内的异步链加载（`story.json` / CSV / `comm-story` / 机翻），完成后 `startTrans → setStoryMap`。
6. 每次 `load` 开头执行 `setStoryMap(null)`（原代码只传 1 个参数）。
7. `git log` 确认 `trackStory.js` / `transCoverHtml.js` 自 `eb4b97f`（添加双语翻译）引入后从未修改；custom-llm 分支的 diff 未触及这两个文件。

优先级定义：**P0** 直接造成已报告现象；**P1** 高概率伴随 / 放大，或构成修复回归风险；**P2** 需真机实测确认；**P3** 排除项。

---

## 2. 问题清单（P0 / P1 / P2）

| 编号 | 级别 | 现象 | 触发条件 | 影响范围 | 相关代码 / 模块位置 | 处理建议 |
|---|---|---|---|---|---|---|
| A1 | **P0** | 场景结束后译文浮层不消失 | 跳过 / 切换场景使 `setStoryMap(null)` 先执行，随后到来的 `label==='end'` 或 `textFrame==='off'` track 被 `if (!storyMap \|\| !newValue) return` 整体吞掉，清理分支不可达 | 全部双语翻译场景；残留必现 | `src/modules/story/trackStory.js:22`（early return 位于清理分支之前）；`src/modules/story.js:120`（load 开头清空 map） | 把「场景结束 / track 失效」的清理判定提到 `!storyMap` 门控之前，清理后 `return`；UI 清理不得依赖译文数据是否就绪 |
| A2 | **P0** | 跳过场景后没有任何清理信号 | 跳过直接销毁 / 重建 TrackManager 实例、把 `currentTrack` 置空，或产生既非 `end` 也非 `off` 的 track | 残留跨场景持续，与用户报告完全一致 | `src/modules/story/trackStory.js:22`（`!newValue` 直接 return）、`:27-37`（仅两个特定清理条件）、`:42,84-90`（WeakMap 按实例引用比对，新实例首次读取值仍为 `undefined` 时不触发）；全仓库无 skip / DOM 销毁监听 | 增加不依赖 getter 的清理信号：在每次剧情资源 `load` 开始时收起上一场景浮层；`!newValue` 也走清理；`end`/`off` 清理改为互斥 |
| A3 | **P0** | 文字在场景结束后仍继续逐字打出并常驻 | 跳过发生在打字机动画进行中（长译文 + 首次加载窗口） | 残留内容会自行增长，直到下一次 `transCover()` 才被覆盖 | `src/utils/index.js:222-258`（仅下次调用才 `clearInterval`）；`src/utils/transCoverHtml.js:62-66`（`transCover()` 无条件 `remove('hide')`）；`:19`（`.hide` 仅在初始 HTML 出现，全仓库无 `add('hide')`） | 新增 `hideTransCover()`：复用 `transCover('')` 取消 timer 并清空文本，再 `classList.add('hide')`；所有清理路径统一调用 |
| A4 | P1 | `end` track 的清理被立刻写回 | `end` track 同时带 `text` 字段（是否如此待 C2 确认） | 清理失效，等同于残留；属于 A1/A2 同类触发 | `src/modules/story/trackStory.js:27,31,35`（三个并列 `if` 而非互斥） | 清理分支改为互斥并 `return`；**本次作为 A1 例外同批处理**（不处理会使 P0 修复在该分支上失效） |
| A5 | P1 | 迟到的翻译加载回调把「已跳过场景」的译文 map 装回 | 首次进入（译文索引/CSV/通用剧情表未缓存）或慢网，跳过早于 `await` 链完成 | 之后任一 track 读取可能渲染旧 / 错译文；`startTrans` 只更新数据不刷 UI | `src/modules/story.js:99-176`（`await getStory / getCommStory / autoTrans` 后才 `startTrans`）；`src/store/story.js:11,61,99,137`（模块级缓存，仅首次走网络，解释「首次进入」） | 每次 `load` 分配自增 generation，`await` 回来先比对，过期即丢弃（不写 map / 不刷 UI / 不弹提示）；`startTrans` 两侧统一 reset UI |
| A6 | P1 | 连续跳过场景后译文错配或缺句 | 跳过或任意不产生 `end` 的场景切换，使 `getId` 去重序列跨场景累积 `-1/-2` 后缀 | 译文命中错误或缺失 | `src/modules/story/trackStory.js:9,23-28`（`newStory=true` 唯一赋值点在 end 分支）；与 `src/store/story.js:18` 的 CSV 解析顺序强耦合 | 把 `newStory`/`getId` 重建迁移到「新场景加载」信号（依赖 A5 的 generation），保留 end 兼容 |
| A7 | P1 | `commMap` 为 `undefined`，`getTextTrans` 可能 TypeError | 每次 `load` 必然发生；当前被 A1 的 early return「保护」而不可达 | 当前无崩溃；**但修 A1 后保护消失**，会在清理提前的新路径上引入回归 | `src/modules/story.js:120`（`setStoryMap(null)` 少传第二参数）；`src/modules/story/trackStory.js:12`（签名 `setStoryMap(val1, val2)`）；`src/modules/story/utils.js:13`（`commMap.has(text)`） | 补齐为 `setStoryMap(null, null)`；**本次作为 A1 的必要依赖同批处理** |
| A8 | P2 | 浮层可能吞掉点击（含「跳过」按钮） | 跳过按钮落在浮层矩形内（浮层 `top ≈ 0.942 × ch`，同处画面底部） | 点击失效，需真机确认 | `src/utils/transCoverHtml.js:6-14`（绝对定位，未声明 `pointer-events`） | 给浮层加 `pointer-events: none`；先按 C5 实测确认重叠后再改 |
| A9 | P2 | 译文错配 | track 播放顺序与剧情 JSON / CSV 行顺序不一致（分支、回放、跳过部分台词） | 双语译文显示错误内容 | `src/modules/story/trackStory.js:24,32` 各自 `uniqueStoryId()`；`src/store/story.js:18` 按 CSV 顺序建 map，两侧靠顺序对齐 | 确认 C3 后再决定是否改用稳定 id 索引；本次不动 |

### 排除项（P3，理论上存在但基本不可能触发，不列为重点）

| 理论风险 | 边界依据 | 排除原因 |
|---|---|---|
| `typewriterEffect` 收到非 string / `box` 非 HTMLElement 而 reject | 3 个调用点只传 `''` 或 `getTextTrans()` 返回值（初始化 `''`，map 只写入字符串）；box 由 `insertAdjacentHTML` 在同一文档创建 | 用户已能看到译文，校验已通过；Promise 从未被 await |
| `htmlInserted=true` 但浮层被移除 → `box.classList` TypeError | 浮层是 body 直接子节点，只有整页 reload 才消失，reload 会重置 `htmlInserted` | 若发生表现为脚本报错、浮层不再更新，与「文字残留」矛盾 |
| getter 缺失 / 找不到 TRACK_MANAGER，`start()` 直接 return | `get-module.js:20-22` 已校验模块；失败会 `console.error` 并停止（30s 超时） | 后果是双语翻译完全不显示，与「已显示后残留」互斥 |
| `fetchInfo.data.trans_api` 为 null | `getModule` 先 `await getHash` 才返回 SCENARIO | 只影响机翻；`#auto=off` 亦可复现残留 |
| 自有 LLM / 彩云 / `showAiTransHint` 造成残留 | `autoTrans` 仅在 `#auto=on` 且无预生成译文时走；`aiTransHint` 是独立 DOM，有完整 `add/remove('hide')` 与 5s 自动隐藏 | custom-llm 分支未改这两个文件；机制上与浮层无关 |
| CSS `mix-blend-mode` / 缩放让空白浮层「看起来像残留」 | 可见内容完全由 `textContent` 决定 | 探针 `len` 可区分，属视觉误判 |
| `set: originalDescriptor.set` 在 getter-only 时写为 undefined | 原描述符本就无 setter | 无证据影响读取路径 |
| WeakMap 引用比较导致「同一对象改字段」不触发 | 需游戏原地复用同一 track 对象 | 后果是译文不刷新而非残留；列为 C1 观测项 |

---

## 3. 本次修复范围与例外判定

**纳入（P0）**：A1、A2、A3。

**按用户允许的例外纳入**：
- **A4（P1）**：与 A1/A2 同一根因（清理分支的状态处理）、同类触发（`end` track）；若不把三个并列 `if` 改为互斥，跳过恰好产生 `end + text` 时 P0 修复失效。
- **A7（P1）**：A1 的直接依赖。修 A1 后 `handleTrackChange` 会在 `storyMap` 为 null 的路径上继续执行清理，若不补齐 `setStoryMap(null, null)`，`commMap=undefined` 的既有隐患会变成真实 TypeError，破坏 P0 修复效果。

**明确不处理**：A5、A6（P1）、A8、A9（P2）。理由：均不阻塞「残留」这一 P0 现象的修复；A5 的迟到回调只更新数据、不会主动重绘浮层，不会使 P0 修复失效；A6 影响的是译文命中而非清理生命周期；A8/A9 需真机数据。

**预期变化清单（仅 P0 相关，其余行为必须保持一致）**：
1. `!newValue` / `label==='end'` / `textFrame==='off'` 现在无论 `storyMap` 是否就绪都会清理；
2. 清理会 `clearInterval` 取消打字机、清空 `textContent` 并加回 `.hide`；
3. `end` 且同时带 `text` 时不再被写回；
4. `transCover=on` 时，每次剧情资源 `load` 开始先收起上一场景浮层；
5. `setStoryMap(null)` 补齐第二参数为 `null`。

---

## 4. 修复方案（实际改动）

| 文件 | 改动 |
|---|---|
| `src/utils/transCoverHtml.js` | 新增命名导出 `hideTransCover()`：`getElementById` 取不到节点时直接返回；否则复用 `transCover('')` 取消 timer / 清空文本，再 `classList.add('hide')`。默认导出与原有 `insertHtml`、`transCover`、定位逻辑、CSS 均不改 |
| `src/modules/story/trackStory.js` | import `hideTransCover`；`handleTrackChange` 把清理判定前置到 `!storyMap` 之前，清理分支互斥并 `return`；保留 `newStory` 只在 `end` 时重置的原语义；显示分支、`setStoryMap`、`start()` 的 getter 包装与 WeakMap 逻辑不动 |
| `src/modules/story.js` | **具名导入** `{ hideTransCover }`（PR #1 review 修正：原先误写为默认导入，实际绑定到 `transCover`，详见第 8 节）；`load` 开头 `setStoryMap(null)` → `setStoryMap(null, null)`，并在 `transCover=on` 时调用 `hideTransCover()`；其余翻译层级、机翻、剧情提取逻辑不动 |
| `dist/ShinyColors.user.js` | 重新构建产物，与源码保持同步（review 修正后再次重建） |
| `script/verify-transcover-bindings.js` | 新增：保留真实 import/export 绑定语义的回归测试，防止默认/具名导入错位复发；运行 `node script/verify-transcover-bindings.js` |

**刻意不改**：`src/utils/index.js`（`typewriterEffect` 原样复用，避免扩大影响面）、`src/store/*`、`src/utils/translation.js`、`src/utils/myLLM.js`、`src/config.js`、`script/build.js`（脚本元数据头不变）。

---

## 5. 验证计划

| # | 步骤 | 判定标准 |
|---|---|---|
| V1 | `git diff` 审查 | 仅上述 3 个源文件 + dist 变更；无新增依赖、无配置/元数据改动 |
| V2 | 依赖安装 + `pnpm build` | 构建成功，无报错；`dist/ShinyColors.user.js` 时间戳更新 |
| V3 | 产物元数据头对比（修复前 dist 基线 vs 修复后） | `@name` / `@namespace` / `@version` / `@description` / `@match` / `@run-at` / 全部 `@grant` / 全部 `@connect` 逐行一致 |
| V4 | 源码 A/B 行为对比脚本（真实源码文本注入 mock 依赖，在 Node `vm` 中执行） | 非 P0 场景的显示内容序列与清理序列与修复前一致；P0 场景由「残留」变为「清空」。**局限（review 指出）**：脚本剥离 import 并注入同名 mock，覆盖不到 import/export 绑定错误，需由 V8 补足 |
| V5 | 非双语模式回归 | `transCover=off` 时 `hideTransCover()` 因浮层节点不存在而立即返回，零副作用；机翻 / LLM / 资源 hook / 菜单 / 数据源路径未改 |
| V6 | 兼容性静态核对 | 未引入新依赖、新浏览器 API、新全局；语法仍在既有 babel targets（`last 2 iOS versions`）内；构建通过即证明可编译 |
| V7 | 真机验证（待执行，需游戏环境） | 按 C1–C9 在游戏内复现「跳过」并观察浮层；本轮不执行，结论中标注 |
| V8 | **import/export 绑定回归测试**（PR #1 review 后新增） | `node script/verify-transcover-bindings.js`：从真实源码解析 export 建立绑定、按真实 import 语句解析绑定名，调用「实际绑定到的函数」验证 load 清理；注入错误绑定时必须被判失败（自证有效性）；并核对 dist 中清理函数的调用点 |

---

## 6. 验证步骤与结论

**验证环境**：Windows / Node `v22.22.2` / npm `10.9.7` / `corepack pnpm 12.21.0`；lockfile 为 `lockfileVersion: '9.0'`，使用 `--frozen-lockfile` 安装，未修改 `pnpm-lock.yaml` 与 `package.json`。

**可复现步骤**（工作区根目录）：

```bash
# 1) 保存修复前基线（HEAD 仍为 727e778，未提交）
mkdir -p /tmp/transcover-verify/before
for f in src/utils/transCoverHtml.js src/modules/story/trackStory.js \
         src/modules/story.js src/utils/index.js; do
  git show "HEAD:$f" > "/tmp/transcover-verify/before/$(echo $f | tr '/' '_')"
done
git show HEAD:dist/ShinyColors.user.js > /tmp/transcover-verify/before/ShinyColors.user.js

# 2) 安装依赖并重建产物
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm build

# 3) 产物语法与元数据核对
node --check dist/ShinyColors.user.js
sed -n '1,/==\/UserScript==/p' dist/ShinyColors.user.js   # 与 before 基线逐行 diff

# 4) 源码 A/B 行为对比 + 静态核对（临时基线脚本）
node "C:/Users/Administrator/AppData/Local/Temp/transcover-verify/verify.js"

# 5) import/export 绑定回归测试（随仓库提交，可长期运行）
node script/verify-transcover-bindings.js

# 6) 变更范围审查
git diff --stat && git status -sb
```

验证脚本（临时目录，随文档记录以便复现）：`C:/Users/Administrator/AppData/Local/Temp/transcover-verify/verify.js`，基线文件在同目录 `before/`。脚本用 Node `vm` 加载**真实源码文本**（去掉 import/export 后注入 mock 的 DOM、`typewriterEffect`、`getTextTrans`、`uniqueStoryId`），对修复前 / 修复后各跑一遍相同事件序列，比对浮层文本、class、DOM 是否存在、显示调用序列与 `clearInterval` 次数。

### 逐项结果

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| V1 | 变更范围审查 | **通过** | 首次验证时仅 `src/modules/story.js`、`src/modules/story/trackStory.js`、`src/utils/transCoverHtml.js`、`dist/ShinyColors.user.js` 与本文档变更；PR review 修正后另新增 `script/verify-transcover-bindings.js`（纯测试脚本，不参与运行时打包）。`package.json`、`pnpm-lock.yaml`、`script/build.js`、`src/config.js`、`src/utils/index.js`、`src/utils/translation.js`、`src/utils/myLLM.js`、`src/store/*` 的 `git diff` 均为空 |
| V2 | 依赖安装 + 构建 | **通过** | `corepack pnpm build` 退出码 0，`created ./dist/ShinyColors.user.js in 3.6s`；仅有一条 caniuse-lite 数据过期的提示（构建前即存在，非本次引入）；产物 111669 → 112192 字节 |
| V3 | 产物元数据头 | **通过** | 修复前 / 后 `// ==UserScript==` 至 `// ==/UserScript==` 共 18 行 `diff` 完全一致：`@name`、`@namespace`、`@version 1.13.0`、`@description`、`@match`、`@run-at`、3 个 `@grant`、4 个 `@connect`、`@supportURL` 均未变 |
| V4 | 源码 A/B 行为对比 | **通过（有局限）** | 13 个场景：8 个「非 P0」场景修复前后最终状态（文本 / class / DOM 存在性 / 显示序列 / timer 取消次数）**逐字段完全一致**；5 个「P0」场景全部由 `text="你好"` 残留变为 `text=""` + `cls="hide"`，且 `clearInterval` 由 0 次变为 1 次。**该脚本剥离 import 并注入同名 mock，无法覆盖导入绑定错误**（PR #1 review 因此发现 D1，见第 8 节），已由 V8 补足 |
| V5 | 非双语模式回归 | **通过** | 场景 N6：浮层节点不存在时 `hideTransCover()` 立即返回，`exists=false`、`text=""`、`shows=""`、无 timer 操作，与修复前一致；机翻 / LLM / 资源 hook / 菜单 / 数据源相关文件均无改动 |
| V6 | 兼容性静态核对 | **通过** | `node --check dist/ShinyColors.user.js` 通过；10 项静态核对全通过（`src/utils/index.js` 忽略 CRLF 后逐字节一致、`package.json` 三方 import 集合不变、新增相对 import 仅指向既有模块 `transCoverHtml`、清理判定前置、清理分支互斥、`add('hide')` 已落地等）；产物中 `add("hide")` 由 1 处（`aiTransHint`）变为 2 处（新增浮层清理），证明新逻辑已进入 dist 且未动原提示条 |
| V7 | 真机（游戏内）验证 | **待执行** | 本环境无游戏页面，未做浏览器实测；按第 7 节 C1–C9 在游戏内复现「跳过」后观察浮层，属后续必做项 |
| V8 | import/export 绑定回归（review 后新增） | **通过** | `node script/verify-transcover-bindings.js` 共 13 项、失败 0 项：真实 export 绑定（`default=transCover`、`named.hideTransCover`）、`story.js` 具名导入、`trackStory.js` 具名导入、load 清理后 `text=""` + `.hide` + timer 取消 + 无 typewriter 类型错误；注入「默认导入」错误绑定时测试判失败并复现 `Typewriter Error: text must be a string.`（自证有效）；dist 中清理函数 `Ui` 在 track 与 load 两处被调用，显示函数 `Bi` 无无参调用 |

### 非 P0 场景一致性明细（V4）

| 场景 | 修复前 → 修复后 | 结论 |
|---|---|---|
| N1 正常播放第一句 | `你好 / cls=""` → 同 | 一致 |
| N2 连续两句覆盖 | `再见 / shows=你好\|再见 / clears=1` → 同 | 一致 |
| N3 storyMap 未就绪时收到 text | 不显示、DOM 不创建 → 同 | 一致 |
| N4 查不到译文（空串） | 清空文本、`cls=""` → 同 | 一致 |
| N5 普通无 text track（等待/镜头） | 保持上一句译文 → 同 | 一致，**刻意保留**（若把无 text 一律当清理会改变正常播放行为） |
| N6 未开启双语时调用清理 | 无副作用 → 同 | 一致 |
| N7 end 之后进入新场景 | 仍能显示 `你好`、`shows=你好\|\|你好` → 同 | 一致，证明加回 `.hide` 不会卡住后续显示 |
| N8 `textFrame=off` 清理后下一句 | 仍显示 `再见` → 同 | 一致 |

### P0 场景修复明细（V4）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| P1 显示中 load 开始（跳过→新场景加载） | 残留 `你好`，无 timer 取消 | `text=""` + `cls="hide"`，timer 取消 1 次 |
| P2 显示中收到 null track | 残留 `你好` | 已清空并隐藏 |
| P3 storyMap 被清空后收到 end track（A1） | 残留 `你好` | 已清空并隐藏 |
| P4 end track 同时带 text（A4 例外） | 清空后又被写回 `你好` | 已清空并隐藏 |
| P5 打字机进行中被清理（A3） | 残留且 timer 未取消 | 已清空、隐藏、timer 取消 |

### 结论

1. **P0 已修复**：A1 / A2 / A3 覆盖的可静态判定清理信号（load 开始、`!newValue`、`label==='end'`、`textFrame==='off'`）全部生效；打字机 timer 被取消，浮层真正隐藏；A4、A7 作为例外同批处理，未引入 TypeError 回归。
2. **一致性成立**：除第 3 节「预期变化清单」列出的 5 项 P0 相关行为外，8 个非 P0 场景的输出、显示序列、DOM 状态、timer 操作与修复前逐字段一致；元数据头、脚本权限、翻译层级、LLM 兜底、菜单、数据源、构建配置均未改变，兼容性通过语法检查与依赖核对。
3. **明确的残留边界（重要，未掩盖）**：若游戏「跳过」后**既不触发新的 `load`、getter 也不再被读取**，且产生的是既非 `end`/`off`、又无 `text` 的普通 track，则本次没有可用的清理信号，浮层仍可能残留。这是刻意不扩大改动范围的取舍——把「无 text 的 track」一律视为场景结束会破坏 N5 所示的正常播放行为。该边界必须由 V7 真机实测按 C1 确认；若确实存在，需引入可靠的场景结束信号（属于新方案，不在本次 P0 范围内）。
4. **未处理项保持原状**：A5、A6（P1）、A8、A9（P2）未改动，理由见第 3 节；其现象与风险仍按第 2 节清单跟踪。
5. **PR review 后补充**：首次提交的 V4 验证存在「剥离 import 注入同名 mock」的盲区，未能发现 `story.js` 的默认导入绑定错误（D1）。该缺陷已在第 8 节修复并新增 V8 绑定回归测试复核通过；V4/V5/V6 复核仍为 0 失败，产物元数据头保持一致。

---

## 7. 假设与待确认项

- **假设 A1（成立）**：用户能看到译文 → `start()` 已成功 hook getter，`box instanceof HTMLElement` 通过。
- **假设 A2（待验证）**：跳过不产生 `label === 'end'` 的 track，或直接销毁实例。决定 A1/A2 哪个占主导，但修复点相同。
- **C1** 跳过后 `currentTrack` 的实际值序列（null / 新实例 / 非 end track）——需 dev 模式 `Track changed!` + `New Value` 日志。**特别地**：若跳过直接返回「无新 `load`、无 getter 读取」的界面，本次新增的 load 信号与 track 信号都不会触发，该边界仍需 C1 实测确认。
- **C2** `end` track 是否同时带 `text`——决定 A4 是否真实存在（已按例外预防性处理）。
- **C3** 游戏是否严格按剧情 JSON 顺序产生 track——决定 A9。
- **C4** `#auto=off` 下能否复现——用于彻底排除机翻链路。
- **C5** 跳过按钮与浮层矩形是否重叠——决定 A8。
- **C6** 游戏是否 `await scnModule.load` 的返回值——决定 A5 时序模型。
- **C7**（PR #1 review 提出）`label === 'end'` 且同时带 `text` 时，修复后隐藏并直接返回；若真实游戏把结束标记放在最后一句台词上，可能丢失该句双语译文——需真实 track 样本确认。
- **C8**（PR #1 review 提出）`textFrame === 'off'` 且带 `text` 时，修复后不再调用 `getTextTrans` / `uniqueStoryId`；若该 track 仍占译文表一行重复编号，可能使后续同 ID 台词错位——需游戏样本确认。
- **C9**（PR #1 review 提出）load 清理位于 `await originLoad(...)` 之后而非函数入口；需验证真实游戏在 load 返回前后的 track 读取时序，以及同一演出内重复加载匹配资源时是否会误隐藏。
- **环境限制**：游戏内部代码未开源，C1–C9 无法静态判定；验证以源码 A/B 对比、绑定回归、构建产物核对和差异审查为主，真机实测列为 V7。

---

## 8. PR #1 review 缺陷修复记录

**来源**：PR [#1](https://github.com/SaigyoujiJ/ShinyColors/pull/1) 的 owner review（审查提交 `682ebc3`，2026-11-23），由 Cursor cloud agent 做隔离运行时验证后提出；未运行真实游戏。

### D1（高 / 确定缺陷）`story.js` 默认导入绑定错误

- **现象**：`src/modules/story.js` 写的是 `import hideTransCover from '../utils/transCoverHtml'`，但 `transCoverHtml.js` 的**默认导出是 `transCover`**、`hideTransCover` 是具名导出。因此 load 钩子里的 `hideTransCover()` 实际执行 `transCover(undefined)`。
- **触发条件**：`config.transCover === 'on'` 且 `scnModule.load` 命中剧情 JSON 路径；不需要点击跳过即可触发。
- **影响范围**：load 侧新增的清理路径完全失效——不清空译文、不取消打字机 timer、不加 `.hide`；`transCover()` 还会 `remove('hide')` 把已隐藏的浮层重新显示；`typewriterEffect` 类型检查失败后返回 rejected Promise，每次触发都有 `Typewriter Error: text must be a string.` 与未处理 rejection。错误绑定同时存在于已提交的 dist 产物中。
- **为什么 V4 没发现**：V4 脚本会剥离 import 并注入同名 mock，等于假设绑定正确，天然覆盖不到导入形式错误。
- **修复**：`src/modules/story.js:12` 改为具名导入 `import { hideTransCover } from '../utils/transCoverHtml'`；重新执行 `corepack pnpm build` 重建 `dist/ShinyColors.user.js`。
- **回归测试**：新增 `script/verify-transcover-bindings.js`（V8）。它从真实源码解析 `export default` / `export { ... }` 建立绑定，按真实 import 语句解析绑定名，再调用「实际绑定到的那个函数」验证 load 清理；并故意注入错误绑定自证测试有效性。

### review 提出的待验证风险（未作为确定缺陷，本次不改动逻辑）

| 编号 | 风险 | 本次处置 |
|---|---|---|
| R1 / C7 | `label === 'end'` 且带 `text` 时隐藏并 return，若游戏把结束标记放在最后一句台词上，可能丢失该句译文 | 记录待确认，未改动逻辑（改动需真实 track 样本，避免引入新回归） |
| R2 / C8 | `textFrame === 'off'` 且带 `text` 时不再调用 `getTextTrans` / `uniqueStoryId`，可能使后续同 ID 台词错位 | 记录待确认，未改动逻辑 |
| R3 / C9 | load 清理位于 `await originLoad(...)` 之后；需验证 load 返回前后的 track 时序与同一演出内重复加载是否误隐藏 | 记录待确认，未改动逻辑 |

### 复核结果（修复后重新执行）

| 检查 | 结果 |
|---|---|
| `node script/verify-transcover-bindings.js`（V8，13 项） | 失败 0 项；load 清理由「残留 `你好`」变为 `text=""` + `cls="hide"` + timer 取消 1 次、无类型错误；错误绑定注入时判失败并复现 `Typewriter Error: text must be a string.` |
| 原 V4 / V5 / V6（13 场景 + 10 项静态核对） | 失败 0 项，结论不变 |
| `corepack pnpm build` / `node --check dist` | 退出码 0 / 语法通过 |
| 产物元数据头 18 行 | 与修复前基线逐行一致 |
| dist 绑定核对 | 清理函数 `Ui` 在 `handleTrackChange` 与 load 钩子两处被调用；显示函数 `Bi` 无无参调用（无 `transCover(undefined)`） |
| `add("hide")` 出现次数 | 2 处（`aiTransHint` + 新增浮层清理），与预期一致 |

**结论**：D1 已修复并通过 V8 回归覆盖；除「load 清理实际生效」这一 P0 相关行为外，其余功能、输出、交互与兼容性复核结论与第 6 节一致。R1–R3 仍需真机 track 样本确认，未擅自改动。
