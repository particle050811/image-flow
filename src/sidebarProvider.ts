import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { readConfig, writeConfig, CONFIG_OPTIONS } from './config';
import { runGeneration, listHistory } from './command';
import type { Task, WebviewTask, InboundMessage, OutboundMessage } from './shared';

/** 侧栏 Webview：承载配置表单、生成入口与结果/历史缩略图 */
export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'image-flow.sidebar';

	private view?: vscode.WebviewView;
	/** 当前侧栏关联的 Markdown（随活动编辑器切换） */
	private currentMd?: vscode.Uri;

	constructor(private readonly context: vscode.ExtensionContext) {
		// 活动编辑器切换时同步关联文件——只注册一次，避免侧栏反复 resolve 导致监听器泄漏
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.syncActiveMd())
		);
	}

	/** 供右键命令调用：聚焦侧栏并对指定 MD 触发生成 */
	public async generateFor(mdUri: vscode.Uri): Promise<void> {
		this.currentMd = mdUri;
		await vscode.commands.executeCommand('image-flow.sidebar.focus');
		await this.doGenerate(mdUri);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			// media 放扩展资源；工作区目录用于按 asWebviewUri 加载生成的图片缩略图
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'media'),
				...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
			],
		};
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
		view.onDidDispose(() => {
			this.view = undefined;
		});

		this.syncActiveMd();
	}

	/** 把当前活动的 Markdown 同步给前端；仅在关联文件变化时才重扫历史 */
	private syncActiveMd(): void {
		const uri = vscode.window.activeTextEditor?.document.uri;
		let changed = false;
		if (uri && uri.path.toLowerCase().endsWith('.md')) {
			changed = this.currentMd?.toString() !== uri.toString();
			this.currentMd = uri;
		}
		this.post({ type: 'activeMd', name: this.currentMd ? this.baseName(this.currentMd) : null });
		if (changed) {
			void this.pushHistory();
		}
	}

	private baseName(uri: vscode.Uri): string {
		return uri.path.split('/').pop() ?? uri.path;
	}

	private async onMessage(msg: OutboundMessage): Promise<void> {
		switch (msg.type) {
			case 'init': {
				const config = await readConfig(this.context);
				this.post({ type: 'config', config, options: CONFIG_OPTIONS });
				this.post({ type: 'activeMd', name: this.currentMd ? this.baseName(this.currentMd) : null });
				await this.pushHistory();
				break;
			}
			case 'saveConfig':
				await writeConfig(this.context, msg.patch);
				break;
			case 'generate':
				if (this.currentMd) {
					await this.doGenerate(this.currentMd);
				} else {
					this.post({ type: 'error', message: '请先在编辑器中打开一个 Markdown 文件。' });
				}
				break;
			case 'openImage':
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.uri));
				break;
			case 'openExternal':
				await vscode.env.openExternal(vscode.Uri.parse(msg.url));
				break;
			case 'refreshHistory':
				await this.pushHistory();
				break;
		}
	}

	/** 执行生成：校验 Key → 调 runGeneration → 推送新任务与刷新历史 */
	private async doGenerate(mdUri: vscode.Uri): Promise<void> {
		const config = await readConfig(this.context);
		if (!config.apiKey) {
			this.post({ type: 'error', message: '尚未配置 API Key，请在上方填写并保存。' });
			return;
		}
		this.post({ type: 'busy', busy: true });
		try {
			const task = await runGeneration(config, mdUri, (p) => {
				if (p.phase === 'start') {
					this.post({ type: 'status', message: `正在并发生成 ${p.count} 张…` });
				} else if (p.phase === 'error') {
					this.post({ type: 'status', message: `一次生成失败：${p.message}` });
				}
			});
			this.post({ type: 'done', task: this.toWebviewTask(task) });
			await this.pushHistory();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		} finally {
			this.post({ type: 'busy', busy: false });
		}
	}

	private async pushHistory(): Promise<void> {
		const tasks: Task[] = this.currentMd ? await listHistory(this.currentMd) : [];
		this.post({ type: 'history', tasks: tasks.map((t) => this.toWebviewTask(t)) });
	}

	/** 把任务里的文件 Uri 转成 webview 可加载的 src（asWebviewUri） */
	private toWebviewTask(task: Task): WebviewTask {
		const webview = this.view?.webview;
		return {
			folder: task.folder,
			images: task.images.map((img) => ({
				...img,
				src: webview ? webview.asWebviewUri(vscode.Uri.parse(img.uri)).toString() : img.uri,
			})),
		};
	}

	private post(msg: InboundMessage): void {
		void this.view?.webview.postMessage(msg);
	}

	private html(webview: vscode.Webview): string {
		const uri = (f: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
		const nonce = nonceStr();
		const csp =
			`default-src 'none'; img-src ${webview.cspSource}; ` +
			`style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('sidebar.css')}" rel="stylesheet">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('sidebar.js')}"></script>
</body>
</html>`;
	}
}

/** 生成 CSP nonce（扩展运行在 Node 主进程，用 crypto 安全随机） */
function nonceStr(): string {
	return randomBytes(16).toString('hex');
}
