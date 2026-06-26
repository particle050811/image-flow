# Tech Debt Audit — 已修复归档

本文件归档 `TECH_DEBT_AUDIT.md` 中已终结（✅RESOLVED / ✅可接受）的发现，按轮次倒序。未终结项（OPEN / PARTIAL / 开放问题）见 `TECH_DEBT_AUDIT.md`。

## 轮次记录

- **2026-06-26 第五轮（聚焦：round-4 后增量）**：复审 30+ 提交。新增并当场修复 F058/F059/F060（模型切换接线去重 + saveConfig 批量化 + 错误消息提取收口）；按维护者决策落地 F034（单根工作区结案）、F035（台账日志 OutputChannel）、编辑区「清空」按钮。`compile` 全绿、`npm test` 113→115 项全绿（新增 2 项 `modelSizeControl` 测试）。
- **2026-06-19 第四轮（聚焦：前端重复造轮子 + 大文件拆分）**：新增 F052–F057。F052/F053/F054/F055/F057 当轮重构去重（commit 35eecc5）——抽出 `src/webview/Thumb.tsx`、`usePicker.ts`、`useCooldown.ts` 与 `src/toWebview.ts`，重复块全部收敛为单一来源。F056（god 文件）下沉图转换簇令 `sidebarProvider.ts` 726→663，收藏夹 CRUD 簇评估后有意保留，663 行经维护者决策接受、结案。`compile` + 收藏单测全绿，过代码审核（ready to merge）。
- **2026-06-11 F051/F042② 实装**：真缩略图上线（新增 `src/thumbs.ts` 与 `src/webview/thumbs.ts`），顺路完成 F042 第②步，整项 F042 终结。`npm test`（55 项）全绿。
- **2026-06-11 第三轮**：复核 F001–F031 全部成立；F032 因毫秒时间戳自然解决；新增 F039–F049，其中 F039–F041/F043–F047/F049 当轮修复（commit fc21dcd），F042 完成第①步。`compile`/`npm test`（52 项）全绿，已过代码审核（ready to merge）。
- **2026-06-09 第二轮**：新增 F023–F038；F023–F028/F030/F031 当轮修复，F029 部分修复（npm audit fix 修掉 glob 高危）。抽出纯函数 isTaskActive/aggregateProgress/replaceImageRefs/isImageFileName，logic.test.ts 25→35 项。
- **2026-06-08 首轮**：F001–F022 全部修复。新增 `src/images.ts`、`src/paths.ts`、`src/test/logic.test.ts`，删除一次性迁移代码 `migrateLegacySettings`，补测试时抓出并修掉尖括号正则截断 bug（F009）。

## 第五轮已修（2026-06-26）

| ID | Status | Category | File:Line | Sev | Effort | Description | 修复 |
|----|--------|----------|-----------|-----|--------|-------------|------|
| F034 | ✅可接受 | Architecture | src/inject.ts / src/storage.ts | Low | — | 单根工作区假设扩散到 `storage.ts`/`inject.ts`（取 `workspaceFolders[0]`），多根下 `.image-flow` 落点与素材库口径不一致。连续三轮开放问题。 | 维护者拍板：**单根工作区是明确产品决策**，不支持多根。已写进 `CLAUDE.md`「前后端通信与异步任务」段（`listAutoLibraries` 用 `getWorkspaceFolder(mdUri)` 仅为定位 md 层级，不冲突）。结案。 |
| F035 | ✅RESOLVED | Observability | src/log.ts（新增） | Low | S | 无 OutputChannel，失败信息只在弹窗/状态行一闪，排障靠用户复述。连续三轮开放问题。 | 新增 `src/log.ts`：「Image Flow」OutputChannel，`extension.ts` 激活时 `initLog`。`tasks.ts` 记任务提交/下载/轮询失败/全失败/终结，`SidebarProvider.post` 的 error 分支记所有 surfaced error。 |
| F058 | ✅RESOLVED | Architecture (duplication) | Workbench.tsx / Edit.tsx | Low | S | 模型切换接线 `sizeOptions = supportedSizes(...)` + `changeModel`（记旧档→算新档→3 个 onChange）在工作台/编辑页近乎逐字重复，仅差 config 键前缀。 | 抽 `modelOptions.ts` 的 `modelSizeControl(config, options, keys, onChangeMany)` 返回 `{ sizeOptions, changeModel }`，两页各传一组键（model 组 / editModel 组）复用。放在已测的 DOM-free 模块，新增 2 项测试。 |
| F059 | ✅RESOLVED | Performance (minor) | App.tsx / Workbench.tsx / Edit.tsx | Low | S | `changeModel` 连发 3 个 `onChange` → 3 条 `saveConfig` → 扩展侧 3 次 globalState read-modify-write，非原子。 | `modelSizeControl` 内把三键合成单 patch；`App.tsx` 新增 `saveFields(patch)` 批量保存，一次切模型 = 1 条消息 / 1 次写。测试锁定「只发一条 patch」。 |
| F060 | ✅RESOLVED | Consistency (duplication) | 多处（command/tasks/sidebarProvider） | Low | S | `err instanceof Error ? err.message : String(err)` 在 9 处复写；错误弹窗 + 消息提取 + 日志总捆绑在一起。 | 抽 `src/errors.ts` 的 `errMsg(err)`，9 处复用；`SidebarProvider.postError(err)` 把「消息提取 + post 弹窗 + 台账日志」一处收口，4 个 catch 分支收敛为 `this.postError(err)`。 |

> 配套交付（非债，按维护者要求的功能）：编辑区「清空」按钮——一键清空编辑区图片（`EditSession.clear()` + `editClearImages` 消息）与提示词本地 state，无图且无提示词时禁用；提交后保留图片/提示词以支持迭代编辑的语义不变。

## 第四轮已修（2026-06-19，commit 35eecc5）

聚焦"前端有没有重复造轮子 + 单文件是否过大"。重复确为净增约 90 行的纯重构（抽象固定成本 > 小库里 2–4 个调用点省下的重复），但重复块均收敛为单一来源；维护者复核后决定全部保留。

| ID | Status | Category | File:Line | Sev | Effort | Description | 修复 |
|----|--------|----------|-----------|-----|--------|-------------|------|
| F052 | ✅RESOLVED | Architecture (duplication) | Tasks/Materials/Favorites/Edit.tsx | Medium | M | 缩略图项 `thumb-wrap`+`<img>`+`StarButton` 在 4 个组件各写一份，差异仅在角标动作与 drag/contextMenu。 | 抽 `src/webview/Thumb.tsx` 的 `<Thumb>`（draggable/onClick/onContextMenu/star/children 可选 props），4 处复用；拖拽串 `application/x-imageflow-uri` 由 2 处→1 处。className/key/title 全保持，行为等价（已审核）。 |
| F053 | ✅RESOLVED | Architecture (duplication) | Tasks/Materials/Favorites.tsx | Medium | M | "选择栏失效回落第一项"`find(k)??items[0]` 在 3 处复刻。 | 抽 `src/webview/usePicker.ts`，初值经 initialKey 表达（Favorites=activeCollectionId，余为 null）；回落逻辑由 3 处→1 处。 |
| F054 | ✅RESOLVED | Consistency (duplication) | App.tsx / Edit.tsx | Low | S | 0.5s 防连点冷却 `setTimeout(…,500)` 两份。 | 抽 `src/webview/useCooldown.ts` 返回 `[cooling, trigger]`；保留 App 的 `busy||genCooling` 与 Edit 的 `if(busy||cooling)return` 语义，未触碰 switchTab 闭包护栏。 |
| F055 | ✅RESOLVED | Type debt | App/Workbench/Edit.tsx | Low | S | 状态形状 `{text,error}` 在 3 文件内联声明，绕过 shared.ts 单点定义。 | shared.ts 新增 `StatusState`，经 webview/vscode.ts re-export，3 处引用。 |
| F056 | ✅可接受 | Architecture (god file) | src/sidebarProvider.ts | Medium | M | 726 行 god 文件：生命周期 + 消息路由 + 收藏夹 CRUD + 导出 + 图转换 + HTML。 | 图转换簇（5 函数）下沉 `src/toWebview.ts` 纯函数（726→663）。收藏夹 CRUD 簇评估后保留——抽出需传 3–4 个回调，耦合得不偿失；663 行对 webview 宿主属常见体量，维护者决策接受、不再拆。 |
| F057 | ✅RESOLVED | Architecture (duplication) | sidebarProvider.ts / favorites.ts | Low | S | 删收藏夹"归并目标"（剩余夹优先默认夹否则第一个）在弹窗标签与实际删除两处各算一遍，易漂移。 | favorites.ts 导出 `mergeTargetId(collections, victimId)`，`deleteCollection` 与 provider 弹窗共用。 |

## F051/F042② 已修（2026-06-11）

| ID | Status | Category | File:Line | Sev | Effort | Description | 修复 |
|----|--------|----------|-----------|-----|--------|-------------|------|
| F051 | ✅RESOLVED | Performance | src/sidebarProvider.ts（toWebviewImage） | Medium | L | 素材库/任务历史/进行中任务的「缩略图」实为全尺寸原图经 asWebviewUri 直接作 `<img src>`，解码内存、首屏延迟、SW 缓存灌水全按原图付费。 | 真缩略图：扩展侧 `src/thumbs.ts` 按 sha1(uri+mtime+size) 解析 `.image-flow/thumbs/<key>.webp`（会话级缓存避免每 4s 推送重复 stat）；缺缩略图时下发原图 src + thumbKey，webview 侧 `src/webview/thumbs.ts` 用 canvas 降采样为 ≤512px webp q0.8（并发限 2）回传 saveThumb 落盘，下次推送即用缩略图。跳过 svg/gif/<100KB 小图；点开（openImage）仍走原图 uri。已知取舍：原图被覆盖后旧缩略图不回收（单张 ~20KB，量级可忽略）。 |
| F042 | ✅RESOLVED | Performance | src/editSession.ts / src/webview/Edit.tsx | Medium | M | 编辑区以未缩放原图 data URI 作 `<img src>`，每次增删全量重发。第①步（消息批量化）已于第三轮完成。 | 第②步与 F051 同路：EditSession 增 `display` 字段，大图（>~100KB、非 gif）标记 needsThumb，webview 生成压缩展示图经 saveEditThumb 回传缓存；此后全量重发只携带压缩图，原图仅提交时使用。 |

## 第三轮已修（2026-06-11，commit fc21dcd）

| ID | Status | Category | File:Line | Sev | Effort | Description | 修复 |
|----|--------|----------|-----------|-----|--------|-------------|------|
| F039 | ✅RESOLVED | Doc drift | README.md | Medium | S | 三处过期：task-* 同级存储 → 实为 `.image-flow/tasks/<毫秒戳>`；三个标签页 → 实为四个（缺编辑页）；「锁定最左 md」→ 实为跟随活动编辑器；配置表缺编辑页参数。 | 重写功能/使用步骤/配置三节，补 `.image-flow` gitignore 提示。 |
| F040 | ✅RESOLVED | Doc drift | CLAUDE.md:7,46 | Medium | S | 项目目标缺编辑页；任务机制段写 `task-<时间戳>-<seq>` 与「卡片在顶部展示」；架构要点缺 storage/taskFiles/edit/editSession/prompts/refs。 | 两段更新 + 编辑链路模块导览。 |
| F041 | ✅RESOLVED | Doc drift (UI) | src/webview/Workbench.tsx:80-81 | Low | S | tooltip「默认选择主界面最左侧 Markdown」与跟随活动编辑器的实际行为不符。 | 改为「跟随当前活动的 Markdown 编辑器；切到非 Markdown 标签时保持不变」。 |
| F043 | ✅RESOLVED | Consistency | src/sidebarProvider.ts / src/tasks.ts | Low | S | 编辑最终提示词拼装在预览与提交两处各写一遍，改注入逻辑预览会漂移。 | 抽 `buildEditFinalPrompt`（edit.ts）两处共用，新增 2 项测试锁定。 |
| F044 | ✅RESOLVED | Error handling | src/sidebarProvider.ts:81 | Low | S | onDidReceiveMessage 不接收 async 拒绝，saveConfig 等分支失败成静默 unhandled rejection。 | 顶层 `.catch` 转前端 error 消息；内层自带 try/catch 的分支不重复弹错（已审核确认）。 |
| F045 | ✅RESOLVED | Consistency | src/webview/App.tsx | Low | S | navigate/sendToEdit 直接 setTab 绕过 switchTab 副作用，✎ 送图进编辑页不刷新模板。 | 两处改调 switchTab，并注释闭包约束（首渲染实例、不得读 state）。 |
| F046 | ✅RESOLVED | Doc drift | src/webview/Tasks.tsx | Low | S | useElapsed 参数名/注释为 createdAt，实收 startedAt（二者语义在 shared.ts 刻意区分）。 | 参数改名 startedAt，注释同步。 |
| F047 | ✅RESOLVED | Doc drift | src/shared.ts | Low | S | WebviewEditImage 注释「data URI 缩略图」实为未缩放原图。 | 注释纠正；若做 F042 第②步则名副其实。 |
| F049 | ✅RESOLVED | Repo hygiene | .vscode/*.png | Low | S | 两张未跟踪截图无用途也无 ignore。 | .gitignore 加 `.vscode/*.png`。 |

F042 的第①步（editAddImageData 批量化为 editAddImagesData、单次推送、FileReader 失败提示）也在本轮完成；因第②步（缩略图压缩）未做，整项保持 PARTIAL 留在主文件。

## 第二轮已修（2026-06-09）

| ID | Status | Category | File:Line | Sev | Description | 修复 |
|----|--------|----------|-----------|-----|-------------|------|
| F023 | ✅RESOLVED | Test debt | src/tasks.ts | High | 核心异步状态机无行为测试。 | 抽出可测纯函数 isTaskActive/aggregateProgress 并补测；注入式状态机测试仍欠（已判定可接受）。 |
| F024 | ✅RESOLVED | Test debt | src/command.ts | High | buildPrompt 等读写盘路径无测试。 | 抽出纯函数 replaceImageRefs（含 F009 尖括号回归用例）并补测。 |
| F025 | ✅RESOLVED | Performance | src/sidebarProvider.ts | Medium | 任务每 4s onChange 调 pushLibraries+pushAutoLibraries 触发无效递归扫盘。 | 已删两行；库刷新由 syncActiveMd 与增删库各自触发，注释护栏在 sidebarProvider.ts:54-56。 |
| F026 | ✅RESOLVED | Resource hygiene | src/tasks.ts | Medium | 全失败任务残留空 task-* 文件夹。 | 加 cleanupEmptyFolder，submitJobs 与 pollOnce 移除任务前对无成图者删空目录。 |
| F027 | ✅RESOLVED | Doc drift | CLAUDE.md | Medium | activationEvents 描述过期。 | 改为「已配置 onStartupFinished，开机即激活并 resume」。 |
| F028 | ✅RESOLVED | Doc drift | README.md | Low | 设置页描述漏「模型注入提示词」。 | 已补。 |
| F030 | ✅RESOLVED | Consistency | command.ts / materials.ts | Low | isImageFile 与 isImage 两份本地拷贝。 | images.ts 导出 isImageFileName 统一复用。 |
| F031 | ✅RESOLVED | Type & contract | src/api.ts | Low | parseGenerateResponse 只校验 status。 | 补 id/results/error 形状校验，契约与校验一致。 |
| F032 | ✅RESOLVED | Correctness (edge) | src/command.ts:97-108 | Low | 任务文件夹秒级时间戳+seq 跨重启可能碰撞。 | 第三轮确认已改毫秒级时间戳（commit 01370eb）+ 生成按钮 0.5s 冷却，碰撞概率可忽略。 |
| F036 | ✅可接受 | Consistency | command.ts / sidebarProvider.ts | Low | mdBaseName/baseName 单行透传包装。 | 判定为语义命名保留。 |
| F037 | ✅可接受 | Resource hygiene | src/tasks.ts | Low | submitting 态无独立超时。 | fetchWithTimeout 30s 兜底，可接受。 |
| F038 | ✅可接受 | Error handling | src/sidebarProvider.ts | Low | post 在侧栏关闭时静默丢消息。 | init 全量重推兜底，可接受。 |

## 首轮已修（2026-06-08）

| ID | Status | Category | File:Line | Sev | Description | 修复 |
|----|--------|----------|-----------|-----|-------------|------|
| F001–F004 | ✅RESOLVED | 文档漂移 | README.md | High | README 全篇过时（同步/明文 key/settings 流程/命令名）。 | 按当时实现重写三节。 |
| F005–F006 | ✅RESOLVED | 类型契约 | api.ts | High | 响应裸 as 断言。 | 加 parseGenerateResponse 校验。 |
| F007–F008 | ✅RESOLVED | 性能/资源 | api.ts / command.ts | High | fetch 无超时。 | fetchWithTimeout（AbortController 30s）。 |
| F009 | ✅RESOLVED | 功能缺口 | command.ts | High | 正则解析不了尖括号路径。 | 双捕获组正则，并修半角括号截断。 |
| F010 | ✅RESOLVED | 测试 | src/test | High | 核心纯逻辑零覆盖。 | 新增 logic.test.ts。 |
| F011 | ✅RESOLVED | 一致性 | command.ts / materials.ts | Medium | 扩展名白名单两份。 | 抽到 images.ts。 |
| F012 | ✅RESOLVED | 一致性 | 三处 basename | Medium | 取名各写一套。 | 抽到 paths.ts。 |
| F013 | ✅RESOLVED | 架构 | sidebarProvider.ts | Medium | localResourceRoots 重复构造。 | 复用 buildResourceRoots。 |
| F014 | ✅RESOLVED | 功能缺口 | extension.ts | Medium | 不展开侧栏则不续拉。 | 补 onStartupFinished。 |
| F015 | ✅RESOLVED | 错误处理 | tasks.ts | Medium | catch 吞所有错误。 | isTransientNetworkError 区分。 |
| F016–F022 | ✅RESOLVED | 一致性/健壮性/死代码 | 多处 | Low | URL 扩展名校验、集合判断、残留空行、计数口径、平凡包装、限制节失效等。 | 逐项修复。 |
