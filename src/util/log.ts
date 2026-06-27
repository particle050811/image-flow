import * as vscode from 'vscode';

/** 「Image Flow」输出通道（台账日志）：记录任务提交/成败与错误，供排障。单例，激活时初始化 */
let channel: vscode.OutputChannel | undefined;

/** 激活时创建输出通道并交由 context 释放。重复调用复用同一通道 */
export function initLog(context: vscode.ExtensionContext): void {
	if (!channel) {
		channel = vscode.window.createOutputChannel('Image Flow');
		context.subscriptions.push(channel);
	}
}

/** 追加一行带时间戳的日志；通道未初始化（理论上不会）时静默丢弃。
 *  用 sv-SE 区域得到稳定可排序的 `YYYY-MM-DD HH:mm:ss`（按本机时区），不受界面语言影响 */
export function log(message: string): void {
	channel?.appendLine(`[${new Date().toLocaleString('sv-SE')}] ${message}`);
}
