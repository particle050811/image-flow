# Tech Debt Audit — image-flow
Generated: 2026-06-08 · 复审更新：2026-06-09 · 第三轮复审：2026-06-11 · 范围：全仓（src/ ~3,600 LOC）

> **2026-06-11 复审（repeat-run）**：上两轮 F001–F031 已修项全部复核仍成立（`lint`/`check-types`/`npm test`（50 项）本轮全绿）。**F032 升级为 RESOLVED**——任务文件夹名已改毫秒级时间戳（`formatStamp` 到 SSS，commit 01370eb），跨重启同毫秒碰撞概率可忽略，且生成按钮有 0.5s 冷却。本轮覆盖 06-09 之后落地的**图片编辑功能**全量新代码（edit/editSession/prompts/refs/storage/taskFiles + Edit.tsx，约 +1,000 LOC）：新代码结构与注释质量与存量一致，无 Critical/High；真实债集中在**两份文档（README/CLAUDE.md）未跟上「.image-flow 统一存储 + 编辑页」这波大改**与**编辑区原图 data URI 全量推送**。新增 F039–F049（标记 `NEW`）。
>
> **2026-06-11 修复**：F039–F041/F043–F047/F049 已修复；F042 完成第①步（编辑区拖入消息批量化 `editAddImagesData`，消 O(N²) 序列化），缩略图压缩（第②步）暂缓。新增纯函数 `buildEditFinalPrompt`（edit.ts）供提交与预览共用，logic.test.ts 新增 2 项（52 项全过）；`npm run compile` 与 `npm test` 均绿。F033/F034/F035/F048 仍为开放问题待产品决策。
>
> **2026-06-09 第二轮**：新增 F023–F038，其中 F023–F028/F030/F031 已修，F029 部分修复。详见下表。
>
> **2026-06-08 首轮**：F001–F022 全部修复（README 重写、响应校验、fetch 超时、尖括号正则、logic.test.ts 等）。

## 执行摘要（按影响排序，本轮）

1. **README 与现状矛盾（NEW F039，Medium）**：README 仍写「图片下载到生效 MD 同级的 `task-yyMMddHHmmSS-seq` 文件夹」「三个标签页」「锁定标签栏最左的 md」——三条全部过期：现为 `<工作区根>/.image-flow/tasks/<毫秒戳>`、四个标签页（多了编辑）、生效 MD 跟随活动编辑器。对新用户是错误指引。
2. **CLAUDE.md 漂移（NEW F040，Medium）**：项目目标段没提编辑页；任务机制段仍写 `task-<时间戳>-<seq>` 文件夹与「进行中卡片在顶部展示」（现为与历史按时间倒序合并）；新模块 storage/taskFiles/edit/editSession/prompts/refs 在架构要点里缺位。后续 AI 会话会基于错误前提决策。
3. **编辑区原图 data URI 全量推送（NEW F042，Medium）**：每次增删一张图，`pushEditImages` 把**所有**图片的完整 base64 原图重发一遍（拖入 N 张 = N 条消息 × 各全量推送 = O(N²) 数据量）；webview 的 `<img>` 直接用原图当缩略图。几张 4K 图就是每次几十 MB 的 postMessage 序列化。
4. **界面文案漂移（NEW F041）**：工作台 tooltip 仍写「默认选择主界面最左侧 Markdown」，行为早改成跟随活动编辑器（commit 62099c2）。
5. 编辑提示词拼装在提交（tasks.ts）与预览（sidebarProvider.ts）两处各写一遍（NEW F043），改注入逻辑时预览易漂移。
6. `onDidReceiveMessage` 的 async 处理无顶层 catch（NEW F044），`saveConfig` 等少数分支失败会变成静默的 unhandled rejection。
7. 依赖告警与上轮持平（F029 PARTIAL）：npm audit 4 漏洞（1 high），全在 `@vscode/test-cli→mocha` 开发链，无新修复路径，不进发布产物。
8. 安全卫生持续良好：apiKey 走 secrets、CSP script 锁 nonce、编辑区 data URI 放行有注释交代（img-src data:）、无硬编码密钥。
9. 测试持续改善：50 项纯逻辑测试全过，编辑功能新纯函数（buildEditPrompt/imageRefSnippet/dataUriBytes/EditSession）均有覆盖。TaskManager 状态机注入式测试仍欠（F023 当时以纯函数抽取部分解决，遗留可接受）。
10. 本轮严重度分布（仅新增项）：0 Critical / 0 High / 3 Medium / 8 Low。

## 架构心智模型

VS Code 扩展，把 Markdown 正文（生成页）或手填提示词 + 编辑区图片（编辑页）当 prompt 调 Grsai 绘图 API。两条独立构建产物：`dist/extension.js`（主进程）与 `media/sidebar.js`（Webview React 前端）；`out/` 仅供测试。

主进程分层：`extension.ts`（激活/注册/续拉）→ `SidebarProvider`（Webview 宿主、消息路由、asWebviewUri 转换、持有 `EditSession`）→ `tasks.ts`（TaskManager：生成与编辑共用的 start/submitJobs/poll 状态机，持久化 globalState，4s 单定时器轮询）→ `api.ts`（HTTP + 请求体构造 + 响应校验）。任务统一落 `<工作区根>/.image-flow/tasks/<毫秒戳>/`（`storage.ts` 定根、`taskFiles.ts` 写提示词 frontmatter 文件与 input/ 参考图归档）。编辑链路：`editSession.ts`（编辑区图片驻内存 data URI，主进程持有防 webview 重建丢失）→ `edit.ts`（`![](名)` → `[imageN]` 按编辑区顺序替换）→ `prompts.ts`（.image-flow/prompts/ 模板扫描）；`refs.ts` 是前后端共用的引用片段纯函数（无 vscode 依赖）。`shared.ts` 仍是消息协议唯一定义处。前端四标签页：工作台/编辑/任务/设置。

心智模型与代码一致；与 README/CLAUDE.md **不**一致——两份文档停留在「task-* 与 MD 同级、三标签页」的上一版架构（F039/F040）。

## Findings

### 历史轮次（2026-06-08 / 06-09）

| ID | Status | Category | File:Line | Sev | Description | 备注 |
|----|--------|----------|-----------|-----|-------------|------|
| F001–F022 | ✅RESOLVED | 多类 | 多处 | High~Low | 首轮 22 项（README 重写、响应校验、fetch 超时、尖括号正则、测试、白名单/basename 去重等） | 本轮抽查仍成立 |
| F023 | ✅RESOLVED | Test debt | src/tasks.ts | High | 状态机零行为测试 | 抽纯函数补测；注入式状态机测试仍欠（可接受） |
| F024 | ✅RESOLVED | Test debt | src/command.ts | High | buildPrompt 等无测试 | replaceImageRefs 等已覆盖 |
| F025 | ✅RESOLVED | Performance | src/sidebarProvider.ts | Medium | 任务 onChange 触发无效扫盘 | 已删，注释护栏在 sidebarProvider.ts:54-56 |
| F026 | ✅RESOLVED | Resource hygiene | src/tasks.ts:121-130 | Medium | 全失败任务残留空文件夹 | cleanupEmptyFolder 已接入 submitJobs 与 pollOnce |
| F027/F028 | ✅RESOLVED | Doc drift | CLAUDE.md / README | Medium | activationEvents 等过期描述 | 已修（但本轮又出现新漂移，见 F039/F040） |
| F029 | 🟡PARTIAL | Dependency debt | package.json（传递依赖） | Medium | npm audit 4 漏洞（2 low/1 moderate/1 high：serialize-javascript RCE/DoS） | 全在 @vscode/test-cli@0.0.12→mocha 链，npm 仅提供降级 --force「修复」，维持不动；开发期依赖不进产物 |
| F030/F031 | ✅RESOLVED | Consistency / Type | images.ts / api.ts:49-71 | Low | isImage 双拷贝 / 响应校验只查 status | 已统一；id/results/error 形状校验在位 |
| F032 | ✅RESOLVED | Correctness (edge) | src/command.ts:97-108 | Low | 任务文件夹秒级时间戳+seq 跨重启可能碰撞 | 已改毫秒级时间戳（formatStamp 到 SSS，commit 01370eb）+ 生成按钮 0.5s 冷却，碰撞概率可忽略 |
| F033 | 🔁OPEN | Consistency | src/materials.ts:89 | Low | scanDirImages 注释称「与递归版口径一致」，但 listAutoLibraries 每层独立 500 上限，深路径累计可超 | 改注释或共享 counter，二选一 |
| F034 | 🔁OPEN | Architecture | src/inject.ts:16 / src/storage.ts:4-15 | Low | 单根工作区假设扩散：readImagesMd 与新增的 storage.ts 都取 workspaceFolders[0]，而 listAutoLibraries 用 getWorkspaceFolder(mdUri)——多根下 .image-flow 落点与素材库口径不一致 | 开放问题：明确单根假设并文档化，或统一按 mdUri 归属取根 |
| F035 | 🔁OPEN | Observability | src/tasks.ts / src/sidebarProvider.ts | Low | 无 OutputChannel，失败信息只在弹窗/状态行一闪 | 开放问题，待确认需求 |
| F036–F038 | ✅可接受 | 多类 | 多处 | Low | 透传包装命名 / submitting 无独立超时 / post 静默丢消息 | 上轮已判定可接受，本轮无变化 |

### 本轮新增（2026-06-11）

| ID | Status | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|--------|----------|-----------|----------|--------|-------------|----------------|
| F039 | ✅RESOLVED | Documentation drift | README.md:9,14-15,23-24 | Medium | S | 三处过期：①「下载到生效 MD 同级 `task-yyMMddHHmmSS-seq` 文件夹」→ 现为 `.image-flow/tasks/<毫秒戳>`；②「三个标签页」→ 现四个（缺编辑页全部功能：上传/拖入/模板/独立参数）；③「锁定标签栏最左的 .md」→ 现跟随活动编辑器（commit 62099c2）。配置表也缺编辑页四个参数。 | 按当前实现重写功能/使用步骤/配置三节。 |
| F040 | ✅RESOLVED | Documentation drift | CLAUDE.md:7,46 | Medium | S | ①项目目标段无编辑页；②任务机制段仍写「下载到 `task-<时间戳>-<seq>` 文件夹」与「进行中卡片在标签页顶部展示」（现为统一 `.image-flow/tasks/<毫秒戳>`、与历史合并倒序）；③架构要点缺 storage/taskFiles/edit/editSession/prompts/refs 六个新模块。 | 更新两段并补一句编辑链路模块导览。 |
| F041 | ✅RESOLVED | Documentation drift (UI) | src/webview/Workbench.tsx:80-81 | Low | S | tooltip「默认选择主界面最左侧 Markdown」与实际行为（跟随活动编辑器、非 md 保留上一个）不符，直接误导用户。 | 改为「跟随当前活动的 Markdown 编辑器」。 |
| F042 | 🟡PARTIAL | Performance | src/sidebarProvider.ts:243-248,170-177 / src/webview/Edit.tsx:144-148 | Medium | M | 编辑区每次增删图，`pushEditImages` 把全部图片的完整 base64 原图重发（系统拖入 N 张 = N 条 `editAddImageData` 消息 × 各触发一次全量推送 = O(N²) 序列化量）；webview `<img src>` 直接用原图渲染缩略图。几张 4K 图即每次几十 MB postMessage。 | 两步走：①`editAddImageData` 批量化（前端收齐后发一条 `editAddImagesData`），增删后只 push 一次；②可选：扩展侧生成缩小版缩略图（或前端 canvas 压缩）作 src，原图仅提交时使用。 |
| F043 | ✅RESOLVED | Consistency | src/sidebarProvider.ts:278-282 / src/tasks.ts:190-191 | Low | S | 编辑最终提示词拼装（editConfigView + buildEditPrompt + joinPrompt([modelInjection…])）在预览与提交两处各写一遍，改注入逻辑时预览会漂移。生成链路同构重复已有 CLAUDE.md 说明背书，编辑链路没有。 | 抽 `buildEditFinalPrompt(base, rawPrompt, names)` 供两处共用；或在 CLAUDE.md 写明「两处必须同步改」。 |
| F044 | ✅RESOLVED | Error handling | src/sidebarProvider.ts:81 | Low | S | `onDidReceiveMessage((msg) => this.onMessage(msg))` 不接收 async 拒绝：`saveConfig`→`writeConfig` 失败、`openImage`/`openExternal` 抛错等少数无内层 try/catch 的分支会成为静默 unhandled rejection，用户无感知。 | 包一层：`.catch((e) => this.post({ type: 'error', message: String(e) }))`。 |
| F045 | ✅RESOLVED | Consistency | src/webview/App.tsx:82-84,129-132 | Low | S | `navigate` 消息与 `sendToEdit` 直接 `setTab`，绕过 `switchTab` 的副作用——经 ✎ 送图进编辑页不会刷新模板列表（点标签则会）。 | 两处改调 `switchTab`。 |
| F046 | ✅RESOLVED | Documentation drift | src/webview/Tasks.tsx:61-62,80 | Low | S | `useElapsed` 注释与参数名均为 `createdAt`，实际传入 `task.startedAt`（两者语义在 shared.ts:125-128 刻意区分过——createdAt 会被 resume 重置）。 | 参数改名 startedAt，注释同步。 |
| F047 | ✅RESOLVED | Documentation drift | src/shared.ts:84 | Low | S | `WebviewEditImage` 注释「src 为 data URI 缩略图」——实为未缩放原图（与 F042 同根）。 | 修注释；若做 F042 第②步则名副其实。 |
| F048 | 🆕NEW | Concurrency (edge) | src/tasks.ts:93-98,116-118 | Low | M | pending 任务存 globalState（跨窗口共享）：两个 VS Code 窗口并存时各自的 TaskManager 都会 resume/轮询同一批任务——同一 job 双倍查询、向同一绝对 dir 重复下载，persist 后写覆盖先写。单窗口使用无影响。 | 开放问题：是否值得加窗口锁/按工作区隔离？若用户场景单窗口为主可文档化为已知限制。 |
| F049 | ✅RESOLVED | Repo hygiene | .vscode/image.png, ".vscode/image copy.png" | Low | S | 两张未跟踪截图躺在 .vscode/ 下（git status ??），既没用途也没 ignore。 | 删除，或 .gitignore 加 `.vscode/*.png`。 |

## Top 5 — 只修这几个

1. **F039 + F040 + F041 — 文档三连修。** 同一根因（「.image-flow 统一存储 + 编辑页」大改后文档没跟）一次清掉：README 三节重写、CLAUDE.md 两段更新、tooltip 一行改文案。半小时内完成，消除对用户和后续 AI 会话的错误指引。这是本轮唯一会**主动造成错误行为**的债。

2. **F042 — 编辑区推送瘦身。** 最小修（消 O(N²)）：
   ```ts
   // shared.ts：editAddImageData 改批量
   | { type: 'editAddImagesData'; items: { name: string; data: string }[] }
   // Edit.tsx onDrop：Promise.all 收齐后发一条
   vscode.postMessage({ type: 'editAddImagesData', items });
   // sidebarProvider：循环 addData 收集错误，最后只 pushEditImages() 一次
   ```
   缩略图压缩（第②步）可后置，先把消息数从 N² 压到 N。

3. **F043 — 抽编辑提示词拼装函数。** 在 `edit.ts` 加：
   ```ts
   export function buildEditFinalPrompt(base: ImageFlowConfig, raw: string, names: string[]): string {
     const config = editConfigView(base);
     return joinPrompt([modelInjection(base, config.model), buildEditPrompt(raw.trim(), names)]);
   }
   ```
   `submitEdit` 与 `doEditPreview` 改调它，预览永不漂移。

4. **F044 — onMessage 顶层兜底。** `sidebarProvider.ts:81` 一行：
   ```ts
   view.webview.onDidReceiveMessage((msg) =>
     this.onMessage(msg).catch((e) => this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
   );
   ```

5. **F045 + F046 + F047 — 三个一行级一致性小修**（switchTab 复用、参数改名、注释纠正），顺手清。

## Quick wins（低成本 × 中等以上收益）

- [ ] F039：README 重写功能/使用步骤/配置三节。
- [ ] F040：CLAUDE.md 项目目标 + 任务机制段更新。
- [ ] F041：Workbench tooltip 文案改「跟随当前活动 Markdown」。
- [ ] F044：onMessage 加顶层 catch。
- [ ] F045：navigate/sendToEdit 改走 switchTab。
- [ ] F049：清理 .vscode/ 下两张游离截图。

## 看着像问题、其实没问题

- **四个标签页 forceMount 全量常驻渲染（App.tsx:158-160）。** 看似浪费——隐藏页的素材库缩略图也在 DOM 里。实为刻意：保留各页内部状态（展开态、提示词草稿），注释已交代；侧栏体量下 DOM 成本可忽略。
- **EditSession 把原图整张以 data URI 驻内存（editSession.ts:12-17）。** 注释三条理由都成立：绕开 localResourceRoots 任意目录限制、覆盖系统拖入拿不到路径的二进制、提交本就要 base64。内存面可接受；要修的是**推送面**（F042），不是存储面。
- **archiveInputs 每个任务把参考图再归档一份进 input/（taskFiles.ts:29-46）。** 重复编辑同一批图会复制多份，但这是规格明确决策（commit 316efe8）：任务文件夹自包含、可追溯，与提示词 [imageN] 一一对应。磁盘换可追溯性，合理。
- **`edit.list()` 返回内部数组引用。** 看似可变泄漏，但 `start()` 在 await 前就把 data/names 拷进 opts，提交后用户增删编辑区不影响在途任务。
- **编辑页与工作台共用 busy/status。** 编辑页提交会让工作台按钮短暂显示「生成中…」。同屏只见一页、提交即返（异步任务），拆两套状态不值得。
- **`submitEdit` 允许零参考图。** 等价于纯文本生成，不是漏校验。
- 上两轮判定保留且本轮复核仍成立：sidebarProvider onChange 的 await/void 防闪烁顺序；tasks.ts「Promise.all 到 filter 间不得有 await」不变量；轮询串行重入锁；TransientError 仅 5xx/429；CSP style-src 'unsafe-inline'（Radix 硬约束）+ 本轮新增 img-src data:（编辑区注释已交代）；resume 重置 createdAt 而保留 startedAt；`pollJob` 的 `job.id!` 断言。

## Open questions（无法判断是债还是有意为之）

1. **F048**：双窗口同时打开时 globalState pending 任务会被两个 TaskManager 同时轮询/下载。单窗口假设是否成立？值得加隔离吗？
2. **F034（连续两轮）**：单根工作区假设现已扩散到 storage.ts（.image-flow 落点）。是明确的单根产品决策吗？若是，建议在 CLAUDE.md 写明，下轮不再追问。
3. **`.image-flow/` 是否应建议用户加进其工作区 .gitignore？** input/ 归档随每次生成/编辑累积原图，仓库体积会快速膨胀；扩展不自动写用户 .gitignore 是对的，但 README 是否该提示？
4. **F035（连续两轮）**：OutputChannel 排障日志要不要？编辑链路上线后失败面变大了。
5. **编辑区图片在提交后保留**是有意支持迭代编辑，还是应该提供「清空」按钮？目前删图只能逐张点 ×。

## Assessment

第三轮结论：**代码在变好，文档在变旧。** 编辑功能这波 ~1,000 LOC 新代码延续了存量的高水准——纯函数可测、关键约束有注释护栏、消息协议单点定义、新增 50 项测试全绿；前两轮 31 项已修债全部复核成立，F032 也因毫秒时间戳自然解决。本轮无 Critical/High；3 个 Medium 里两个是文档漂移（README/CLAUDE.md 没跟上 .image-flow 统一存储与编辑页）、一个是编辑区 O(N²) 全量推送。Top 5 预计半天内可清；F048/F034 两个多窗口/多根问题建议给出明确的产品决策后文档化结案。
