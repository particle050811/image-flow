import * as vscode from 'vscode';

/**
 * 弹一条会自动消失的轻提示。
 *
 * VS Code 的 `showWarningMessage`/`showErrorMessage` 通知是常驻的（只能手动点 x 关掉），
 * 对「触发位置不对、其实啥也没干」这类无需用户处理的提示太打扰。借 `withProgress` 的
 * 通知在右下角弹出同样的 toast，并在 `timeoutMs` 后自动关闭。
 *
 * 仅用于可忽略的轻警告；真正需要用户读到并处理的错误（生成失败、后端报错、配置写坏）
 * 仍应走 `showErrorMessage` 保持常驻。
 */
export function showTransientWarning(message: string, timeoutMs = 4000): void {
	void vscode.window.withProgress(
		// withProgress 的通知没有警告图标，加 ⚠️ 前缀弥补丢失的警告语义
		{ location: vscode.ProgressLocation.Notification, title: `⚠️ ${message}`, cancellable: false },
		() => new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
	);
}
