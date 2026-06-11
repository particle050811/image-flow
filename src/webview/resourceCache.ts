// 清理 VS Code webview 的本地资源缓存（vscode-resource-cache*）。
//
// 背景：webview 内置 Service Worker 会把每个经 asWebviewUri 加载的本地文件响应
// 永久写入 CacheStorage（落盘在用户目录 Code\WebStorage 下），且没有任何淘汰机制。
// 本扩展的素材库/任务历史会加载大量全尺寸生成图（单张可达 20MB），长期使用实测
// 积累 20GB+ 磁盘占用。扩展主进程关不掉这个缓存，但 webview 与 Service Worker
// 同源，可以自己删——清掉后图片下次展示时从本地磁盘重新加载，开销极小。
// 已知极窄竞态：清理恰好落在 Service Worker open/put 之间时，个别图片可能偶发
// 加载失败一次，刷新即恢复，扩展侧无法根治，接受。

const THROTTLE_MS = 5 * 60 * 1000;
let lastCleared = 0;

/** 立即清理资源缓存（webview 启动时调用，消掉历史会话的累积） */
export async function clearResourceCaches(): Promise<void> {
	lastCleared = Date.now();
	try {
		const keys = await caches.keys();
		await Promise.all(
			keys.filter((k) => k.startsWith('vscode-resource-cache')).map((k) => caches.delete(k))
		);
	} catch {
		// CacheStorage 不可用时静默忽略：缓存清不掉只影响磁盘占用，不影响功能
	}
}

/** 节流清理：历史刷新等高频时机调用，最多每 5 分钟清一次，限制长会话内的增长 */
export function clearResourceCachesThrottled(): void {
	if (Date.now() - lastCleared < THROTTLE_MS) {
		return;
	}
	void clearResourceCaches();
}
