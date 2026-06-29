import * as vscode from 'vscode';

/**
 * 弹一条会自动消失的 toast（右下角通知，`timeoutMs` 后自动关闭）。
 *
 * VS Code 的 `showWarningMessage`/`showInformationMessage` 通知是常驻的（只能手动点 x 关掉），
 * 对「触发位置不对、其实啥也没干」「已完成某操作」这类无需用户处理的提示太打扰。借
 * `withProgress` 的通知实现同样的 toast，但能自动消失。
 *
 * 仅用于可忽略的轻提示；真正需要用户读到并处理的错误（生成失败、后端报错、配置写坏）
 * 仍应走 `showErrorMessage` 保持常驻。
 */
function showTransient(title: string, timeoutMs: number): void {
	void vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
		() => new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
	);
}

/** 自动消失的轻警告（withProgress 通知没有警告图标，加 ⚠️ 前缀弥补丢失的警告语义） */
export function showTransientWarning(message: string, timeoutMs = 4000): void {
	showTransient(`⚠️ ${message}`, timeoutMs);
}

/** 自动消失的轻提示（成功/完成等，无图标前缀） */
export function showTransientInfo(message: string, timeoutMs = 4000): void {
	showTransient(message, timeoutMs);
}
