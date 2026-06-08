import * as vscode from 'vscode';
import { previewRequestCommand } from './command';
import { SidebarProvider } from './sidebarProvider';
import { TaskManager } from './tasks';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// 异步任务管理器：提交/轮询/持久化。配合 onStartupFinished 激活，开机即 resume 续拉重启前未完成的任务。
	const taskManager = new TaskManager(context);
	context.subscriptions.push(taskManager);

	const sidebar = new SidebarProvider(context, taskManager);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar),
		vscode.commands.registerCommand('image-flow.generateImage', async (uri?: vscode.Uri) => {
			// 菜单传入 uri；从命令面板触发时回退到当前活动编辑器
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!target) {
				vscode.window.showErrorMessage('Image Flow：请在 Markdown 文件上右键，或先打开一个文件。');
				return;
			}
			await sidebar.generateFor(target);
		}),
		vscode.commands.registerCommand('image-flow.previewRequest', (uri?: vscode.Uri) =>
			previewRequestCommand(context, uri)
		)
	);

	taskManager.resume();
}

// This method is called when your extension is deactivated
export function deactivate() {}
