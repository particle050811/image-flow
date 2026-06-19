# Tech Debt Audit — image-flow
首轮：2026-06-08 · 第二轮：2026-06-09 · 第三轮：2026-06-11 · 第四轮：2026-06-19（聚焦：前端重复造轮子 + 大文件拆分）· 范围：全仓（src/ ~3,700 LOC + webview ~1,570 LOC）

本文件只保留**未终结**的发现（OPEN / PARTIAL / 开放问题）。已修复与已判定可接受的项（F001–F032、F036–F041、F043–F047、F049，共 40+ 项）归档在 [`TECH_DEBT_RESOLVED.md`](TECH_DEBT_RESOLVED.md)，含各轮修复记录。复审时：新发现追加进下表并标 `NEW`，修完移入归档文件。

## 第四轮小结（2026-06-19）

应要求聚焦两条线：**前端有没有重复造轮子**、**单个文件是否过大且未合理拆分**。结论——

- **重复造轮子：有，集中在 webview 的视图层。** 缩略图九宫格（`thumb-wrap` + `<img>` + 角标动作）在 4 个组件里各写一份（F052）；"选择栏 + 下方详情区 + 失效回落第一项"的 picker 模式在 3 处复刻（F053）；0.5s 防连点冷却写了两份（F054）；`{text,error}` 状态形状在 3 个文件内联声明而非进 `shared.ts`（F055）。**注意 `fields.tsx` / `primitives.tsx` / `thumbs.ts` 恰是反例——基础控件与缩略图压缩已被正确抽成单一来源、复用良好，不要误伤。** 真正缺的抽象只在"缩略图项"和"picker"两层。
- **大文件：`sidebarProvider.ts` 726 行是唯一越线的 god 文件**（F056）——生命周期 + 160 行消息路由 + 收藏夹 CRUD 原生对话框 + 导出 + webview 图转换 + HTML 全挤在一类里。其余文件（`tasks.ts` 455、`command.ts` 288）职责单一、未失控。附带发现一处归并目标逻辑在 provider 与 `favorites.ts` 各算一遍（F057）。
- 本轮均为 Low/Medium、**纯结构债，无功能缺陷**；`npm run compile` 未跑（未改代码，仅审计）。

## 当前状态（2026-06-11 第三轮收尾）

- `npm run compile`（check-types + lint + esbuild）与 `npm test`（55 项）全绿。
- 无 Critical / High 未决项；下表 6 项均为 Low/Medium，其中 4 项是等产品决策的开放问题。F051（真缩略图，含 F042②）已于 2026-06-11 实装完成，移入归档。
- 2026-06-11 追加 F050（webview 缓存磁盘泄露，上游 bug）：自身 origin 已修（commit 0c7bc16），media-preview origin 跟踪上游，调查全文见 `docs/vscode-webview-cache.md`。
- 安全卫生良好：apiKey 走 secrets、CSP script 锁 nonce、无硬编码密钥、响应有形状校验、fetch 有超时。

## 架构心智模型

VS Code 扩展，把 Markdown 正文（生成页）或手填提示词 + 编辑区图片（编辑页）当 prompt 调 Grsai 绘图 API。两条独立构建产物：`dist/extension.js`（主进程）与 `media/sidebar.js`（Webview React 前端）；`out/` 仅供测试。

主进程分层：`extension.ts`（激活/注册/续拉）→ `SidebarProvider`（Webview 宿主、消息路由、asWebviewUri 转换、持有 `EditSession`）→ `tasks.ts`（TaskManager：生成与编辑共用的 start/submitJobs/poll 状态机，持久化 globalState，4s 单定时器轮询）→ `api.ts`（HTTP + 请求体构造 + 响应校验）。任务统一落 `<工作区根>/.image-flow/tasks/<毫秒戳>/`（`storage.ts` 定根、`taskFiles.ts` 写提示词 frontmatter 文件与 input/ 参考图归档）。编辑链路：`editSession.ts`（编辑区图片驻内存 data URI，主进程持有防 webview 重建丢失）→ `edit.ts`（引用替换 + `buildEditFinalPrompt` 供提交/预览共用）→ `prompts.ts`（.image-flow/prompts/ 模板扫描）；`refs.ts` 是前后端共用的引用片段纯函数（无 vscode 依赖）。`shared.ts` 是消息协议唯一定义处。前端四标签页：工作台/编辑/任务/设置。

## 未终结发现

| ID | Status | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|--------|----------|-----------|----------|--------|-------------|----------------|
| F029 | 🟡PARTIAL | Dependency debt | package.json（传递依赖） | Medium | S | npm audit 4 漏洞（2 low/1 moderate/1 high：serialize-javascript RCE/DoS），全在 `@vscode/test-cli@0.0.12→mocha` 开发链。 | npm 仅提供降级 --force「修复」（非真修复），维持不动；开发期依赖不进发布产物。等上游发新版后 `npm audit` 复查。 |
| F033 | 🔁OPEN | Consistency | src/materials.ts:89 | Low | S | scanDirImages 注释称「与递归版口径一致」，但 listAutoLibraries 每层独立 500 上限，深路径累计可超。 | 改注释或共享 counter，二选一。 |
| F034 | 🔁OPEN | Architecture | src/inject.ts:16 / src/storage.ts:4-15 | Low | M | 单根工作区假设扩散：readImagesMd 与 storage.ts 都取 workspaceFolders[0]，而 listAutoLibraries 用 getWorkspaceFolder(mdUri)——多根下 .image-flow 落点与素材库口径不一致。 | 开放问题（连续两轮）：明确单根产品决策并写进 CLAUDE.md 结案，或统一按 mdUri 归属取根。 |
| F035 | 🔁OPEN | Observability | src/tasks.ts / src/sidebarProvider.ts | Low | M | 无 OutputChannel，失败信息只在弹窗/状态行一闪，排障靠用户复述。 | 开放问题：编辑链路上线后失败面变大，建议加 `createOutputChannel('Image Flow')` 写结构化日志；待确认需求。 |
| F048 | 🔁OPEN | Concurrency (edge) | src/tasks.ts:93-98,116-118 | Low | M | pending 任务存 globalState（跨窗口共享）：两个 VS Code 窗口并存时各自 TaskManager 都会 resume/轮询同一批任务——双倍查询、向同一 dir 重复下载、persist 后写覆盖先写。单窗口无影响。 | 开放问题：加窗口锁/按工作区隔离，或文档化为已知限制。 |
| F050 | 🟡PARTIAL | Upstream (disk leak) | src/webview/resourceCache.ts / src/sidebarProvider.ts:150 | Medium | — | VS Code webview SW 把 asWebviewUri 资源永久缓存落盘且无淘汰（实测用户机 23.5GB）。本扩展自身 origin 已修（resourceCache.ts 启动+节流自清，commit 0c7bc16）；但 `openImage` 走 `vscode.open` → 内置 media-preview 每次渲染 `?version=Date.now()` 缓存一份全图，该 origin 扩展够不着。详见 docs/vscode-webview-cache.md。 | 跟踪上游 microsoft/vscode#310384（open，已附根因提报）；上游加淘汰后可把 resourceCache.ts 降级为仅启动清理。F051 真缩略图已上线（2026-06-11），侧栏 origin 的缓存灌水大幅缓解；media-preview origin 仍待上游。 |
| F052 | 🆕NEW | Architecture (duplication) | src/webview/Tasks.tsx:21-43 · Materials.tsx:17-38 · Favorites.tsx:84-95 · Edit.tsx:144-166 | Medium | M | 缩略图网格 `thumb-wrap`+`<img onClick openImage>`+`StarButton` 在 4 个组件各写一份，差异仅在叠加的角标动作（✎ 送编辑 / × 移除 / ☆ 收藏 / 序号）与 drag/contextMenu 处理。改一处样式或交互要同步 4 处。 | 抽 `<Thumb>`（img + 可选 action slot/角标 + drag/contextMenu 配置）+ `<ThumbGrid>`，4 处复用。编辑区那份无 star、有序号与 × 移除，用可选 props 表达即可。 |
| F053 | 🆕NEW | Architecture (duplication) | src/webview/Tasks.tsx:188-241 · Materials.tsx:59-124 · Favorites.tsx:17-97 | Medium | M | "选择栏 + 下方详情区"模式 3 处复刻：均为 `useState(selected)` + `items.find(k)??items[0]` 失效回落 + `.picker-bar`/`.picker-chip`/`.picker-body`。Materials 内还重复两遍（自动库/手动库）。失效回落逻辑各写一份易漂移。 | 抽 `usePicker(items, keyOf)` hook 返回 `{current,setSelected}`，或 `<PickerBar items renderChip onSelect>` 组件；body 渲染各页自留。 |
| F054 | 🆕NEW | Consistency (duplication) | src/webview/App.tsx:134-143 · Edit.tsx:120-128 | Low | S | 0.5s 防连点冷却（`setCooling(true)`+`setTimeout(...,500)`）两份实现，常数 500 各写一遍。 | 抽 `useCooldown(ms)` 返回 `[cooling, trigger]`，两处生成按钮共用。 |
| F055 | 🆕NEW | Type debt | src/webview/App.tsx:48 · Workbench.tsx:27 · Edit.tsx:30 | Low | S | 状态形状 `{ text: string; error: boolean }` 在 3 个文件内联声明。shared.ts 注释自称是"类型唯一定义处避免漂移"，此处恰好绕过了它。 | 在 shared.ts（或 vscode.ts 的 re-export）加 `export interface StatusState { text: string; error: boolean }`，3 处引用。 |
| F056 | 🆕NEW | Architecture (god file) | src/sidebarProvider.ts:1-727 | Medium | M | 唯一越 500 行阈值的文件（726 行）：WebviewViewProvider 生命周期 + 160 行 `onMessage` switch（142-303）+ 收藏夹 CRUD 原生对话框分支（244-298，含业务逻辑）+ `exportCollection`（322-354）+ `pickEditImages`/`addEditImages` + 5 个 `to*Webview*` 图转换（631-690）+ HTML 模板，全在一类里。 | 不重写。按内聚块下沉：收藏夹 CRUD 对话框分支 + exportCollection → `favoritesController.ts`（接收 post 回调）；`to*Webview*` 转换簇 → `toWebview.ts` 纯函数（传 webview 进去）。可减约 200 行，switch 留作纯路由。 |
| F057 | 🆕NEW | Architecture (duplication) | src/sidebarProvider.ts:281-282 · src/favorites.ts:167-169 | Low | S | 删除收藏夹的"归并目标"选择（剩余夹中优先默认夹否则第一个）在两处各算一遍：provider 算给确认弹窗显示标签，favorites.ts `deleteCollection` 算给实际归并。注释已自承"和 deleteCollection 内逻辑一致"——一旦改规则，弹窗标签会与真实行为脱钩。 | favorites.ts 导出 `mergeTargetId(collections, victimId)`，provider 与 deleteCollection 同调一份。 |

## 看着像问题、其实没问题

- **`fields.tsx`（Field/Select/TextField/TextArea/Checkbox/Stepper）+ `primitives.tsx`（NativeSelect Radix 封装）+ `thumbs.ts`（降采样队列）看似可合并/可下沉，实则是抽象做对了的样板——单一来源、ApiConfig/Workbench/Edit 多页复用、无重复。这是 F052/F053 缺的那种抽象的正面对照，别动它们。** 本轮专门核对过 `fields.tsx` 里的 TextField/TextArea/Checkbox 是否死代码——均被 ApiConfig 使用，非死码。
- **`Tasks.tsx` 与 `Favorites.tsx` 的 `thumbs-lg` 网格各保留独立 `<img>`。** 虽与 F052 同源，但 Favorites 那份无 ✎/drag、Tasks 那份有，差异点恰是 F052 要参数化的部分；在 F052 抽出 `<Thumb>` 之前，硬合并只会堆 props，不是净简化。
- **`shared.ts` 把 `Webview*` 与内部 `Task*` 类型分别声明（看似冗余）。** 是前后端边界的有意区分：内部类型只含 file Uri，`Webview*` 才带 asWebviewUri 的 `src`/`favorited`。合并会让主进程误以为能直接拿 webview src。
- **四个标签页 forceMount 全量常驻渲染（App.tsx）。** 刻意保留各页内部状态（展开态、提示词草稿），注释已交代；侧栏体量下 DOM 成本可忽略。
- **EditSession 把原图整张以 data URI 驻内存（editSession.ts:12-17）。** 三条理由成立：绕开 localResourceRoots 限制、覆盖系统拖入拿不到路径的二进制、提交本就要 base64。内存面可接受；推送面的债在 F042。
- **archiveInputs 每个任务把参考图再归档一份进 input/（taskFiles.ts）。** 规格明确决策（commit 316efe8）：任务文件夹自包含、可追溯。磁盘换可追溯性。
- **`edit.list()` 返回内部数组引用。** `start()` 在 await 前已把 data/names 拷进 opts，提交后增删编辑区不影响在途任务。
- **编辑页与工作台共用 busy/status。** 同屏只见一页、提交即返，拆两套状态不值得。
- **`submitEdit` 允许零参考图。** 等价于纯文本生成，不是漏校验。
- **关键正确性护栏（勿动）**：sidebarProvider onChange 的 await/void 防闪烁顺序；tasks.ts「Promise.all 到 filter 间不得有 await」不变量；轮询串行重入锁；TransientError 仅 5xx/429；CSP style-src 'unsafe-inline'（Radix 硬约束）+ img-src data:（编辑区，注释已交代）；resume 重置 createdAt 而保留 startedAt；`pollJob` 的 `job.id!` 断言；App.tsx switchTab 不得读 state（navigate 处理器持有首渲染实例）。

## Open questions（待维护者决策）

1. **F048**：双窗口同时打开时 globalState pending 任务会被两个 TaskManager 同时轮询/下载。单窗口假设是否成立？值得加隔离吗？
2. **F034（连续两轮）**：单根工作区假设已扩散到 storage.ts。是明确的产品决策吗？若是，写进 CLAUDE.md 即可结案。
3. **F035（连续两轮）**：OutputChannel 排障日志要不要？
4. **编辑区图片在提交后保留**是有意支持迭代编辑，还是应该提供「清空」按钮？目前删图只能逐张点 ×。

## 第四轮聚焦建议（前端重复 / 大文件）

若只动一处，优先 **F052（缩略图 `<Thumb>`/`<ThumbGrid>`）+ F053（`usePicker`）**：这两层覆盖了任务/素材/收藏/编辑全部视图，抽出后续改交互（角标、收藏、选择栏）只改一处，是收益最高的去重。F054/F055/F056/F057 为附带的低成本整洁化，可顺手做、不必单独排期。**全部为结构债，不修不影响功能**——按产品节奏决定是否在下次大改视图时一并落地即可。

## Assessment

第三轮收尾后无 Critical/High 未决项；第四轮（聚焦审计）同样未发现功能缺陷或安全问题，新增 6 项均为前端去重与大文件拆分类的 Low/Medium 结构债。代码面整体健康：分层清晰、消息协议单点定义、关键约束有注释护栏、55 项测试全绿、前三轮 40+ 项债全部修复或结案。真正的债集中在 webview 视图层的两处缺失抽象（F052/F053）与 `sidebarProvider.ts` 的体量（F056）；基础控件与缩略图压缩反而是抽象做对的正面样板。剩余前轮项均等产品决策（F034/F035/F048）或上游修复（F029/F050）。
