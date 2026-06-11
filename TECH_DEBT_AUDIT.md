# Tech Debt Audit — image-flow
首轮：2026-06-08 · 第二轮：2026-06-09 · 第三轮：2026-06-11 · 范围：全仓（src/ ~3,600 LOC）

本文件只保留**未终结**的发现（OPEN / PARTIAL / 开放问题）。已修复与已判定可接受的项（F001–F032、F036–F041、F043–F047、F049，共 40+ 项）归档在 [`TECH_DEBT_RESOLVED.md`](TECH_DEBT_RESOLVED.md)，含各轮修复记录。复审时：新发现追加进下表并标 `NEW`，修完移入归档文件。

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

## 看着像问题、其实没问题

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

## Assessment

第三轮收尾后无 Critical/High 未决项。代码面整体健康：分层清晰、消息协议单点定义、关键约束有注释护栏、55 项测试全绿、前三轮 40+ 项债全部修复或结案。F051（真缩略图，含 F042② 编辑区展示压缩）已于 2026-06-11 实装完成；剩余项均等产品决策（F034/F035/F048）或上游修复（F029/F050）。
