# Tech Debt Audit — image-flow
Generated: 2026-06-08 · 范围：全仓（src/ ~2100 LOC）

> **2026-06-08 复盘修复**：处于测试阶段、无历史包袱，已修复全部 F001–F022（详见下方 Findings 表的 RESOLVED 标记）。补充：新增 `src/images.ts`（图片类型单一来源）、`src/paths.ts`（路径取名统一）、`src/test/logic.test.ts`（13 项纯逻辑测试，全过）。删除一次性迁移代码 `migrateLegacySettings`。补测试时抓出并修掉一个真 bug——尖括号正则对含半角括号路径会提前截断（见 F009）。`npm run compile` 与 `npm test` 均绿。

## 执行摘要（按影响排序）

1. **README 几乎全篇过时**，与当前实现矛盾：仍宣称「仅同步 json、未接入 async」（实际早已异步轮询）、「apiKey 明文存设置」（实际存 secrets）、「在设置里搜 image-flow 填值」（配置已全迁到侧栏 Webview）。这是新用户的第一入口，误导性极强。（README.md:32,38-39 等）
2. **新「右键插入引用」与 buildPrompt 解析互不兼容**：插入功能对含空格/半角括号的路径会包成 `![alt](<path>)`，但 `buildPrompt` 的正则 `[^)]+` 解析不了尖括号形式，会把这类参考图判为「读取失败」并中断生成。两个特性各自正确，组合起来产生坏数据。（command.ts:29 ↔ sidebarProvider.ts）
3. **核心逻辑零真实测试**：`src/test/` 只有脚手架占位测试。`buildPrompt`、相对路径换算、API 响应解析、任务轮询状态机这些高频改动、易错的纯逻辑全无覆盖。（extension.test.ts）
4. **外部 API 响应无校验**：`response.json() as GenerateResponse` 在信任边界直接断言，字段缺失/类型不符不会被发现，只会在后续使用处以隐晦方式炸开。（api.ts:95,116）
5. **网络请求无超时**：`submitGeneration` / `queryResult` / `downloadImages` 的 fetch 均无 timeout。一个挂住的连接会卡住整个轮询锁（`polling` 串行），拖累所有任务，只能等 10 分钟 `TASK_TIMEOUT` 兜底。（api.ts:86,113；command.ts:117）
6. **图片扩展名白名单有两份**：`MIME_BY_EXT`（command.ts:8）与 `IMAGE_EXTS`（materials.ts:9）各定义一份，必须手动保持同步，迟早漂移。
7. **重启续拉依赖侧栏被打开**：`activationEvents` 为空，用户重启后若不展开侧栏，未完成任务永不续拉。代码注释已点明，但仍是真实功能缺口。（extension.ts:14）
8. **从路径取名字有三种写法**：`baseName`、`mdBaseName`、`listLibraries` 内联各一套 `split('/')`/`path.basename`，行为略有差异。（sidebarProvider.ts:115；command.ts:85；materials.ts:88）
9. 整体安全卫生良好：apiKey 走 secrets、预览不泄露 key、有目录扫描的深度与条目上限防卡死。无硬编码密钥、无 SQL 拼接。
10. 架构清晰：无循环依赖（madge 确认），shared.ts 单点定义协议，两套构建产物职责分明。债务集中在文档与测试，不在结构。

## 架构心智模型

这是一个 VS Code 扩展，在编辑器内把 Markdown 正文当提示词调 Grsai 绘图 API。两条独立构建产物：`dist/extension.js`（主进程，esbuild 打包 `src/extension.ts`）和 `media/sidebar.js`（Webview 前端，React，打包 `src/webview/index.tsx`）；`out/` 仅供测试。

主进程分层清晰：`extension.ts`（激活/注册）→ `SidebarProvider`（Webview 宿主、消息路由、Uri→webview src 转换）→ 业务模块 `tasks.ts`（异步提交+轮询+持久化+续拉的状态机）、`command.ts`（Markdown 解析、参考图、下载、历史扫描）、`api.ts`（HTTP 封装+请求体构造）、`materials.ts`（素材库扫描）、`config.ts`（secrets+globalState 配置）。`shared.ts` 是前后端共享的类型与消息协议唯一定义处。前端 `App.tsx` 用 postMessage 与主进程通信，三个标签页（工作台/任务/设置）。

这个心智模型与代码一致。但**与 README 严重矛盾**——README 描述的是几个版本之前的同步、settings 驱动的形态。CLAUDE.md 则是准确的，明显是后来按实现重写过。

## Findings

| ID | Status | Category | File:Line | Severity | Description | 修复方式 |
|----|--------|----------|-----------|----------|-------------|----------|
| F001 | ✅RESOLVED | 文档漂移 | README.md | High | 「已知限制」称仅同步未接入 async | 重写：改述异步提交+轮询+续拉 |
| F002 | ✅RESOLVED | 文档漂移 | README.md | High | 称 apiKey 明文存设置 | 改为「加密存于 secrets」 |
| F003 | ✅RESOLVED | 文档漂移 | README.md | High | 使用步骤仍写 settings 填值 | 按 Webview 侧栏流程重写 |
| F004 | ✅RESOLVED | 文档漂移 | README.md | Medium | 命令名「预览替换后的提示词」过时 | 同步为「预览请求」 |
| F005 | ✅RESOLVED | 类型契约 | api.ts:95 | High | 响应裸 as 断言无校验 | 加 parseGenerateResponse 字段校验 |
| F006 | ✅RESOLVED | 类型契约 | api.ts:116 | High | queryResult 同样裸断言 | 同上复用 parseGenerateResponse |
| F007 | ✅RESOLVED | 性能/资源 | api.ts | High | fetch 无超时 | 加 fetchWithTimeout（AbortController 30s） |
| F008 | ✅RESOLVED | 性能/资源 | command.ts | High | 下载 fetch 无超时 | downloadImages 改用 fetchWithTimeout |
| F009 | ✅RESOLVED | 功能缺口 | command.ts | High | 正则解析不了插入端的尖括号路径 | 双捕获组正则；补测试抓出半角括号截断 bug 并修 |
| F010 | ✅RESOLVED | 测试 | src/test | High | 核心纯逻辑零覆盖 | 新增 logic.test.ts，13 项全过 |
| F011 | ✅RESOLVED | 一致性 | command.ts/materials.ts | Medium | 图片扩展名白名单两份 | 抽到 src/images.ts 单一来源 |
| F012 | ✅RESOLVED | 一致性 | 三处 basename | Medium | 取名各写一套 | 抽到 src/paths.ts |
| F013 | ✅RESOLVED | 架构 | sidebarProvider.ts | Medium | localResourceRoots 重复构造 | resolveWebviewView 复用 buildResourceRoots |
| F014 | ✅RESOLVED | 功能缺口 | extension.ts | Medium | 不展开侧栏则不续拉 | activationEvents 补 onStartupFinished |
| F015 | ✅RESOLVED | 错误处理 | tasks.ts | Medium | catch 吞所有错误当瞬时网络错误 | isTransientNetworkError 区分，非瞬时标 failed |
| F016 | ✅RESOLVED | 一致性 | command.ts:122 | Low | URL 取扩展名手法不一 | 统一并经白名单校验 |
| F017 | ✅RESOLVED | 健壮性 | command.ts:122 | Low | URL 扩展名不校验 | isImageExt 校验，非白名单回退 png |
| F018 | ✅RESOLVED | 一致性 | api.ts:33 | Low | 对象字面量当集合判断 | 改 ['1K','2K','4K'].includes |
| F019 | ✅RESOLVED | 死代码 | command.ts | Low | 末尾残留空行 | 删除 |
| F020 | ✅RESOLVED | 健壮性 | materials.ts | Low | 单层/递归扫描计数口径不一 | scanDirImages 改按遍历条目计数 |
| F021 | ✅RESOLVED | 一致性 | tasks.ts | Low | nowMs 平凡包装 | 删除，直接用 Date.now() |
| F022 | ✅RESOLVED | 文档 | README.md | Low | 已知限制整节失效 | 重写为当前真实限制 |

> 注：knip 报「18 个文件全 unused / react 等 devDep unused」与 depcheck 报「missing vscode」均为**误报**——前者因未配 Webview/extension 双入口，后者因 vscode 由宿主注入。madge 确认无循环依赖。npm audit 因仓库走 npmmirror 镜像（不支持 advisory 端点）无法执行，CVE 未覆盖，建议在能连 npm 官方源的环境补跑一次。

## Top 5 — 只修这些也值

### 1. F001-F004：重写 README（S）
README 是错的，且错得有误导性。最小修法——把「已知限制」「扩展设置」「使用步骤」三节按当前实现重写：

```
- 仅支持 replyType: json 同步返回模式（未接入 async）   ← 删，已是 async
- apiKey 以明文形式存储在 VS Code 设置中                ← 改：存于加密 secrets
- 打开设置搜 image-flow 填 apiKey                       ← 改：点活动栏图标，在侧栏「设置」页填
```

### 2. F009：插入功能与解析器的链接格式契约（M）
`insertImageRef` 对含空格/括号的路径产出 `![alt](<rel>)`，但 `buildPrompt` 的 `[^)]+` 读不了尖括号，这类参考图会被判「读取失败」中断生成。两端要么都支持尖括号，要么都不用。建议改 `buildPrompt` 正则兼容：

```ts
// 兼容 ![alt](<path with space>) 与 ![alt](path)
const imageRegex = /!\[[^\]]*\]\(\s*<?([^)>]+)>?\s*\)/g;
```
并在取值后 trim。这样插入端的尖括号能被正确解析为参考图。

### 3. F005-F006：API 响应校验（S）
信任边界裸 `as` 断言。加一个轻量守卫即可，不必上 schema 库：

```ts
function asGenerateResponse(d: unknown): GenerateResponse {
  if (!d || typeof d !== 'object' || !('status' in d)) {
    throw new Error('接口返回格式异常');
  }
  return d as GenerateResponse;
}
```

### 4. F007-F008：fetch 超时（M）
三处 fetch 全裸奔。挂起的 result 查询会占住 `polling` 串行锁，拖垮所有任务直到 10 分钟超时。封装一个带 AbortController 的 fetch：

```ts
async function fetchWithTimeout(url: string, init: RequestInit, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
```

### 5. F010：给纯逻辑补测试（L）
`buildPrompt`（去重编号、替换、失败收集）、`toVipPixels`（边界回退）、`queryResult`（succeeded 但无 urls 的降级）都是纯函数且易回归。优先这三个，不需要起 VS Code 实例——抽到不依赖 vscode 模块的位置或用依赖注入即可单测。

## Quick wins（低成本 × 中等以上收益）

- [ ] F001-F004：重写 README 三节（事实性错误）
- [ ] F005-F006：API 响应加最小字段校验
- [ ] F011：图片扩展名白名单合并为一份
- [ ] F012：basename 取值统一到一个 helper
- [ ] F013：resolveWebviewView 复用 buildResourceRoots
- [ ] F014：activationEvents 补 onStartupFinished
- [ ] F019：删 command.ts 末尾残留空行

## 看着像问题、其实没问题

- **`tasks.ts` 的 `polling` 串行重入锁**：单看像是性能瓶颈（轮询被串行化）。但注释 tasks.ts:28 说清了——同一任务多 job 共享 `images.length` 接续编号下载，两轮并发会下成同名图互相覆盖。这是正确性约束，不是偷懒。别改成并发。（不过 F007/F008 的超时仍要加，否则一个慢请求会放大这个锁的代价。）
- **`resume()` 把所有 task.createdAt 重置为当前时间**（tasks.ts:130）：看着像丢失原始创建时间的 bug。实则有意——超时要按「本次会话起算」，否则关机超 10 分钟的可恢复任务会被误判超时丢弃。注释已说明，合理。
- **`emit()` 里 `void Promise.resolve().then(fn).catch(()=>{})`**（tasks.ts:59-63）：吞异常看着可疑。但监听器是侧栏的 async 扫盘回调，吞掉 reject 是为了防 unhandledRejection，且这些刷新失败不该影响任务状态机。可接受。
- **`migrateLegacySettings` 仍读已从 package.json 移除的旧配置**（config.ts:60）：审计时判为有意保留（一次性迁移老用户数据）。**但本轮已删除**——用户确认处于测试阶段、无线上老用户，迁移逻辑无意义，属可清理的死代码。
- **God file 判断**：最大文件 sidebarProvider.ts 仅 376 行，无一超 500 LOC 阈值。没有 god file，不强凑这条。
- **`as` 类型断言**：除 F005/F006 的 API 边界外，其余 `as`（如 webview 的 CSS 变量 `['--thumb-size' as string]`）都是 TS 表达 CSS 自定义属性的标准写法，非债务。

## Open questions（无法判断是债还是有意为之）

1. **下载图片的扩展名取自 URL**（command.ts:122）：是否遇到过 Grsai 返回带查询串或无扩展名的 URL？若返回稳定带扩展名，当前写法够用；若不稳定，F017 值得修。
2. **`MAX_DEPTH=3` / `MAX_ENTRIES=500`**（materials.ts:12,15）：这两个上限是测出来的经验值还是拍的？素材库很大的用户会不会撞上 500 上限导致图片不全且无提示？
3. **自动素材库不含工作区根目录那一层**（materials.ts 注释）：是有意排除（根目录图片太杂）还是疏漏？
4. **`gpt-image-2`（非 vip）传 imageSize 吗**：applySizeFields(api.ts:46) 对 gpt-image-2 只传 aspectRatio 不传 imageSize，README 说「忽略分辨率」。这是接口要求还是约定？文档(docs/grsai-api.md)需对照确认。
5. **测试运行依赖 `out/`**：是否有意保留 vscode-test 流程，还是已转向不依赖 VS Code 实例的纯逻辑测试方向？这决定 F010 该怎么落地。

## Assessment

**整体**：结构健康，无循环依赖、分层清晰、安全卫生到位、关键正确性约束都有注释护栏。债务**不在架构，在文档与测试**——README 是错的且误导，核心逻辑零测试，外部边界无校验。新加的「右键插入引用」与既有解析器存在一个真实的链接格式契约冲突（F009），应优先处理。Top 5 全部完成预计 1-2 天，无需任何重写。

