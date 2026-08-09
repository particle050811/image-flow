# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目目标

image-flow 是一个 VS Code 扩展，在编辑器内对 Markdown 调用 AI 绘图后端生成图片。后端经 **adapter 调用协议层 + Provider 数据模型** 解耦，内置 grsai 之外还支持用户在 `~/.image-flow/settings.json` 自定义任意 OpenAI 兼容 / Gemini 原生模型。核心能力：活动栏侧栏（Webview + React 前端）多标签页（工作台/编辑/任务/收藏/设置）；右键 Markdown 触发生成；解析正文图片语法为有序参考图做图生图；编辑页对上传/拖入的图片做图生图改写；**异步提交 + 后台轮询 + 重启续拉**的任务机制；任务统一落盘 `.image-flow/tasks/`；素材库与收藏夹。

## 常用命令

```bash
npm run compile        # 类型检查 + lint + esbuild 打包（dist/extension.js 与 media/sidebar.js）
npm run watch          # 并行监听：esbuild 增量打包 + tsc 类型检查（开发时常驻运行）
npm run package        # 生产构建（minify、无 sourcemap）
npm run check-types    # tsc --noEmit 类型检查（扩展主进程 + webview 两套 tsconfig）
npm run lint           # eslint src
npm test               # 运行扩展测试（vscode-test，会下载并启动 VS Code 实例）
```

调试扩展：按 `F5` 启动加载了扩展的新 VS Code 窗口，断点设在 `src/extension.ts`。改代码后从调试工具栏重启，或 `Ctrl+R` 重载窗口。

运行单个测试：测试通过 `.vscode-test.mjs` 匹配 `out/test/**/*.test.js`。先 `npm run compile-tests` 编译到 `out/`，再用 mocha 的 `--grep` 过滤（vscode-test 透传 mocha 参数），例如 `npx vscode-test --grep "测试名称"`。测试运行的是 `out/` 下的 JS，改完测试需重新编译。

## 架构要点

扩展有两条独立的构建产物，不要混淆：

- **`dist/extension.js`** — esbuild 打包的扩展主进程产物（入口 `src/extension.ts`），是 `package.json` 的 `main` 入口。CommonJS，`vscode` 模块标记为 external。这是真正被 VS Code 加载的代码。
- **`media/sidebar.js`** — esbuild 打包的 Webview 前端产物（入口 `src/webview/index.tsx`），React + IIFE、platform=browser。`esbuild.js` 同时构建这两个入口。新增 webview 组件 import 进入口即可，无需改 `esbuild.js`。
- **`out/`** — tsc 编译产物，仅供测试运行器使用，生产打包不经过这里。

两套类型检查：`check-types` 跑两次 `tsc --noEmit`——根 `tsconfig.json`（扩展主进程）+ `tsconfig.webview.json`（webview，含 React/DOM 类型）。esbuild 不做类型检查，所以 `compile`/`package` 都先跑 `check-types`。

`src/` 按域分目录：`backend/`（api + adapters + providers/providerRuntime 后端调用层）、`prompt/`（buildPrompt/inject/edit/editSession/prompts/editController 提示词与编辑）、`task/`（tasks/taskFiles/history/preview 任务）、`ui/`（sidebarProvider/config/materialsController/cliBridge/toWebview/sidebarHtml 宿主层）、`storage/`（storage/paths/materials/thumbs 落盘）、`favorites/`、`util/`（images/log/errors/notify 工具）、`webview/`（React 前端）。`src/extension.ts`、`src/shared.ts`、`src/refs.ts`、`src/modelOptions.ts` 在 src 根（前后端共用或入口）。

### 扩展生命周期

`activate`（`src/extension.ts`）做四件事：种入模型注入句（`seedModelInjections`，await 确保侧栏首读 config 时默认句已就位）→ 创建 `TaskManager` → 注册 `SidebarProvider` 与命令 → `taskManager.resume()` 续拉重启前未完成任务。`activationEvents: onStartupFinished` 保证开机即激活、无需展开侧栏。新增命令：`package.json` 的 `contributes.commands` 声明 + `activate` 内注册**同 ID** 实现，两处必须一致；所有可释放对象 push 进 `context.subscriptions`。

### 前后端通信与异步任务

侧栏前端与扩展主进程经 `postMessage` 通信，消息协议与共享类型集中在 `src/shared.ts`（唯一定义处，避免漂移）。`SidebarProvider`（`src/ui/sidebarProvider.ts`）持有 Webview、把文件 Uri 经 `asWebviewUri` 转成前端可加载的 `src`，并按页委派消息：工作台→`workbenchController`、素材库→`materialsController`、编辑页→`prompt/editController`、收藏→`favorites/favoritesController`。静态资源走 `asWebviewUri` + CSP nonce 加载。

**CLI 回环 HTTP 桥**（`src/ui/cliBridge.ts` + `skills/image-flow/imgflow.mjs`）：扩展激活时在 127.0.0.1:47870~47879 依次试绑 HTTP 服务，壳进程按同序扫描端口直连 `POST {token, op, md|cwd, args}`，同步拿结果。op 分两类：md 类 `list|fix|preview|submit`（md 兼作 421 窗口路由与安全边界）、cwd 类 `edit|query_result|list_task|list_model|favorite`（带 `cwd` 路由；favorite 把产物路径收进当前收藏夹并即时刷新侧栏，path 限工作区内）。模型调用类命令输出 JSON、成败看 `gen_status` 不看退出码（照抄即梦 dreamina CLI 约定）；submit/edit 按次覆盖参数的取值复用侧栏切模型逻辑（纯逻辑在 `src/ui/cliOpsLogic.ts`，有直测）。`edit` 是编辑模式（图生图，不经 md）：`--prompt` + 可重复 `--image`，一次调用 = 一个任务（多图 = 同一次编辑的多张参考图，批量套同一提示词由调用方循环），基线取编辑页配置（`editSubmitConfig`）、参考图路径按产品决策不限工作区（与编辑页可上传任意目录一致）。用户级 token 存 `~/.image-flow/token`，工作区零落盘。壳脚本与给 AI 读的 `SKILL.md` 同放 `skills/image-flow/`，整目录复制进目标项目的 `.claude/skills/` 即完成分发（`.vscodeignore` 已排除，不进 vsix）。设计细节与安全约定见项目记忆 `cli-bridge-design`、命令面设计见 `cli-model-commands-plan`。

**异步任务机制**（`src/task/tasks.ts` 的 `TaskManager`，公共提交流程 `start()`）：点生成 → 在工作区根 `.image-flow/tasks/<yyMMdd>/<HHmmssSSS>/` 建任务文件夹（任务标识 = `天/时刻` 含斜杠）并归档提示词 `.md` 与 `input/` 参考图 → 按并发数提交（**async adapter 串行提交、sync adapter 并行提交，策略相反各有原因，勿改**，理由见项目记忆 `task-submit-details`）→ 任务记录持久化进 `globalState` → 单定时器 4s 轮询 → 成图下载进任务文件夹，全部终结后移除记录。重启由 `resume()` 续拉。并发/比例/分辨率随模型联动（`src/modelOptions.ts`）与视频模型防误触（`videoOnlyVmd`）细节同见该记忆。

**单根工作区、单窗口是明确的产品决策**：`.image-flow` 存储都取 `workspaceFolders[0]`，不做多根/多窗口支持，相关审计发现一律按已接受取舍处理（见项目记忆 `no-multi-window-lock-support`）。

### 后端与提示词链路

后端调用分三层：`src/backend/api.ts` HTTP 底层（`fetchWithTimeout`/`parseGenerateResponse`/`normalizeBase`/`toVipPixels` 尺寸换算，不反向依赖 adapter）→ `src/backend/adapters/*` 各家调用协议（`grsai-async` 异步、`openai-images`/`gemini-generate` 同步、`openai-chat` 命名；凭 id 在 `index.ts` 注册，新协议加一个文件 + 登记一行）→ `providers.ts`（纯逻辑）+ `providerRuntime.ts`（node 侧 IO）合成 Provider 层，按当前配置解析「用哪个 adapter + baseUrl/apiKey」。**密钥边界：grsai 的 apiKey 走 secrets、发往 webview 的 `ConfigOptions` 绝不下发 url/key；自定义模型各自带 baseUrl/apiKey，缺 apiKey 时报错而非回落 grsai 密钥。** 架构详情与历史返工教训见项目记忆 `multi-api-adapter-architecture`。

提示词链路：`src/prompt/buildPrompt.ts` 把正文 `![](路径)` 解析为有序参考图 base64 + 替换为 `[imageN]` 引用；`src/prompt/inject.ts` 的 `buildInjectedPrompt` 拼「模型注入句 + 工作台预设模板（`.image-flow/prompts/<名>.md`）+ 正文」；提交（`task/tasks.ts`）与预览（`task/preview.ts`）都在 `buildPrompt` 之后各调一次。编辑链路模块分工见项目记忆 `edit-chain-modules`，收藏链路见 `favorites-architecture`。

## 代码约定

ESLint（`eslint.config.mjs`，flat config，作用于 `**/*.{ts,tsx}`）强制：`curly`、`eqeqeq`、`no-throw-literal`、`semi` 均为 warn；import 命名须为 camelCase 或 PascalCase。lint 是 `compile`/`package` 的前置步骤，不要留 warning。

Webview 侧栏样式在 `media/sidebar.css`（静态文件，不经 esbuild，改完重载窗口即生效，无需重新打包）。

## 工作流

每完成一轮修改、改到可提交的程度时，自动用 `/requesting-code-review` 审核代码；按审核意见修复，确认没问题后自动提交。

`docs/images/` 是「展示图片」文件夹：用户每次往里放截图给我看需求/效果。用完后清掉里面多余的展示图片，但保留该文件夹本身，不要删除文件夹。

## 参考资料

Grsai 接口完整参考（generate/result/chat/images 请求体、返回结构、vip 像素表）已迁入项目记忆 `grsai-api`。需要调用或改动后端 API 时先查那份记忆。
