# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目目标

image-flow 是一个 VS Code 扩展，目标是在编辑器内构建和管理 AI 绘图功能（见 `package.json` 的 description）。当前代码仍为官方脚手架（仅有 `helloWorld` 示例命令），AI 绘图相关能力尚未实现，需要从零搭建。

## 常用命令

```bash
npm run compile        # 类型检查 + lint + esbuild 打包到 dist/
npm run watch          # 并行监听：esbuild 增量打包 + tsc 类型检查（开发时常驻运行）
npm run package        # 生产构建（minify、无 sourcemap）
npm run check-types    # 仅 tsc --noEmit 类型检查
npm run lint           # eslint src
npm test               # 运行扩展测试（vscode-test，会下载并启动 VS Code 实例）
```

调试扩展：按 `F5` 启动加载了扩展的新 VS Code 窗口，断点设在 `src/extension.ts`。改代码后从调试工具栏重启，或 `Ctrl+R` 重载窗口。

运行单个测试：测试通过 `.vscode-test.mjs` 匹配 `out/test/**/*.test.js`。要跑单个测试，先 `npm run compile-tests` 编译到 `out/`，再用 mocha 的 `--grep` 过滤（vscode-test 透传 mocha 参数），例如 `npx vscode-test --grep "测试名称"`。注意测试运行的是 `out/` 下的 JS，不是 `src/` 的 TS，改完测试需重新编译。

## 架构要点

扩展有两条独立的构建产物，不要混淆：

- **`dist/extension.js`** — esbuild 打包的运行时产物（`esbuild.js` 配置），是 `package.json` 的 `main` 入口。打包为 CommonJS，`vscode` 模块标记为 external（由宿主在运行时注入）。这是真正被 VS Code 加载的代码。
- **`out/`** — tsc 编译产物，仅供测试运行器（vscode-test）使用。生产打包不经过这里。

两套类型检查：`tsc --noEmit`（check-types）只做校验不产出，实际打包由 esbuild 完成。esbuild 不做类型检查，所以 `compile`/`package` 脚本都先跑 `check-types` 再打包。

### 扩展生命周期

`src/extension.ts` 导出 `activate(context)` 与 `deactivate()`。命令在 `package.json` 的 `contributes.commands` 中声明，并在 `activate` 内用 `vscode.commands.registerCommand` 注册——两处的命令 ID（如 `image-flow.helloWorld`）必须完全一致。所有可释放对象（命令、监听器、面板等）都要 push 进 `context.subscriptions`，由宿主在停用时统一释放。

新增命令的标准流程：(1) 在 `package.json` 的 `contributes.commands` 声明；(2) 在 `activate` 中注册同 ID 的实现；(3) 如需按需激活，配置 `activationEvents`（当前为空数组，表示懒加载）。

### AI 绘图功能的落地方向

仓库目前是脚手架，`helloWorld` 是示例，可在实现真实功能后移除。AI 绘图通常需要 Webview UI（`vscode.window.createWebviewPanel`）来展示画布/结果，并通过 webview 与扩展主进程的 `postMessage` 通信调用绘图后端。引入这类资源时注意：webview 静态资源需走 `asWebviewUri`，且 esbuild 当前只打包 `src/extension.ts` 单入口，新增前端代码需相应扩展 `esbuild.js` 的 entryPoints。

## 代码约定

ESLint（`eslint.config.mjs`，flat config，仅作用于 `**/*.ts`）强制：`curly`、`eqeqeq`、`no-throw-literal`、`semi` 均为 warn；import 命名须为 camelCase 或 PascalCase。lint 是 `compile`/`package` 的前置步骤，不要留 warning。

## 参考文档

`docs/grsai-api.md` — Grsai 接口整理：nano-banana / gpt-image-2 生成（`POST /v1/api/generate`）、异步结果查询（`GET /v1/api/result`）、OpenAI 兼容的对话与图片生成接口。含节点地址、鉴权、请求体字段与返回结构。需要调用或改动 API 时先查这里。

