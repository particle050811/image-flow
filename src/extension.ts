// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { previewPromptCommand } from './command';
import { SidebarProvider } from './sidebarProvider';
import { migrateLegacySettings } from './config';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// 一次性把旧版 settings.json 里的 image-flow.* 迁到 globalState/secrets
	void migrateLegacySettings(context);

	const sidebar = new SidebarProvider(context);

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
		vscode.commands.registerCommand('image-flow.previewPrompt', previewPromptCommand)
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
