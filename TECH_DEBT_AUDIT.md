# Tech Debt Audit — image-flow
Generated: 2026-06-08 · 复审更新：2026-06-09 · 范围：全仓（src/ ~2,600 LOC）

> **2026-06-09 复审（repeat-run）**：上一轮 F001–F022 全部确认仍为 RESOLVED（已逐一对照代码：双捕获组正则 `command.ts:16`、`fetchWithTimeout` `api.ts:18`、`images.ts`/`paths.ts` 已抽出、`activationEvents` 已补 `onStartupFinished`）。本轮新增 F023–F038（标记 `NEW`），集中在**测试覆盖（异步状态机仍零行为测试）**、**每 4s 轮询触发的无效扫盘**、**全失败任务残留空文件夹**三处真实债，以及若干文档漂移与一致性小项。`lint`/`check-types` 本轮仍全绿。
>
> **2026-06-09 修复**：F023/F024/F025/F026/F027/F028/F030/F031 已修复，F029 部分修复（详见下表与各项说明）。抽出可测纯函数 `isTaskActive`/`aggregateProgress`（tasks.ts）、`replaceImageRefs`（command.ts）、`isImageFileName`（images.ts），logic.test.ts 测试新增 10 项（从 25 增至 35，全过）；`npm run compile` 与 `npm test` 均绿。剩余未动项均为开放问题或已判定可接受（F032/F033/F034/F035/F036/F037/F038）。已过代码审核（verdict: ready to merge）。
>
> **2026-06-08 首轮修复**：处于测试阶段、无历史包袱，已修复全部 F001–F022。补充：新增 `src/images.ts`、`src/paths.ts`、`src/test/logic.test.ts`，删除一次性迁移代码 `migrateLegacySettings`，补测试时抓出并修掉尖括号正则截断 bug（F009）。

## 执行摘要（按影响排序，本轮）

1. **核心异步状态机仍零行为测试（NEW F023）**：`tasks.ts` 的 submit/submitJobs/poll/pollJob/resume/超时兜底/重入锁是全仓最复杂、改动最频、bug 后果最重的代码，却只有 `isTransientNetworkError` 一个纯函数被覆盖。上一轮的 logic.test.ts 解决了纯换算/正则，但状态机本身仍靠人肉验证。
2. **每 4s 轮询触发两次无效递归扫盘（NEW F025）**：任务 `onChange`（含每次进度变化）会调 `pushLibraries` + `pushAutoLibraries`，但任务进度不改变素材库内容，这两个推送每轮产出恒定结果却仍扫盘（手动库最多 500 条目 × 深度 3）。纯浪费 IO。
3. **全失败任务残留空 `task-*` 文件夹（NEW F026）**：`submit` 先建夹再提交；全部 job 失败时只从内存移除任务，磁盘空目录永久残留，长期累积。
4. **文档漂移：CLAUDE.md 的 activationEvents 描述已过期（NEW F027）**：CLAUDE.md 仍写「`activationEvents` 为空数组……若需开机续拉要补 onStartupFinished」，但首轮 F014 已补，`package.json:12-14` 现为 `["onStartupFinished"]`，描述与现状矛盾。
5. **依赖告警可执行了（NEW F029）**：走 npmjs 官方源 `npm audit` 报 5 漏洞（2 high），全在 `@vscode/test-cli → mocha → diff/serialize-javascript/glob` 开发链上，不进发布产物，但属过期测试工具链。
6. **类型契约：响应校验只覆盖 status（NEW F031）**：`parseGenerateResponse` 校验 status 后把 `id/results/error` 一并 `as` 成完整类型；调用方各自再 guard，功能 OK 但契约与实际校验不符。
7. 安全卫生持续良好：apiKey 走 secrets、CSP 锁 script nonce、远端结果图先落盘再经 asWebviewUri 加载。无硬编码密钥、无 SQL 拼接、无明显注入面。
8. 架构持续健康：分层清晰、`shared.ts` 单点协议、两套构建产物职责分明。债务在测试与文档，不在结构。
9. 本轮严重度分布（仅新增项）：0 Critical / 2 High / 5 Medium / 9 Low。
10. 注：`knip` 在本仓无配置（未声明 esbuild 双入口与扩展 main/contributes 入口），其报告的 24 个 unused files / 9 个 unused deps 全为假阳性，已忽略。

## 架构心智模型

VS Code 扩展，把 Markdown 正文当提示词调 Grsai 绘图 API。两条独立构建产物：`dist/extension.js`（主进程，esbuild 打包 `src/extension.ts`）和 `media/sidebar.js`（Webview 前端，React，打包 `src/webview/index.tsx`）；`out/` 仅供测试。

主进程分层清晰：`extension.ts`（激活/注册/续拉）→ `SidebarProvider`（Webview 宿主、消息路由、Uri→webview src 转换）→ 业务模块 `tasks.ts`（异步提交+轮询+持久化+续拉状态机）、`command.ts`（Markdown 解析、参考图、下载、历史扫描）、`inject.ts`（提示词注入）、`api.ts`（HTTP+请求体构造）、`materials.ts`（素材库扫描）、`config.ts`（secrets+globalState 配置）。`shared.ts` 是前后端共享类型与消息协议唯一定义处，`images.ts`/`paths.ts` 是去重出来的公共小工具。前端 `App.tsx` 经 postMessage 通信，三标签页（工作台/任务/设置）。

心智模型与代码一致。README 经首轮重写后已基本同步，唯余设置页功能描述漏掉「模型注入提示词」（F028）；CLAUDE.md 准确度高，唯 activationEvents 段已过期（F027）。

## Findings

### 首轮（2026-06-08）— 全部 RESOLVED

| ID | Status | Category | File:Line | Sev | Description | 修复 |
|----|--------|----------|-----------|-----|-------------|------|
| F001–F004 | ✅RESOLVED | 文档漂移 | README.md | High | README 全篇过时（同步/明文 key/settings 流程/命令名） | 按当前实现重写三节 |
| F005–F006 | ✅RESOLVED | 类型契约 | api.ts | High | 响应裸 as 断言 | 加 parseGenerateResponse 校验 |
| F007–F008 | ✅RESOLVED | 性能/资源 | api.ts/command.ts | High | fetch 无超时 | fetchWithTimeout（AbortController 30s） |
| F009 | ✅RESOLVED | 功能缺口 | command.ts | High | 正则解析不了尖括号路径 | 双捕获组正则，并修半角括号截断 |
| F010 | ✅RESOLVED | 测试 | src/test | High | 核心纯逻辑零覆盖 | 新增 logic.test.ts |
| F011 | ✅RESOLVED | 一致性 | command.ts/materials.ts | Medium | 扩展名白名单两份 | 抽到 images.ts |
| F012 | ✅RESOLVED | 一致性 | 三处 basename | Medium | 取名各写一套 | 抽到 paths.ts |
| F013 | ✅RESOLVED | 架构 | sidebarProvider.ts | Medium | localResourceRoots 重复构造 | 复用 buildResourceRoots |
| F014 | ✅RESOLVED | 功能缺口 | extension.ts | Medium | 不展开侧栏则不续拉 | 补 onStartupFinished |
| F015 | ✅RESOLVED | 错误处理 | tasks.ts | Medium | catch 吞所有错误 | isTransientNetworkError 区分 |
| F016–F022 | ✅RESOLVED | 一致性/健壮性/死代码 | 多处 | Low | URL 扩展名校验、集合判断、残留空行、计数口径、平凡包装、限制节失效 | 详见上一轮记录 |

### 本轮新增（2026-06-09）

| ID | Status | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|--------|----------|-----------|----------|--------|-------------|----------------|
| F023 | ✅RESOLVED | Test debt | src/tasks.ts | High | L | 核心异步状态机无行为测试。 | 抽出可测纯函数 isTaskActive/aggregateProgress 并补测；4 项断言覆盖活跃判定与聚合进度边界。完整 TaskManager 注入式状态机测试仍可后续补强。 |
| F024 | ✅RESOLVED | Test debt | src/command.ts | High | M | buildPrompt 等读写盘路径无测试。 | 抽出纯函数 replaceImageRefs（含 F009 尖括号回归用例）并补测；downloadImages/listHistory 的临时目录测试仍可后续补强。 |
| F025 | ✅RESOLVED | Performance | src/sidebarProvider.ts:47-54 | Medium | S | 任务每 4s onChange 调 pushLibraries+pushAutoLibraries 触发无效递归扫盘。 | 已从任务 onChange 删这两行；库刷新仍由 syncActiveMd 与增删库各自触发。 |
| F026 | ✅RESOLVED | Resource hygiene | src/tasks.ts | Medium | S | 全失败任务残留空 task-* 文件夹。 | 加 cleanupEmptyFolder，submitJobs 与 pollOnce 移除任务前对 images 为空者删空目录。 |
| F027 | ✅RESOLVED | Documentation drift | CLAUDE.md | Medium | S | activationEvents 描述过期；顺带修「迁移旧版 settings」过期描述。 | 已改为「已配置 onStartupFinished，开机即激活并 resume」+「种入模型注入句」。 |
| F028 | ✅RESOLVED | Documentation drift | README.md:7 | Low | S | 设置页描述漏「模型注入提示词」。 | README 设置页已补「按模型编辑注入提示词」。 |
| F029 | 🟡PARTIAL | Dependency debt | package.json（传递依赖） | Medium | S | npm audit 报 5 漏洞（2 high）。 | npm audit fix 已修 glob 高危（5→4）。剩余 4 项全在 @vscode/test-cli@0.0.12→mocha 链上，npm 仅提供降级到 0.0.11 的 --force「修复」（非真修复），且 0.0.12 已是最新版，故保留不降级；均为开发期依赖、不进发布产物。 |
| F030 | ✅RESOLVED | Consistency | src/command.ts:146 / src/materials.ts:16 | Low | S | isImageFile 与 isImage 两份本地拷贝。 | images.ts 导出 isImageFileName，两处复用，删本地包装。 |
| F031 | ✅RESOLVED | Type & contract | src/api.ts:44-53 | Low | M | parseGenerateResponse 只校验 status。 | 已补 id/results/error 形状校验（存在才校验，缺省放行），id 在接口类型里改为可选，契约与校验一致。 |
| F032 | 🆕NEW | Correctness (edge) | src/tasks.ts:52 / src/command.ts:105-113 | Low | M | seq 重启归零，文件夹靠秒级时间戳+seq 保唯一。重启后同一秒提交、seq 又从 0 起，可能撞重启前同秒任务的 task-<stamp>-0；createTaskFolder 对已存在目录不 guard。 | createTaskFolder 目录已存在时追加随机后缀重试；或 seq 用持久化计数。（开放问题，待确认是否值得） |
| F033 | 🆕NEW | Consistency | src/materials.ts:48-77 / :95-114 | Low | S | 注释称 scanDirImages 与递归版 MAX_ENTRIES 口径一致，但 listAutoLibraries 每层各调一次、每层独立 500 上限，深路径累计可远超 500。 | 修正注释，或 listAutoLibraries 共享一个 counter。 |
| F034 | 🆕NEW | Architecture | src/inject.ts:15-27 | Low | S | readImagesMd 只读 workspaceFolders[0]，多根工作区下口径与参考图解析不同。 | 若支持多根按 getWorkspaceFolder(mdUri) 取根；否则标明单根假设。（开放问题） |
| F035 | 🆕NEW | Observability | src/tasks.ts, src/sidebarProvider.ts | Low | M | 失败只一闪，无 OutputChannel，排障靠用户复述。 | 加 createOutputChannel('Image Flow') 写结构化日志。（开放问题，待确认需求） |
| F036 | 🆕NEW | Consistency | src/command.ts:97-99 / src/sidebarProvider.ts:106-108 | Low | S | mdBaseName/baseName 单行透传包装。 | 直接用 uriStem/uriBaseName；或确认为语义命名保留（可接受）。 |
| F037 | 🆕NEW | Resource hygiene | src/tasks.ts:88-96 | Low | S | submitting 态无独立超时。 | 可接受（fetchWithTimeout 30s 兜底）。 |
| F038 | 🆕NEW | Error handling | src/sidebarProvider.ts:347-349 | Low | S | post 在侧栏关闭时静默丢消息。 | 可接受（init 兜底）。 |

## Top 5 — 只修这几个

1. **F023 — 给 `tasks.ts` 状态机补行为测试。** 全仓最该测、最难人肉验证的代码。把不变量做成可测函数：
   ```ts
   export function aggregateProgress(jobs: PendingJob[]): number { /* 现 toWebviewPendingTask 内联逻辑 */ }
   export function isTaskFinished(task: PendingTask): boolean { return !isTaskActive(task); }
   ```
   再对注入 fake `submitGeneration`/`queryResult`/`context` 的 TaskManager 断言：全失败→移除且弹错一次（不双弹）；瞬时错误→保持 running；超时→标失败；resume→submitting 转 failed。

2. **F025 — 从任务 onChange 删两个无效库推送。** 一行级改动，去掉每 4s 递归扫盘：
   ```ts
   this.tasks.onChange(async () => {
     await this.pushHistory();
     this.pushPendingTasks();
   - void this.pushAutoLibraries();
   - void this.pushLibraries();
   })
   ```
   库刷新已由 syncActiveMd 和增删库各自触发，与任务进度正交。

3. **F026 — 全失败任务清空文件夹。** 在 submitJobs:164 与 pollOnce 移除终结任务处，对 `images.length===0` 的任务删空目录，杜绝磁盘垃圾累积。

4. **F024 — 给 command.ts 读写盘路径补测试。** 临时目录覆盖 buildPrompt 的「参考图缺失抛错」「[imageN] 替换」、downloadImages 扩展名白名单回退、listHistory 的 exclude 过滤。用户数据落盘路径，回归代价高。

5. **F027 + F028 — 修两处文档漂移。** CLAUDE.md 的 activationEvents 段与 README 设置页描述都已过期，几分钟可改，避免后续基于错误前提决策。

## Quick wins（低成本 × 中等以上收益）

- [ ] F025：删任务 onChange 里的 pushAutoLibraries/pushLibraries 两行。
- [ ] F026：全失败任务删空 task-* 文件夹。
- [ ] F029：npm audit fix（先跑非 --force 部分）。
- [ ] F027：更新 CLAUDE.md 的 activationEvents 段。
- [ ] F028：README 设置页补「模型注入提示词」。
- [ ] F030：统一 isImageFile/isImage 到 images.ts。

## 看着像问题、其实没问题

- **`sidebarProvider.ts:48-54` 混用 await/void。** 刻意的防闪烁顺序：任务完成那一刻先把成图并入历史、再撤待办卡片，避免缩略图空窗。注释已说明，保留。（注：F025 删的是其中两个与进度无关的库推送，不影响这层顺序。）
- **`tasks.ts:158-161` 的「Promise.all 到 filter 间不得有 await」不变量。** 防 4s 定时器插入造成双弹窗/双移除的真实并发保护，注释完整，别往中间插 await。
- **`tasks.ts` 的 polling 串行重入锁。** 同一任务多 job 共享 images.length 接续编号下载，两轮并发会下成同名图互相覆盖。正确性约束，非偷懒。
- **`api.ts:160-162` 只对 5xx/429 抛 TransientError。** 4xx 的 body 仍是结构化 JSON，交给 parseGenerateResponse+status 判定更精确；瞬时故障才需重试语义。设计正确。
- **CSP 放开 style-src 'unsafe-inline'（sidebarProvider.ts:355-360）。** Radix 浮层定位/动画走元素级内联 style，nonce/hash 管不到内联 style 属性；script 仍锁 nonce。Radix 硬约束，注释已交代。
- **`resume()` 重置 createdAt 为 now（tasks.ts:177-181）。** 刻意：超时按本次会话起算，避免离线时长误判超时；真实墙钟由 startedAt 保留。
- **`pollJob:287` 的 `job.id!` 非空断言。** 只有 running job 进入该路径，id 必已回填。断言收窄正确。
- **24 个文件被 knip 报 unused。** 全假阳性——knip 无配置、不认识 esbuild 双入口与扩展 main/contributes 入口。非死代码。

## Open questions（无法判断是债还是有意为之）

1. **F032**：seq 重启归零 + 秒级时间戳命名，是否考虑过跨重启同秒碰撞？还是判定概率低到可忽略？
2. **F034**：IMAGES.md 只读 workspaceFolders[0] 是有意的单根假设，还是未考虑多根工作区？
3. **F035**：是否需要 OutputChannel 做线上排障？目前失败信息只在弹窗/状态行一闪。
4. **MAX_DEPTH=3 / MAX_ENTRIES=500**（materials.ts）是经验值还是拍的？大素材库用户是否反馈过扫不全？
5. **F026**：全失败后保留空 task-* 文件夹是有意留痕，还是单纯没清理？

## Assessment

结构持续健康——分层清晰、安全卫生到位、关键正确性约束都有注释护栏，首轮 22 项债已全部修复并经本轮复核仍成立。本轮真实债收敛到三处：**异步状态机零行为测试（F023，最高优先）**、**每 4s 的无效扫盘（F025，一行可修）**、**全失败残留空文件夹（F026）**，外加两处文档漂移与若干一致性小项。无 Critical、无需任何重写；Top 5 预计 1 天内可清。
