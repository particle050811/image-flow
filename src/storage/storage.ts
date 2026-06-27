import * as vscode from 'vscode';
import * as os from 'os';

/**
 * 自定义 Provider 配置文件：~/.image-flow/settings.json（跨工作区全局，在用户主目录）。
 * 注意区别于工作区内的 .image-flow/tasks|favorites（那些按工作区隔离）。
 */
export function settingsFile(): vscode.Uri {
	return vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), '.image-flow', 'settings.json');
}

/** 第一个工作区文件夹的 Uri；无工作区返回 undefined */
export function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** 取工作区根，没有则抛出友好错误（生成/编辑入口统一靠它拦截无工作区场景） */
function requireRoot(): vscode.Uri {
	const root = workspaceRoot();
	if (!root) {
		throw new Error('未打开工作区文件夹，无法使用 .image-flow 存储目录。');
	}
	return root;
}

/** 所有任务（生成 + 编辑）的统一存放目录：<工作区根>/.image-flow/tasks */
export function tasksRoot(): vscode.Uri {
	return vscode.Uri.joinPath(requireRoot(), '.image-flow', 'tasks');
}

/** 预设提示词模板目录：<工作区根>/.image-flow/prompts */
export function promptsRoot(): vscode.Uri {
	return vscode.Uri.joinPath(requireRoot(), '.image-flow', 'prompts');
}
