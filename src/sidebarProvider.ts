import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { uriBaseName } from './paths';
import { readConfig, writeConfig, CONFIG_OPTIONS } from './config';
import { listHistory, openRequestPreview, openTextPreview, isPreviewDoc } from './command';
import { TaskManager } from './tasks';
import { EditSession } from './editSession';
import { listPromptTemplates } from './prompts';
import { tasksRoot } from './storage';
import { saveThumb } from './thumbs';
import { log } from './log';
import { errMsg } from './errors';
import { buildEditFinalPrompt } from './edit';
import {
	readFavorites,
	mutateFavorites,
	pruneMissing,
	favoriteUriSet,
	renameFavoriteUri,
	collectionNameError,
} from './favorites';
import { FavoritesController } from './favoritesController';
import {
	getLibraryFolders,
	addLibraryFolder,
	removeLibraryFolder,
	listLibraries,
	listAutoLibraries,
	readImageDesc,
	aliasFromDesc,
} from './materials';
import type {
	Task,
	WebviewCollection,
	InboundMessage,
	OutboundMessage,
} from './shared';
import {
	toWebviewImages,
	toWebviewTask,
	toWebviewPendingTask,
	toWebviewLibrary,
} from './toWebview';

/** 侧栏 Webview：承载配置表单、生成入口与结果/历史缩略图 */
export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'image-flow.sidebar';

	private view?: vscode.WebviewView;
	/** 当前侧栏关联的 Markdown（跟随当前活动编辑器；切到非 .md 标签时保留上一个，不清空） */
	private currentMd?: vscode.Uri;
	/** 编辑区图片列表：扩展侧持有，webview 重建不丢 */
	private readonly edit = new EditSession();
	/** 收藏夹相关消息处理（CRUD/导出/切换），视图推送经回调回到本类 */
	private readonly favorites = new FavoritesController({
		post: (msg) => this.post(msg),
		pushFavorites: () => this.pushFavorites(),
		pushAfterChange: () => this.pushAfterFavoritesChange(),
	});

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
				await this.pushPendingTasks();
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
			this.onMessage(msg).catch((err: unknown) => this.postError(err))
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

	/** 当前活动编辑器若是 .md 则返回其 Uri，否则 undefined（非 Markdown 标签不改变生效 MD）。
	 *  请求预览文档虽是 .md 但内容是请求参数，排除掉避免它顶替生效 MD 改变上方渲染——
	 *  误触拦截改到预览/生成时按「主标签页 != 生效 MD」统一处理 */
	private activeMd(): vscode.Uri | undefined {
		const uri = vscode.window.activeTextEditor?.document.uri;
		if (uri && uri.path.toLowerCase().endsWith('.md') && !isPreviewDoc(uri)) {
			return uri;
		}
		return undefined;
	}

	/** 主编辑区当前激活标签打开的文件是否正是生效 MD（currentMd）。
	 *  切到 preview.md、图片等其它标签后 currentMd 不变，此时返回 false，用于在预览/生成时拦截 */
	private activeTabIsCurrentMd(): boolean {
		if (!this.currentMd) {
			return false;
		}
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const uri =
			input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
				? input.uri
				: undefined;
		return uri?.toString() === this.currentMd.toString();
	}

	/** 预览/生成前的统一校验：有生效 MD 且正是主标签页打开的文件才返回它，否则弹错并返回 undefined。
	 *  action 用于错误文案（“生成”/“预览请求”） */
	private requireActiveMd(action: string): vscode.Uri | undefined {
		if (!this.currentMd) {
			this.post({ type: 'error', message: '请先在编辑器中打开一个 Markdown 文件。' });
			return undefined;
		}
		if (!this.activeTabIsCurrentMd()) {
			this.post({ type: 'error', message: `主标签页当前打开的不是加载文件「${this.baseName(this.currentMd)}」，无法${action}。请切回该文件再操作。` });
			return undefined;
		}
		return this.currentMd;
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
				await this.pushPendingTasks();
				await this.pushHistory();
				await this.pushLibraries();
				await this.pushAutoLibraries();
				this.pushEditImages();
				await this.pushTemplates();
				await this.pushFavorites();
				break;
			}
			case 'saveConfig':
				await writeConfig(this.context, msg.patch);
				break;
			case 'generate': {
				const md = this.requireActiveMd('生成');
				if (md) {
					await this.doGenerate(md);
				}
				break;
			}
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
			case 'editClearImages':
				this.edit.clear();
				this.pushEditImages();
				break;
			case 'editOpenImage':
				await this.openEditImage(msg.name);
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
			case 'saveThumb':
				await saveThumb(msg.key, msg.data);
				break;
			case 'saveEditThumb':
				this.edit.setDisplay(msg.name, msg.srcLength, msg.data);
				break;
			case 'toggleFavorite':
				await this.favorites.toggle(msg.uri);
				break;
			case 'moveFavoriteTo':
				await this.favorites.move(msg.uri, msg.collectionId);
				break;
			case 'renameImage':
				await this.renameImage(msg.uri);
				break;
			case 'setActiveCollection':
				await this.favorites.setActive(msg.collectionId);
				break;
			case 'createCollection':
				await this.favorites.create();
				break;
			case 'renameCollection':
				await this.favorites.rename(msg.id);
				break;
			case 'deleteCollection':
				await this.favorites.delete(msg.id);
				break;
			case 'exportCollection':
				await this.favorites.export(msg.collectionId);
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

	/**
	 * 重命名收藏图片的磁盘文件名（仅改文件名，扩展名保留），并同步 favorites.json 中的引用。
	 * 入参 uri 即 favorites.json 中存的字符串，故改写收藏项时直接拿它匹配。
	 */
	private async renameImage(uri: string): Promise<void> {
		const src = vscode.Uri.parse(uri);
		const base = uriBaseName(src);
		const ext = path.extname(base);
		const stem = path.basename(base, ext);
		const input = await vscode.window.showInputBox({
			prompt: '重命名图片文件（不含扩展名）',
			value: stem,
			validateInput: collectionNameError,
		});
		const next = input?.trim();
		if (!next || next === stem) {
			return;
		}
		const dest = vscode.Uri.joinPath(src, '..', next + ext);
		try {
			await vscode.workspace.fs.rename(src, dest, { overwrite: false });
		} catch (err: unknown) {
			this.post({ type: 'error', message: `重命名为「${next + ext}」失败：${errMsg(err)}` });
			return;
		}
		await mutateFavorites((d) => renameFavoriteUri(d, uri, dest.toString()));
		await this.pushAfterFavoritesChange();
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

	/** 编辑区图片只驻内存（data URI），落临时文件后用内置图片查看器打开。
	 *  临时文件按名覆盖、不主动清理（单图 MB 级，交给 OS 临时目录回收） */
	private async openEditImage(name: string): Promise<void> {
		const img = this.edit.list().find((i) => i.name === name);
		if (!img) {
			return;
		}
		const base64 = img.data.slice(img.data.indexOf(',') + 1);
		const dir = vscode.Uri.file(path.join(os.tmpdir(), 'image-flow-view'));
		await vscode.workspace.fs.createDirectory(dir);
		// basename 兜底：name 理应已是纯文件名，防御性阻断含路径分隔符的名字逃出临时目录
		const file = vscode.Uri.joinPath(dir, path.basename(name));
		await vscode.workspace.fs.writeFile(file, Buffer.from(base64, 'base64'));
		await vscode.commands.executeCommand('vscode.open', file);
	}

	private pushEditImages(): void {
		this.post({
			type: 'editImages',
			// 展示用压缩图（webview 回传后缓存于 EditSession），原图只在提交时使用；
			// 尚无展示图的大图标记 needsThumb，webview 据此生成回传
			images: this.edit.list().map((i) => ({
				name: i.name,
				src: i.display ?? i.data,
				needsThumb: this.edit.needsDisplay(i),
			})),
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
		} catch (err: unknown) {
			this.postError(err);
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
			await openTextPreview(finalPrompt);
		} catch (err: unknown) {
			this.postError(err);
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
		const favSet = favoriteUriSet(await readFavorites());
		const libs = await listLibraries(this.context);
		this.post({
			type: 'libraries',
			libraries: await Promise.all(libs.map((l) => toWebviewLibrary(this.view?.webview, l, favSet))),
		});
	}

	/** 推送随当前 Markdown 路径自动生成的素材库（无 MD 时清空） */
	private async pushAutoLibraries(): Promise<void> {
		const favSet = favoriteUriSet(await readFavorites());
		const libs = this.currentMd ? await listAutoLibraries(this.currentMd) : [];
		this.post({
			type: 'autoLibraries',
			libraries: await Promise.all(libs.map((l) => toWebviewLibrary(this.view?.webview, l, favSet))),
		});
	}

	/** 推送收藏标签页数据：各夹图片转 webview 可加载 + 悬空过滤（仅展示） */
	private async pushFavorites(): Promise<void> {
		const data = await pruneMissing(await readFavorites());
		const favSet = favoriteUriSet(data);
		const collections: WebviewCollection[] = await Promise.all(
			data.collections.map(async (c) => ({
				id: c.id,
				name: c.name,
				images: await toWebviewImages(
					this.view?.webview,
					c.items.map((i) => ({ name: uriBaseName(vscode.Uri.parse(i.uri)), uri: i.uri })),
					favSet
				),
			}))
		);
		this.post({ type: 'favorites', collections, activeCollectionId: data.activeCollectionId });
	}

	/** 收藏发生变化后：收藏页 + 所有带星标的列表都要重推，星标态才会刷新 */
	private async pushAfterFavoritesChange(): Promise<void> {
		await this.pushFavorites();
		await this.pushHistory();
		await this.pushPendingTasks();
		await this.pushLibraries();
		await this.pushAutoLibraries();
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
		// 图片旁有同主名 .md 描述文件时，描述在前、图片引用紧随其后一并写进正文
		// （buildPrompt 拼提示词时自然包含），如：- [某角色] 描述文字。![alt](路径)
		const desc = await readImageDesc(imageUri);
		// alt 优先用描述里的别名（如 `[九胡]` → 九胡），与正文命名引用对齐；无别名退回文件主名。
		const alt = aliasFromDesc(desc) || path.basename(imgPath, path.extname(imgPath));
		// 路径含空格或半角括号时用尖括号包裹，否则 Markdown 会在空格处截断或被 ) 提前闭合。
		// 中文/全角括号对 CommonMark 是普通字符，无需处理，保持可读。
		const dest = /[ ()]/.test(rel) ? `<${rel}>` : rel;
		let snippet = `![${alt}](${dest})`;
		if (desc) {
			snippet = desc + snippet;
		}
		await editor.edit((b) => b.insert(editor.selection.active, snippet));
	}

	/** 预览请求：对当前关联的 MD 解析提示词 + 拼请求参数，打开成预览文档（不调 API） */
	private async doPreviewRequest(): Promise<void> {
		const md = this.requireActiveMd('预览请求');
		if (!md) {
			return;
		}
		try {
			const config = await readConfig(this.context);
			await openRequestPreview(config, md);
		} catch (err: unknown) {
			this.postError(err);
		}
	}

	/** 执行生成：校验 Key → 调 taskManager.submit 提交异步任务（立即返回，后台轮询） */
	private async doGenerate(mdUri: vscode.Uri): Promise<void> {
		const config = await readConfig(this.context);
		if (!config.apiKey) {
			this.post({ type: 'error', message: '尚未配置 API Key，请在设置页填写。' });
			return;
		}
		this.post({ type: 'busy', busy: true });
		try {
			await this.tasks.submit(mdUri);
		} catch (err: unknown) {
			this.postError(err);
		} finally {
			this.post({ type: 'busy', busy: false });
		}
	}

	private async pushHistory(): Promise<void> {
		const favSet = favoriteUriSet(await readFavorites());
		const tasks: Task[] = await listHistory(this.tasks.activeFolders());
		this.post({
			type: 'history',
			tasks: await Promise.all(tasks.map((t) => toWebviewTask(this.view?.webview, t, favSet))),
		});
	}

	/** 推送进行中任务（聚合进度 + 已存缩略图）给前端；全部进行中任务，不按 MD 过滤 */
	private async pushPendingTasks(): Promise<void> {
		const favSet = favoriteUriSet(await readFavorites());
		const tasks = this.tasks.list();
		this.post({
			type: 'pendingTasks',
			tasks: await Promise.all(tasks.map((t) => toWebviewPendingTask(this.view?.webview, t, favSet))),
		});
	}

	private post(msg: InboundMessage): void {
		// 报错统一走 VS Code 通知弹窗，不在 webview 内联展示；同时写入台账日志供排障
		if (msg.type === 'error') {
			log(`错误：${msg.message}`);
			vscode.window.showErrorMessage(`Image Flow：${msg.message}`);
			return;
		}
		void this.view?.webview.postMessage(msg);
	}

	/** 把异常收敛成错误消息，经 post 统一弹窗 + 记台账日志。catch 分支共用，避免到处复写消息提取 */
	private postError(err: unknown): void {
		this.post({ type: 'error', message: errMsg(err) });
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
