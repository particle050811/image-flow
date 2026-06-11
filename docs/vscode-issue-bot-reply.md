The bug is version-independent: I verified the current `main` branch (newer than 1.124.0) and both halves of the leak are unchanged —

- [`imagePreview/index.ts` `getResourcePath`](https://github.com/microsoft/vscode/blob/main/extensions/media-preview/src/imagePreview/index.ts) still appends `?version=${Date.now()}` on every render;
- [`service-worker.js`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/service-worker.js) still `cache.put`s every 200-with-ETag response into `vscode-resource-cache-5` and contains no eviction logic (no `caches.delete` anywhere; the `activate` handler is only `clients.claim()`, so even the obsolete `vscode-resource-cache-4` from the previous `VERSION` is never removed — I have both on disk).

Upgrading therefore cannot resolve this; the repro in the original report works on any current build.
