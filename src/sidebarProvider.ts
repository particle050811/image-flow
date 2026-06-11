import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { uriBaseName } from './paths';
import { readConfig, writeConfig, CONFIG_OPTIONS, editConfigView } from './config';
import { listHistory, openRequestPreview, buildPreviewText, openTextPreview } from './command';
import { TaskManager, aggregateProgress } from './tasks';
import { EditSession } from './editSession';
import { listPromptTemplates } from './prompts';
import { tasksRoot } from './storage';
import { buildEditFinalPrompt } from './edit';
import {
	getLibraryFolders,
	addLibraryFolder,
	removeLibraryFolder,
	listLibraries,
	listAutoLibraries,
} from './materials';
import type {
	Task,
	WebviewTask,
	PendingTask,
	WebviewPendingTask,
	MaterialLibrary,
	WebviewLibrary,
	InboundMessage,
	OutboundMessage,
} from './shared';

/** 侧栏 Webview：承载配置表单、生成入口与结果/历史缩略图 */
export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'image-flow.sidebar';

	private view?: vscode.WebviewView;
	/** 当前侧栏关联的 Markdown（跟随当前活动编辑器；切到非 .md 标签时保留上一个，不清空） */
	private currentMd?: vscode.Uri;
	/** 编辑区图片列表：扩展侧持有，webview 重建不丢 */
	private readonly edit = new EditSession();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly tasks: TaskManager
	) {
		// 跟随当前活动编辑器：切到某个 .md 即生效；切到预览/代码/图片详情等非 Markdown 标签时
		// 保留上一个生效 MD 不变——否则点开任务图片详情会清空右侧任务/历史视图。
		// 只注册一次，避免侧栏反复 resolve 导致监听器泄漏。
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.syncActiveMd())
		);
		// 任务状态变更（提交/进度/完成）时刷新历史与待办视图。
		// 顺序要紧：先 await 重扫历史，再移除待办卡片——任务完成那一刻，
		// 完成的图先并入历史、待办卡片后消失，避免缩略图短暂空窗（闪烁）。
		// 不在此刷新素材库：任务进度不改变库内容（自动库非递归、只扫各层直接文件，任务图落在 task-* 子目录里扫不到），
		// 库刷新由 syncActiveMd（切 MD）与增删库操作各自触发。已知限制：手动库若递归覆盖了 task-* 输出目录，
		// 新生成的图要等下次 init/增删库才反映——这是为省掉每 4s 一次递归扫盘而接受的取舍，勿因此重加轮询扫描。
		context.subscriptions.push(
			this.tasks.onChange(async () => {
				await this.pushHistory();
				this.pushPendingTasks();
			})
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
			// media 放扩展资源；工作区目录 + 素材库目录用于按 asWebviewUri 加载缩略图
			localResourceRoots: this.buildResourceRoots(),
		};
		view.webview.html = this.html(view.webview);

		// 顶层兜底：onMessage 内多数分支自带 try/catch，但 saveConfig/openImage 等少数分支
		// 失败会成为静默的 unhandled rejection——统一转为前端可见的错误提示
		view.webview.onDidReceiveMessage((msg) =>
			this.onMessage(msg).catch((err: unknown) =>
				this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
			)
		);
		view.onDidDispose(() => {
			this.view = undefined;
		});

		this.syncActiveMd();
	}

	/** 跟随当前活动编辑器：是 .md 则关联；非 Markdown（含无编辑器）则保留上一个生效 MD 不变。
	 *  仅在关联文件真正变化时才重扫历史 */
	private syncActiveMd(): void {
		const uri = this.activeMd();
		if (!uri) {
			return;
		}
		const changed = this.currentMd?.toString() !== uri.toString();
		this.currentMd = uri;
		this.post({ type: 'activeMd', name: this.baseName(this.currentMd) });
		if (changed) {
			void this.pushAutoLibraries();
		}
	}

	/** 当前活动编辑器若是 .md 则返回其 Uri，否则 undefined（非 Markdown 标签不改变生效 MD） */
	private activeMd(): vscode.Uri | undefined {
		const uri = vscode.window.activeTextEditor?.document.uri;
		if (uri && uri.path.toLowerCase().endsWith('.md')) {
			return uri;
		}
		return undefined;
	}

	private baseName(uri: vscode.Uri): string {
		return uriBaseName(uri);
	}

	private async onMessage(msg: OutboundMessage): Promise<void> {
		switch (msg.type) {
			case 'init': {
				const config = await readConfig(this.context);
				this.post({ type: 'config', config, options: CONFIG_OPTIONS });
				this.post({ type: 'activeMd', name: this.currentMd ? this.baseName(this.currentMd) : null });
				this.pushPendingTasks();
				await this.pushHistory();
				await this.pushLibraries();
				await this.pushAutoLibraries();
				this.pushEditImages();
				await this.pushTemplates();
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
			case 'previewRequest':
				await this.doPreviewRequest();
				break;
			case 'openImage':
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.uri));
				break;
			case 'insertImage':
				await this.insertImageRef(msg.uri);
				break;
			case 'openExternal':
				await vscode.env.openExternal(vscode.Uri.parse(msg.url));
				break;
			case 'refreshHistory':
				await this.pushHistory();
				break;
			case 'addLibrary':
				await this.pickAndAddLibrary();
				break;
			case 'removeLibrary':
				await removeLibraryFolder(this.context, msg.folder);
				this.refreshResourceRoots();
				await this.pushLibraries();
				break;
			case 'editUpload':
				await this.pickEditImages();
				break;
			case 'editAddImages':
				await this.addEditImages(msg.uris);
				break;
			case 'editAddImagesData': {
				// 批量收齐后一次性添加 + 单次推送：避免逐张消息 × 各全量推送的 O(N²) 序列化
				const errors = msg.items
					.map((item) => this.edit.addData(item.name, item.data))
					.filter((e): e is string => !!e);
				if (errors.length) {
					this.post({ type: 'error', message: errors.join('；') });
				}
				this.pushEditImages();
				break;
			}
			case 'editRemoveImage':
				this.edit.remove(msg.name);
				this.pushEditImages();
				break;
			case 'editGenerate':
				await this.doEditGenerate(msg.prompt);
				break;
			case 'editPreviewRequest':
				await this.doEditPreview(msg.prompt);
				break;
			case 'openPrompt':
				await this.openTaskPrompt(msg.folder);
				break;
			case 'refreshTemplates':
				await this.pushTemplates();
				break;
		}
	}

	/** 弹出文件夹选择器，把选中的目录加为素材库 */
	private async pickAndAddLibrary(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: '作为素材库添加',
		});
		if (!picked?.length) {
			return;
		}
		await addLibraryFolder(this.context, picked[0].toString());
		this.refreshResourceRoots();
		await this.pushLibraries();
	}

	/** 弹出文件选择器，把选中图片加入编辑区 */
	private async pickEditImages(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			openLabel: '加入编辑区',
			filters: { 图片: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
		});
		if (!picked?.length) {
			return;
		}
		await this.addEditImages(picked.map((u) => u.toString()));
	}

	/** 批量按 uri 加入编辑区：逐张收集错误（重名/非图/读取失败），一次性提示 */
	private async addEditImages(uris: string[]): Promise<void> {
		const errors: string[] = [];
		for (const uri of uris) {
			const err = await this.edit.addUri(uri);
			if (err) {
				errors.push(err);
			}
		}
		if (errors.length) {
			this.post({ type: 'error', message: errors.join('；') });
		}
		this.pushEditImages();
	}

	private pushEditImages(): void {
		this.post({
			type: 'editImages',
			images: this.edit.list().map((i) => ({ name: i.name, src: i.data })),
		});
	}

	private async pushTemplates(): Promise<void> {
		this.post({ type: 'promptTemplates', templates: await listPromptTemplates() });
	}

	/** 编辑页生成：校验 Key → submitEdit 提交异步任务 */
	private async doEditGenerate(prompt: string): Promise<void> {
		const config = await readConfig(this.context);
		if (!config.apiKey) {
			this.post({ type: 'error', message: '尚未配置 API Key，请在设置页填写。' });
			return;
		}
		this.post({ type: 'busy', busy: true });
		try {
			await this.tasks.submitEdit(prompt, this.edit.list());
			this.post({ type: 'status', message: '已提交编辑任务，正在后台生成…' });
			this.post({ type: 'navigate', tab: 'tasks' });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		} finally {
			this.post({ type: 'busy', busy: false });
		}
	}

	/** 编辑页预览请求：与 submitEdit 共用 buildEditFinalPrompt，打开成预览文档（不调 API） */
	private async doEditPreview(prompt: string): Promise<void> {
		try {
			const base = await readConfig(this.context);
			const refs = this.edit.list();
			const finalPrompt = buildEditFinalPrompt(base, prompt, refs.map((r) => r.name));
			await openTextPreview(buildPreviewText(editConfigView(base), finalPrompt, refs.map((r) => r.data)));
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		}
	}

	/** 打开任务文件夹内的提示词 .md 文件（文件名不固定，按扩展名找第一个） */
	private async openTaskPrompt(folder: string): Promise<void> {
		try {
			const dir = vscode.Uri.joinPath(tasksRoot(), folder);
			const entries = await vscode.workspace.fs.readDirectory(dir);
			const md = entries.find(
				([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.md')
			);
			if (!md) {
				this.post({ type: 'error', message: '该任务没有保存提示词文件。' });
				return;
			}
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(dir, md[0]));
		} catch {
			this.post({ type: 'error', message: '提示词文件打开失败。' });
		}
	}

	/** 构造 webview 的资源根：扩展 media + 工作区目录 + 各素材库目录 */
	private buildResourceRoots(): vscode.Uri[] {
		return [
			vscode.Uri.joinPath(this.context.extensionUri, 'media'),
			...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
			...getLibraryFolders(this.context).map((f) => vscode.Uri.parse(f)),
		];
	}

	/** 素材库增删后重设 localResourceRoots，使新目录的缩略图可加载 */
	private refreshResourceRoots(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.options = {
			enableScripts: true,
			localResourceRoots: this.buildResourceRoots(),
		};
	}

	private async pushLibraries(): Promise<void> {
		const libs = await listLibraries(this.context);
		this.post({ type: 'libraries', libraries: libs.map((l) => this.toWebviewLibrary(l)) });
	}

	/** 推送随当前 Markdown 路径自动生成的素材库（无 MD 时清空） */
	private async pushAutoLibraries(): Promise<void> {
		const libs = this.currentMd ? await listAutoLibraries(this.currentMd) : [];
		this.post({ type: 'autoLibraries', libraries: libs.map((l) => this.toWebviewLibrary(l)) });
	}

	/**
	 * 右键素材缩略图：把图片以相对引用插入「生效页面」光标处。
	 * 生效页面 = 侧栏关联的 MD（currentMd）。仅当当前活动编辑器正是该 MD 时才插入，
	 * 否则忽略——避免插到小说原文、预览或别的文件里。
	 */
	private async insertImageRef(imageUri: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (
			!this.currentMd ||
			!editor ||
			editor.document.uri.toString() !== this.currentMd.toString()
		) {
			vscode.window.showWarningMessage('Image Flow：未插入——当前活动编辑器不是生效页面');
			return;
		}
		const mdDir = path.dirname(this.currentMd.fsPath);
		const imgPath = vscode.Uri.parse(imageUri).fsPath;
		let rel = path.relative(mdDir, imgPath).split(path.sep).join('/');
		// 跨盘符时 path.relative 退回绝对路径（如 E:/foo.png），无法用相对引用表示。
		if (path.isAbsolute(rel)) {
			vscode.window.showWarningMessage('Image Flow：未插入——图片与文档不在同一磁盘，无法相对引用');
			return;
		}
		if (!rel.startsWith('.')) {
			rel = './' + rel;
		}
		const alt = path.basename(imgPath, path.extname(imgPath));
		// 路径含空格或半角括号时用尖括号包裹，否则 Markdown 会在空格处截断或被 ) 提前闭合。
		// 中文/全角括号对 CommonMark 是普通字符，无需处理，保持可读。
		const dest = /[ ()]/.test(rel) ? `<${rel}>` : rel;
		const snippet = `![${alt}](${dest})`;
		await editor.edit((b) => b.insert(editor.selection.active, snippet));
	}

	/** 预览请求：对当前关联的 MD 解析提示词 + 拼请求参数，打开成预览文档（不调 API） */
	private async doPreviewRequest(): Promise<void> {
		if (!this.currentMd) {
			this.post({ type: 'error', message: '请先在编辑器中打开一个 Markdown 文件。' });
			return;
		}
		try {
			const config = await readConfig(this.context);
			await openRequestPreview(config, this.currentMd);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		}
	}

	/** 执行生成：校验 Key → 调 taskManager.submit 提交异步任务（立即返回，后台轮询） */
	private async doGenerate(mdUri: vscode.Uri): Promise<void> {
		const config = await readConfig(this.context);
		if (!config.apiKey) {
			this.post({ type: 'error', message: '尚未配置 API Key，请在上方填写并保存。' });
			return;
		}
		this.post({ type: 'busy', busy: true });
		try {
			await this.tasks.submit(mdUri);
			this.post({ type: 'status', message: '已提交生成任务，正在后台生成…' });
			this.post({ type: 'navigate', tab: 'tasks' });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		} finally {
			this.post({ type: 'busy', busy: false });
		}
	}

	private async pushHistory(): Promise<void> {
		const tasks: Task[] = await listHistory(this.tasks.activeFolders());
		this.post({ type: 'history', tasks: tasks.map((t) => this.toWebviewTask(t)) });
	}

	/** 推送进行中任务（聚合进度 + 已存缩略图）给前端；全部进行中任务，不按 MD 过滤 */
	private pushPendingTasks(): void {
		const tasks = this.tasks.list();
		this.post({
			type: 'pendingTasks',
			tasks: tasks.map((t) => this.toWebviewPendingTask(t)),
		});
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

	/** 把进行中任务转成 webview 视图：聚合进度 + 已存缩略图带 src */
	private toWebviewPendingTask(task: PendingTask): WebviewPendingTask {
		const webview = this.view?.webview;
		const done = task.jobs.filter((j) => j.status === 'succeeded').length;
		const failed = task.jobs.filter((j) => j.status === 'failed' || j.status === 'violation').length;
		const submitting = task.jobs.filter((j) => j.status === 'submitting').length;
		const errors = task.jobs.map((j) => j.error).filter((e): e is string => !!e);
		return {
			id: task.id,
			folder: task.folder,
			model: task.model,
			total: task.jobs.length,
			done,
			failed,
			submitting,
			progress: aggregateProgress(task.jobs),
			startedAt: task.startedAt,
			errors,
			images: task.images.map((img) => ({
				...img,
				src: webview ? webview.asWebviewUri(vscode.Uri.parse(img.uri)).toString() : img.uri,
			})),
		};
	}

	/** 把素材库里的文件 Uri 转成 webview 可加载的 src */
	private toWebviewLibrary(lib: MaterialLibrary): WebviewLibrary {
		const webview = this.view?.webview;
		return {
			folder: lib.folder,
			name: lib.name,
			images: lib.images.map((img) => ({
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
		// style-src 必须含 'unsafe-inline'：Radix（Select/Collapsible 等）的浮层定位、
		// 滚动锁、动画高度均通过元素级内联 style 属性实现，而 CSP nonce/hash 只覆盖
		// <style>/<script> 标签、管不到内联 style 属性，故无法收紧为 nonce。脚本仍锁 nonce。
		// img-src 须含 data:：编辑区图片统一以 data URI 推送（可能来自 localResourceRoots 之外）。
		const csp =
			`default-src 'none'; img-src ${webview.cspSource} data:; ` +
			`style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
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
