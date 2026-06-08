# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目目标

image-flow 是一个 VS Code 扩展，在编辑器内对 Markdown 调用 AI 绘图后端（Grsai）生成图片。核心能力已实现：活动栏侧栏（Webview + React 前端）承载配置、生成入口与结果/历史/素材库；右键 Markdown 触发生成；解析正文图片语法为有序参考图做图生图；**异步提交 + 后台轮询 + 重启续拉**的任务机制；可调缩略图尺寸的素材库与按 MD 路径自动生成的素材库。

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

运行单个测试：测试通过 `.vscode-test.mjs` 匹配 `out/test/**/*.test.js`。要跑单个测试，先 `npm run compile-tests` 编译到 `out/`，再用 mocha 的 `--grep` 过滤（vscode-test 透传 mocha 参数），例如 `npx vscode-test --grep "测试名称"`。注意测试运行的是 `out/` 下的 JS，不是 `src/` 的 TS，改完测试需重新编译。

## 架构要点

扩展有两条独立的构建产物，不要混淆：

- **`dist/extension.js`** — esbuild 打包的扩展主进程产物（`esbuild.js` 的 extension 入口 `src/extension.ts`），是 `package.json` 的 `main` 入口。CommonJS，`vscode` 模块标记为 external（由宿主在运行时注入）。这是真正被 VS Code 加载的代码。
- **`media/sidebar.js`** — esbuild 打包的 Webview 前端产物（webview 入口 `src/webview/index.tsx`），React + IIFE、platform=browser，由侧栏 HTML 的 `<script>` 加载。`esbuild.js` 同时构建这两个入口。
- **`out/`** — tsc 编译产物，仅供测试运行器（vscode-test）使用。生产打包不经过这里。

两套类型检查：`check-types` 跑两次 `tsc --noEmit`——一次走根 `tsconfig.json`（扩展主进程），一次走 `tsconfig.webview.json`（webview 前端，含 React/DOM 类型）。esbuild 不做类型检查，所以 `compile`/`package` 脚本都先跑 `check-types` 再打包。

### 扩展生命周期

`src/extension.ts` 导出 `activate(context)` 与 `deactivate()`。`activate` 里做四件事：迁移旧版 settings、创建 `TaskManager`（异步任务管理器）、注册 `SidebarProvider`（侧栏 Webview）与命令、最后调 `taskManager.resume()` 续拉重启前未完成的任务。命令在 `package.json` 的 `contributes.commands` 中声明，并在 `activate` 内用 `vscode.commands.registerCommand` 注册——两处命令 ID（`image-flow.generateImage`、`image-flow.previewRequest`）必须完全一致。所有可释放对象（命令、监听器、TaskManager 等）都要 push 进 `context.subscriptions`，由宿主在停用时统一释放。

`activationEvents` 为空数组：扩展靠 `contributes.views` 贡献的侧栏视图在用户打开活动栏图标时激活，无需显式事件。注意 `resume()` 因此依赖侧栏视图容器被加载——若需要「即使从未展开侧栏也启动续拉」，要给 `activationEvents` 补 `onStartupFinished`。

新增命令的标准流程：(1) 在 `package.json` 的 `contributes.commands` 声明；(2) 在 `activate` 中注册同 ID 的实现；(3) 如需特定时机激活，配置 `activationEvents`。

### 前后端通信与异步任务

侧栏前端（`src/webview/`，React）与扩展主进程通过 `postMessage` 通信，消息协议与共享类型集中在 `src/shared.ts`（唯一定义处，前后端都从这里取，避免漂移）。`SidebarProvider`（`src/sidebarProvider.ts`）持有 Webview、转发消息、把文件 Uri 经 `asWebviewUri` 转成前端可加载的 `src`。Webview 静态资源（`media/sidebar.js`、`media/sidebar.css`）走 `asWebviewUri` + CSP nonce 加载。

生成走**异步任务机制**（`src/tasks.ts` 的 `TaskManager`）：点生成 → 按并发数用 `replyType:'async'` 并发提交拿 job id → 任务记录持久化进 `globalState` → 单个定时器（4s）轮询 `GET /v1/api/result`，某 job 成功就把图下载到 `task-<时间戳>-<seq>` 文件夹 → 全部 job 终结后从持久化移除。重启时 `resume()` 续拉未完成任务。任务进行中卡片在「任务」标签页顶部展示，`listHistory` 用 `activeFolders()` 排除进行中文件夹避免与待办重复。

API 调用封装在 `src/api.ts`（`submitGeneration` / `queryResult`），Markdown 正文解析与参考图处理在 `src/command.ts`（`buildPrompt` 把 `![](路径)` 解析为有序参考图 base64 + 替换为 `[imageN]` 引用），素材库扫描在 `src/materials.ts`。提示词注入在 `src/inject.ts`（`buildInjectedPrompt` 把「模型注入句 + 工作区根 IMAGES.md + 正文」拼成最终 prompt，模型注入句按模型内置兜底、可在侧栏覆盖），提交（`tasks.ts`）与预览（`command.ts`）两处都在 `buildPrompt` 之后各调一次。新增 webview 前端代码无需改 `esbuild.js`（webview 入口已是 `src/webview/index.tsx` 单 bundle，新组件 import 进去即可）。

## 代码约定

ESLint（`eslint.config.mjs`，flat config，作用于 `**/*.{ts,tsx}`）强制：`curly`、`eqeqeq`、`no-throw-literal`、`semi` 均为 warn；import 命名须为 camelCase 或 PascalCase。lint 是 `compile`/`package` 的前置步骤，不要留 warning。

Webview 侧栏样式在 `media/sidebar.css`（静态文件，不经 esbuild，改完重载窗口即生效，无需重新打包）。

## 参考文档

`docs/grsai-api.md` — Grsai 接口整理：nano-banana / gpt-image-2 生成（`POST /v1/api/generate`）、异步结果查询（`GET /v1/api/result`）、OpenAI 兼容的对话与图片生成接口。含节点地址、鉴权、请求体字段与返回结构。需要调用或改动 API 时先查这里。

