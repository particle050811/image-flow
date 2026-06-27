# Tech Debt Audit — image-flow
首轮：2026-06-08 · 第二轮：2026-06-09 · 第三轮：2026-06-11 · 第四轮：2026-06-19（聚焦：前端重复造轮子 + 大文件拆分）· 第五轮：2026-06-26（聚焦：round-4 后增量——分辨率档位/收藏控制器/媒体引用重构）· **第六轮：2026-06-27（聚焦：15 个未推送提交的「多 API 兼容」重大改造——adapter 抽象 / Provider 数据模型 / settings.json 加载）** · 范围：全仓（src/ ~7,400 LOC，含 webview）

本文件只保留**未终结**的发现（OPEN / PARTIAL / 开放问题）。已修复与已判定可接受的项（F001–F032、F036–F041、F043–F047、F049、F051–F060，共 60+ 项）归档在 [`TECH_DEBT_RESOLVED.md`](TECH_DEBT_RESOLVED.md)，含各轮修复记录。复审时：新发现追加进下表并标 `NEW`，修完移入归档文件。

## 第六轮小结（2026-06-27）— 多 API 兼容改造

复审 `origin/main` 之上 **15 个未推送提交**（`9cd5e83`…`10d9bc6`）。核心是把写死的 grsai 后端解耦成「adapter 调用协议 + Provider 数据模型 + `~/.image-flow/settings.json` 自定义」三层。新增 `src/adapters/`（types/index + grsai-async/openai-images/gemini-generate/openai-chat 四协议）、`src/providers.ts`（纯逻辑：内置 grsai、settings.json 解析、ConfigOptions 构建、模型对齐）、`src/providerRuntime.ts`（node 侧 IO：settings.json 读缓存 + 脚手架 + adapter 解析 + AI 命名）。结论——

- **分层与测试质量高。** adapter 是依赖叶子（`api.ts` 不反向 import adapter/provider），纯逻辑（providers.ts/providerRuntime 解析部分）与 IO 分离得当；信任边界（`parseGenerateResponse` 形状校验、`parseImagesData`/`parseCandidates` 逐项 typeof 过滤）守住。新增 `buildOptions`/`parseCustomProvider`/`alignModel`/`providerSwitchPatch`/`parseJsonc`/`normalizeBase`/`resolveImageSize`/`buildImagesBody`/`buildGenerateContentBody`/`mergeCustomParams` 均有直测，`npm test` 由 115 升至 **137 项全绿**，`lint`/`check-types` 全绿，源码无 `as any`/`@ts-ignore`/`TODO`。
- **密钥边界守住。** `ConfigOptions` 显式只下发展示字段（model/label/比例/档位/custom），`RuntimeImageModel.baseUrl/apiKey` 仅后端持有、绝不进 webview（`buildOptions` 不取这两字段）——与 [[multi-api-adapter-architecture]] 记的「密钥绝不下发前端」一致。自定义密钥落 **用户主目录** `~/.image-flow/settings.json`（非工作区，不会随仓库提交），是单文件 JSON 方案的明确取舍。
- **本轮发现 5 项 NEW（1 Medium + 4 Low）并当场全部结案（详见 [`TECH_DEBT_RESOLVED.md`](TECH_DEBT_RESOLVED.md) 第六轮）：** F061（sync adapter 改并行提交、按序落盘避免重名）、F062（自定义模型缺 key 不再回落 grsai 密钥——图片报错、命名静默跳过）、F063（gemini 鉴权定性为已知限制——OpenAI 兼容渠道用 openai adapter、原生谷歌端点暂不支持，gemini-generate 写死 Bearer）、F064（CLAUDE.md 文档同步）、F066（settings.json 解析失败显式提示）。`check-types`/`lint` 全绿、`npm test` 137 项全绿。
- **此前未终结项无变化：** F029（audit 端点不可用）/F033（注释口径）/F048（双窗口轮询）/F050（上游 webview 缓存）保持原状态，本轮未触及相关代码。

## 第五轮小结（2026-06-26）

复审 round-4（commit 35eecc5）之后的 30+ 个提交：媒体引用替换重构（`replaceMediaRefs`/`parseMediaDecls`/`buildNameTable`/`assertAllDeclsReferenced`，commit 0e77414 起）、各模型独立分辨率记忆（`modelOptions.ts`，7ffe844）、收藏控制器抽出（`favoritesController.ts`，ba14e08）、预览/生成统一校验（`requireActiveMd`，3d31ea2）、素材别名 alt（99f5f9b）。结论——

- **新增逻辑测试覆盖到位。** `command.ts` 的解析/校验/替换链路、`modelOptions.ts` 的 `switchModelSize`/`supportedSizes`、`clampImageSize`、`mediaDeclSnippet`、`buildEditArchivePrompt`、`aliasFromDesc`/`readImageDesc` 均有直测，`logic.test.ts` 由 769 行增至覆盖这些纯函数，`npm test` **113 项全绿**（round-3 为 55）。`npm run compile`（check-types + lint + esbuild）全绿。
- **收藏 CRUD 簇已抽出 `favoritesController.ts`（156 行），`sidebarProvider.ts` 663→648。** round-4 判「抽出需传 3–4 个回调、耦合得不偿失」当时保留，本轮实际抽出后只向控制器传 3 个回调（post/pushFavorites/pushAfterChange），耦合可控、读起来更清爽——属 round-4 决策的良性反转，不再是 god 文件争议点。
- **本轮发现的结构债已当场修复（F058/F059/F060，均 Low）：** ① F058——模型切换的 React 接线（`sizeOptions` + `changeModel`）在 `Workbench.tsx`/`Edit.tsx` 近乎逐字重复，抽出 `modelOptions.ts` 的 `modelSizeControl(config, options, keys, onChangeMany)`，两页各传一组 config 键复用；② F059——原先每切一次模型发 3 条 `saveConfig`，hook 内合成单 patch、`App.tsx` 新增 `saveFields` 批量保存，收敛为 1 条消息 / 1 次 globalState 写；③ F060——`err instanceof Error ? err.message : String(err)` 在 9 处复写，抽 `src/errors.ts` 的 `errMsg()` + `SidebarProvider.postError()`（弹窗+台账日志+消息提取一处收口）。新增 2 项 `modelSizeControl` 测试锁定批量化，`npm test` 升至 115 项全绿。
- **维护者本轮拍板/落地的 3 件事：** F034 单根工作区确认为产品决策、已写进 CLAUDE.md 结案；F035 台账日志落地（`src/log.ts` 的「Image Flow」OutputChannel，记任务提交/下载/失败/终结与所有 surfaced error）；编辑区「清空」按钮上线（图片+提示词一并清，提交后保留以支持迭代编辑的语义不变）。
- **安全卫生维持良好：** apiKey 走 secrets、CSP script 锁 nonce、无硬编码密钥、`parseGenerateResponse` 有形状校验、fetch 全程有超时（提交 120s / 查询下载 30s）、`openEditImage` 用 `path.basename` 防路径逃逸。源码无 `as any`/`@ts-ignore`/`TODO`/`FIXME`。

## 第四轮小结（2026-06-19）

应要求聚焦两条线：**前端有没有重复造轮子**、**单个文件是否过大且未合理拆分**。结论——

- **重复造轮子：有，集中在 webview 视图层，已全部修复（commit 35eecc5）。** 缩略图项→`Thumb.tsx`（F052）、选择栏失效回落→`usePicker.ts`（F053）、0.5s 冷却→`useCooldown.ts`（F054）、`{text,error}`→`shared.ts` 的 `StatusState`（F055）；归并目标逻辑去重为 `mergeTargetId`（F057）。重复块均收敛为单一来源。该轮为纯重构、净增约 90 行（抽象固定成本 > 小库里 2–4 个调用点省下的重复），经维护者复核决定保留——收益在"以后改一处而非多处"。**`fields.tsx` / `primitives.tsx` / `thumbs.ts` 是抽象做对的正面样板，不要误伤。**
- **大文件：`sidebarProvider.ts` 经下沉图转换簇 726→663（F056）。** 仍略越 500 阈值：收藏夹 CRUD 簇评估后有意保留（抽出需传 3–4 个回调、耦合得不偿失），663 行对 webview 宿主属常见体量，维护者决策接受、不再拆。其余文件（`tasks.ts` 455、`command.ts` 288）职责单一、未失控。
- F052–F057 已移入 `TECH_DEBT_RESOLVED.md`；`npm run compile` 与收藏单测全绿，过代码审核。

## 当前状态（2026-06-27 第六轮收尾）

- `npm run check-types`/`lint` 全绿；`npm test` **137 项全绿**（多 API 纯逻辑均配直测）。
- 无 Critical / High 未决项。本轮新增 5 项（F061 Medium + F062/F063/F064/F066 Low）**已当场全部修复**（移入归档）。
- 仅余此前 4 项未终结：F029/F050 跟踪上游/外部，F033/F048 等维护者决策。
- 安全卫生维持：grsai apiKey 走 secrets、ConfigOptions 不下发 url/key、CSP script 锁 nonce、无硬编码密钥、`parseGenerateResponse` 形状校验、fetch 全程超时（提交 120s/sync 300s、查询下载 30s）。唯一新增的密钥面是 F062 的回落footgun + 自定义密钥落主目录明文（后者为方案取舍，见「看着像问题」）。

## 架构心智模型

VS Code 扩展，把 Markdown 正文（生成页）或手填提示词 + 编辑区图片（编辑页）当 prompt 调 Grsai 绘图 API。两条独立构建产物：`dist/extension.js`（主进程）与 `media/sidebar.js`（Webview React 前端）；`out/` 仅供测试。

主进程分层（**第六轮后**）：`extension.ts`（激活/注册/续拉）→ `SidebarProvider`（Webview 宿主、消息路由、asWebviewUri 转换、持有 `EditSession`、Provider 切换）→ `tasks.ts`（TaskManager：生成与编辑共用的 start/submitJobs/poll 状态机，持久化 globalState，4s 单定时器轮询）→ `providerRuntime.ts`（按当前配置解析「用哪个 adapter + baseUrl/apiKey/模型」、缓存 settings.json、AI 命名）→ `src/adapters/*`（四个调用协议：grsai-async 异步、openai-images/gemini-generate 同步、openai-chat 命名；adapter 是依赖叶子，凭 id 注册）→ `api.ts`（HTTP 底层：fetchWithTimeout/响应校验/normalizeBase/尺寸换算，不反向依赖 adapter）。Provider 数据模型在 `providers.ts`（纯逻辑：内置 grsai 写死 + `~/.image-flow/settings.json`→自定义 Provider 解析 + 发往 webview 的 ConfigOptions 剥掉 url/key + 切 Provider 时模型对齐）。**多 Provider 形态**：grsai 模型的 baseUrl/apiKey 缺省、回落 config/secrets；自定义模型各自带 baseUrl/apiKey（落主目录单文件 JSON）。任务统一落 `<工作区根>/.image-flow/tasks/<毫秒戳>/`（`storage.ts` 定根、`taskFiles.ts` 写提示词 frontmatter 文件与 input/ 参考图归档）。编辑链路：`editSession.ts`（编辑区图片驻内存 data URI，主进程持有防 webview 重建丢失）→ `edit.ts`（引用替换 + `buildEditFinalPrompt` 供提交/预览共用）→ `prompts.ts`（.image-flow/prompts/ 模板扫描）；`refs.ts` 是前后端共用的引用片段纯函数（无 vscode 依赖）。`shared.ts` 是消息协议唯一定义处。第五轮新增/抽出：`favoritesController.ts`（收藏 CRUD/导出，从 Provider 抽出、经回调推送）、`modelOptions.ts`（前后端共用的「模型→分辨率档位」纯逻辑）、`command.ts` 的媒体引用替换簇（`parseMediaDecls`/`buildNameTable`/`replaceMediaRefs`/`assertAllDeclsReferenced`，生成与编辑共用）。前端五标签页：工作台/编辑/任务/收藏/设置。

## 未终结发现

| ID | Status | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|--------|----------|-----------|----------|--------|-------------|----------------|
| F029 | 🟡PARTIAL | Dependency debt | package.json（传递依赖） | Medium | S | 上轮记 npm audit 4 漏洞（serialize-javascript 等），全在 `@vscode/test-cli→mocha` 开发链。本轮无法复查：本机 npm 镜像（npmmirror）的 audit 端点未实现（NOT_IMPLEMENTED），返回 404。 | 维持不动；开发期依赖不进发布产物。换官方 registry 或 `npm audit --registry=https://registry.npmjs.org` 时再复查。 |
| F033 | 🔁OPEN | Consistency | src/materials.ts:156 | Low | S | scanDirImages 注释称「按遍历条目计数，与递归版口径一致」，但 listAutoLibraries 逐层各调一次 scanDirImages（各自 `scanned=0`），N 层路径累计上限达 N×500，与递归版共享 counter 的口径并不一致。 | 改注释（说清是每层独立 500）或让自动库各层共享一个 counter，二选一。 |
| F048 | 🔁OPEN | Concurrency (edge) | src/tasks.ts:93-98,116-118 | Low | M | pending 任务存 globalState（跨窗口共享）：两个 VS Code 窗口并存时各自 TaskManager 都会 resume/轮询同一批任务——双倍查询、向同一 dir 重复下载、persist 后写覆盖先写。单窗口无影响。 | 开放问题：加窗口锁/按工作区隔离，或文档化为已知限制。 |
| F050 | 🟡PARTIAL | Upstream (disk leak) | src/webview/resourceCache.ts / src/sidebarProvider.ts:150 | Medium | — | VS Code webview SW 把 asWebviewUri 资源永久缓存落盘且无淘汰（实测用户机 23.5GB）。本扩展自身 origin 已修（resourceCache.ts 启动+节流自清，commit 0c7bc16）；但 `openImage` 走 `vscode.open` → 内置 media-preview 每次渲染 `?version=Date.now()` 缓存一份全图，该 origin 扩展够不着。详见 docs/vscode-webview-cache.md。 | 跟踪上游 microsoft/vscode#310384（open，已附根因提报）；上游加淘汰后可把 resourceCache.ts 降级为仅启动清理。F051 真缩略图已上线（2026-06-11），侧栏 origin 的缓存灌水大幅缓解；media-preview origin 仍待上游。 |

> 第四轮 F052–F057、第五轮 F034/F035/F058/F059/F060、**第六轮 F061/F062/F063/F064/F066**（多 API 改造发现并当场修复）均已结案，详见 [`TECH_DEBT_RESOLVED.md`](TECH_DEBT_RESOLVED.md)。

## 看着像问题、其实没问题

- **自定义密钥落 `~/.image-flow/settings.json` 明文，而 grsai 密钥走加密 secrets——看似安全回退。** 是单文件 JSON 方案的明确取舍：文件在**用户主目录**（非工作区，不随仓库提交），等同 `~/.aws/credentials`/`~/.config` 量级的本机明文凭据。每模型自带 key 是多 Provider 的必要形态，强塞进 VS Code secrets 会丢掉「一份 JSON 描述全部」的可移植性。可接受，勿改为 secrets。
- **`submitJobs` 对 async（grsai）仍串行提交——看似没用上并发，别改成并行。** 这是关键护栏：串行让每份大图 base64 独占上行、120s 超时窗口只覆盖自身，服务端生成本就并行。F061 已把 **sync** 路径改成并行（`Promise.allSettled` + 按序落盘），但 **async 路径必须保持串行**——并行会重新触发大图编辑任务多份上传抢带宽、超时同瞬起跑而整批 abort 的老问题。
- **自定义参数 `CustomParam`/`mergeCustomParams` 只发字符串（params: Record<string,string>）。** 是下拉枚举模型的自然形态——UI 是 Select、值恒为字符串。openai `n` 这类数值参以 `"2"` 发出，多数渠道会强转。真要发数值/布尔需另设类型，当前 enum 取舍合理，非漏洞。
- **openai-images/gemini 的响应解析（parseImagesData/parseCandidates）不像 parseGenerateResponse 那样抛错，而是逐项过滤、空则报「接口未返回图片结果」。** 是有意的宽松：同步协议一次定胜负，能解析到几张算几张、零张才失败，比严格抛错更稳。两者都做了 typeof 收窄，不是裸 `as` 蒙混。
- **`fields.tsx`（Field/Select/TextField/TextArea/Checkbox/Stepper）+ `primitives.tsx`（NativeSelect Radix 封装）+ `thumbs.ts`（降采样队列）看似可合并/可下沉，实则是抽象做对了的样板——单一来源、ApiConfig/Workbench/Edit 多页复用、无重复，别动它们。** 第四轮专门核对过 `fields.tsx` 里的 TextField/TextArea/Checkbox 是否死代码——均被 ApiConfig 使用，非死码。第四轮新增的 `Thumb.tsx`/`usePicker.ts`/`useCooldown.ts` 与此同类，是把原本缺的那层抽象补齐。
- **`shared.ts` 把 `Webview*` 与内部 `Task*` 类型分别声明（看似冗余）。** 是前后端边界的有意区分：内部类型只含 file Uri，`Webview*` 才带 asWebviewUri 的 `src`/`favorited`。合并会让主进程误以为能直接拿 webview src。
- **`sidebarProvider.ts` 648 行（第五轮抽出 `favoritesController.ts` 后由 663 降下来）。** 余下为生命周期 + 消息路由 + 编辑区/素材库/预览处理 + HTML，职责仍偏多但每簇都短、依赖 Provider 私有状态（currentMd/edit/view），再拆收益有限。对 webview 宿主属常见体量，维护者决策接受、不再拆。
- **`command.ts` 已 415 行（媒体引用重构后增长）。** 但它是一组单一职责的纯函数簇（正则解析 / 名字表 / 引用替换 / 归档 / 预览文本）+ 少量 IO，每个都有直测、彼此低耦合，不是 god 文件。`parseMediaDecls` 与 `parseImageRefs` 共用 `IMAGE_REGEX` 但各取不同信息（alt vs 路径编号），不是重复。
- **`buildEditFinalPrompt`（edit.ts）内再调一次 `editConfigView`，而 `submitEdit`（tasks.ts）也调了一次。** 两次都是纯函数浅拷贝、只为取 `editModel`，开销可忽略；强行共享反而要多传参，保留更清楚。
- **`buildPrompt` 的「`【@图片N】` 按媒体类型独立编号 vs images[] 按全局出现顺序上传」错位（command.ts:197-200）。** 纯图片、无重复路径时两套编号一致（当前唯一支持场景）；混合媒体/同路径多 alt 才错位，已有两条锁定测试 + 注释标注，待接入音视频后端时统一。不是当前可触发的 bug。
- **四个标签页 forceMount 全量常驻渲染（App.tsx）。** 刻意保留各页内部状态（展开态、提示词草稿），注释已交代；侧栏体量下 DOM 成本可忽略。
- **EditSession 把原图整张以 data URI 驻内存（editSession.ts:12-17）。** 三条理由成立：绕开 localResourceRoots 限制、覆盖系统拖入拿不到路径的二进制、提交本就要 base64。内存面可接受；推送面的债在 F042。
- **archiveInputs 每个任务把参考图再归档一份进 input/（taskFiles.ts）。** 规格明确决策（commit 316efe8）：任务文件夹自包含、可追溯。磁盘换可追溯性。
- **`edit.list()` 返回内部数组引用。** `start()` 在 await 前已把 data/names 拷进 opts，提交后增删编辑区不影响在途任务。
- **编辑页与工作台共用 busy/status。** 同屏只见一页、提交即返，拆两套状态不值得。
- **`submitEdit` 允许零参考图。** 等价于纯文本生成，不是漏校验。
- **关键正确性护栏（勿动）**：sidebarProvider onChange 的 await/void 防闪烁顺序；tasks.ts「Promise.all 到 filter 间不得有 await」不变量；轮询串行重入锁；TransientError 仅 5xx/429；CSP style-src 'unsafe-inline'（Radix 硬约束）+ img-src data:（编辑区，注释已交代）；resume 重置 createdAt 而保留 startedAt；`pollJob` 的 `job.id!` 断言。

## Open questions（待维护者决策）

> 第六轮的 F061/F062/F063 原拟列为开放问题，复审时已直接结案（sync 并行 + 缺 key 拦截 + gemini 鉴权按协议收口/原生谷歌定为已知限制），不再悬而未决。仅余：

1. **F048**：双窗口同时打开时 globalState pending 任务会被两个 TaskManager 同时轮询/下载。单窗口假设是否成立？值得加隔离吗？
2. **F033**：`scanDirImages` 注释口径——改注释说清「每层独立 500」即可，还是要让自动库各层共享 counter？纯文字 vs 行为，二选一。

> 本轮已拍板/落地：F034 确认单根工作区为产品决策（写进 CLAUDE.md）；F035 台账日志已加（`src/log.ts`）；编辑区「清空」按钮已上线（图片+提示词一并清，提交后保留语义不变）。

## Assessment（第六轮 · 2026-06-27）

复审 15 个未推送提交的「多 API 兼容」重大改造：写死的 grsai 后端被干净解耦成 **adapter 协议层 + Provider 数据模型 + settings.json 自定义** 三层。改造质量整体高——分层方向正确（adapter 依赖叶子、纯逻辑与 IO 分离）、信任边界守住（响应形状校验、逐项 typeof 过滤）、密钥不下发 webview、新增纯逻辑全配直测（`npm test` 115→137 全绿）、源码无 `as any`/`TODO`。这是一次设计先行（`docs/multi-api-compat-summary.md` 记录了回滚重做的教训）、落地克制的改造，**不存在 Critical/High 债**。

本轮 5 项 NEW 集中在「兼容各家 API 格式」的边角，多为外部协议差异而非代码烂，**已当场全部结案**：F061（sync 协议串行生成 → 按 `adapter.kind` 分支，sync 改 `Promise.allSettled` 并行提交、按序落盘避免重名，async 保持串行；唯一 Medium）、F062（自定义缺 key 回落 grsai 密钥 → 仅 grsai 回落、自定义缺 key 报错/命名静默跳过）、F063（gemini 鉴权 → 按「adapter=wire 协议」收口：OpenAI 兼容渠道用 openai adapter、gemini-generate 写死 Bearer、原生谷歌端点定为已知限制；曾加 `authStyle` 后判为过度设计撤回）、F064（CLAUDE.md 文档同步）、F066（settings.json 解析失败 → 显式提示）。`check-types`/`lint` 全绿、`npm test` 137 项全绿。改动遵循既有不变量（submitJobs「不得有 await」段、轮询重入锁、密钥不下发 webview）。

---

## Assessment（第五轮 · 2026-06-26）

第五轮收尾后无 Critical/High 未决项，未决项降至 4 项 Low/Medium。本轮复审 round-4 之后的 30+ 提交（媒体引用替换重构、各模型分辨率记忆、收藏控制器抽出、预览/生成统一校验），新增逻辑均配了直测；本轮新增/修复后 `npm test` 升至 115 项全绿、`compile` 全绿。发现并当场修复 3 项 Low 结构债：F058（模型切换接线在工作台/编辑页重复 → 抽 `modelSizeControl`）、F059（每切发 3 条 saveConfig → 合成单 patch、新增 `saveFields` 批量保存）、F060（错误消息提取 9 处复写 → `errMsg()` + `postError()`）。并按维护者决策落地三件事：F034 单根工作区结案、F035 台账日志（OutputChannel）、编辑区清空按钮。值得记一笔的良性反转：round-4 判「不值得抽」的收藏 CRUD 簇，本轮实际抽成 `favoritesController.ts` 后耦合可控、`sidebarProvider.ts` 降到 648 行。代码面整体健康：分层清晰、消息协议单点定义、纯逻辑与 IO 分层、关键约束有注释护栏、无 `as any`/`TODO`、安全卫生良好。剩余未终结项均等决策（F033/F048）或外部跟踪（F029 audit 端点不可用 / F050 上游 webview 缓存）。
