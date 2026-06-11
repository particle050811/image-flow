# VS Code Webview 资源缓存泄露 — 调查记录与对策

2026-06-11 排查用户 C 盘爆满（`%APPDATA%\Code\WebStorage` 23.5GB）的结论存档。
与本扩展相关：侧栏 webview 加载的图片会被 VS Code 永久缓存落盘；本扩展已做自清理
（`src/webview/resourceCache.ts`，commit 0c7bc16），但内置图片查看器的缓存扩展管不了。

## 机制

webview 无文件系统权限，本地资源一律经 `asWebviewUri` 虚拟地址加载，由 VS Code 内置
Service Worker（`src/vs/workbench/contrib/webview/browser/pre/service-worker.js`）代理。
该 SW 把每个带 ETag 的 200 响应 `cache.put()` 进 CacheStorage（缓存名
`vscode-resource-cache-<N>`，按完整 URL 含查询串作 key），**没有任何淘汰/配额/过期逻辑**，
连 `VERSION` 升级废弃的旧缓存也不删。落盘位置：`%APPDATA%\Code\WebStorage\<n>\CacheStorage`，
每个 webview 源（`vscode-webview://<uuid>`）一个目录，互相隔离。

两类灌水来源：

1. **本扩展侧栏**（素材库/任务历史以原图作 `<img src>`）：同一文件 URL 稳定，最多缓存一份，
   但量大且旧图删除后缓存不随之消失。→ **已修**：webview 与 SW 同源，
   `resourceCache.ts` 在启动时 + history/素材库消息到达时（5 分钟节流）自删
   `vscode-resource-cache*`。
2. **VS Code 内置图片查看器**（media-preview，点开图片文件即触发；本扩展 `openImage`
   走 `vscode.open` 也会落到它）：`imagePreview/index.ts` 的 `getResourcePath` 每次渲染
   给 URI 拼 `?version=${Date.now()}`——**每看一次图就永久缓存一份全图**，且该 URL 永远
   不会再被命中（纯死数据）。实测 6413 条缓存仅对应 1947 个文件，单图最多 86 份
   （同一晚 19:21–20:19，峰值一分钟 9 份），81% 抽样路径的原文件已删除。
   该缓存在 media-preview 自己的 origin 里，**本扩展够不着**。

视频/音频免疫：`<video>` 走 Range 请求（206），SW 标 `no-store` 且 Cache API 拒存部分
响应——所以泄露只咬高频看图的工作流，增长慢、难察觉。

## 上游状态（2026-06 核实）

- main 分支（新于 1.124.0）两处代码原样未动，升级版本无济于事。
- 历史报告均未善终：#131226（主 issue，2023-12 stale 关闭）、#166632（145GB，duplicate）、
  #152519（500GB，duplicate）；#310384（30GB，Remote-SSH）仍 open、有微软员工认领。
  本机案例已附根因分析提报上游（草稿见用户 `%TEMP%\vscode-issue-draft.md`）。

## 对本扩展的约束与方向

- **勿删** `resourceCache.ts` 的清理逻辑；若上游加了 LRU/淘汰，可降级为仅启动时清理。
- 根治方向与 TECH_DEBT F042② 同路：素材库/任务页给 webview 喂缩小版缩略图而非原图，
  缓存压力、内存、首屏延迟三者同收益。
- 用户侧缓解：检查生成图优先用侧栏缩略图（有自清理），少点开图片详情页；
  重度使用期手动清 `%APPDATA%\Code\WebStorage` 下的 CacheStorage 目录（纯缓存，关窗后删除安全）。
