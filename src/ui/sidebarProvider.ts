import * as vscode from 'vscode';
import { uriBaseName } from '../storage/paths';
import { readConfig, writeConfig } from './config';
import { configOptions, currentProvider, ensureSettingsFile, reloadCustomProvider } from '../backend/providerRuntime';
import { providerSwitchPatch, CUSTOM_PROVIDER_ID } from '../backend/providers';
import { listHistory } from '../task/history';
import { openRequestPreview, isPreviewDoc } from '../task/preview';
import { TaskManager } from '../task/tasks';
import { EditController } from '../prompt/editController';
import { listPromptTemplates } from '../prompt/prompts';
import { tasksRoot } from '../storage/storage';
import { saveThumb } from '../storage/thumbs';
import { log } from '../util/log';
import { errMsg } from '../util/errors';
import {
	readFavorites,
	pruneMissing,
	favoriteUriSet,
} from '../favorites/favorites';
import { FavoritesController } from '../favorites/favoritesController';
import type {
	Task,
	WebviewCollection,
	InboundMessage,
	OutboundMessage,
	ImageFlowConfig,
} from '../shared';
import {
	toWebviewImages,
	toWebviewTask,
	toWebviewPendingTask,
} from './toWebview';
import { sidebarHtml } from './sidebarHtml';
import { MaterialsController } from './materialsController';

/** 侧栏 Webview：承载配置表单、生成入口与结果/历史缩略图 */
export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'image-flow.sidebar';

	private view?: vscode.WebviewView;
	/** 当前侧栏关联的 Markdown（跟随当前活动编辑器；切到非 .md 标签时保留上一个，不清空） */
	private currentMd?: vscode.Uri;
	/** 编辑页相关消息处理（上传/生成/预览/缩略图），自持 EditSession，视图推送经回调回到本类 */
	private readonly editCtrl: EditController;
	/** 素材库相关消息处理（库增删/资源根/自动库/插入引用），view 与 currentMd 经 getter 回调取 */
	private readonly materials: MaterialsController;
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
		this.editCtrl = new EditController(context, tasks, { post: (msg) => this.post(msg) });
		this.materials = new MaterialsController(context, {
			post: (msg) => this.post(msg),
			view: () => this.view,
			currentMd: () => this.currentMd,
		});
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
		// 点任务完成通知的「查看」：聚焦侧栏 + 切到任务栏并定位该任务
		this.tasks.setRevealHandler((folder) => void this.revealTask(folder));
	}

	/** 聚焦侧栏并让前端切到「任务」标签、选中指定任务（完成通知点「查看」时触发） */
	private async revealTask(folder: string): Promise<void> {
		await vscode.commands.executeCommand('image-flow.sidebar.focus');
		this.post({ type: 'revealTask', folder });
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
			localResourceRoots: this.materials.buildResourceRoots(),
		};
		view.webview.html = sidebarHtml(view.webview, this.context.extensionUri);

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
			void this.materials.pushAutoLibraries();
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
				// 自愈：providerId=custom 但缺 settings.json → 重建脚手架并重读，避免「选中自定义却无模型」的卡死
				const initConfig = await readConfig(this.context);
				if (initConfig.providerId === CUSTOM_PROVIDER_ID) {
					await ensureSettingsFile(this.context.extensionUri);
					await reloadCustomProvider();
				}
				await this.pushConfig();
				this.post({ type: 'activeMd', name: this.currentMd ? this.baseName(this.currentMd) : null });
				await this.pushPendingTasks();
				await this.pushHistory();
				await this.materials.pushLibraries();
				await this.materials.pushAutoLibraries();
				this.editCtrl.push();
				await this.pushTemplates();
				await this.pushFavorites();
				break;
			}
			case 'saveConfig':
				await writeConfig(this.context, msg.patch);
				break;
			case 'selectProvider':
				await this.selectProvider(msg.providerId);
				break;
			case 'openProviderSettings':
				await this.openProviderSettings();
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
				await this.materials.insertImageRef(msg.uri);
				break;
			case 'openExternal':
				await vscode.env.openExternal(vscode.Uri.parse(msg.url));
				break;
			case 'refreshHistory':
				await this.pushHistory();
				break;
			case 'addLibrary':
				await this.materials.addLibrary();
				break;
			case 'removeLibrary':
				await this.materials.removeLibrary(msg.folder);
				break;
			case 'editUpload':
				await this.editCtrl.upload();
				break;
			case 'editAddImages':
				await this.editCtrl.addImages(msg.uris);
				break;
			case 'editAddImagesData':
				this.editCtrl.addImagesData(msg.items);
				break;
			case 'editRemoveImage':
				this.editCtrl.removeImage(msg.name);
				break;
			case 'editClearImages':
				this.editCtrl.clearImages();
				break;
			case 'editOpenImage':
				await this.editCtrl.openImage(msg.name);
				break;
			case 'editGenerate':
				await this.editCtrl.generate(msg.prompt);
				break;
			case 'editPreviewRequest':
				await this.editCtrl.preview(msg.prompt);
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
				this.editCtrl.saveThumb(msg.name, msg.srcLength, msg.data);
				break;
			case 'toggleFavorite':
				await this.favorites.toggle(msg.uri);
				break;
			case 'moveFavoriteTo':
				await this.favorites.move(msg.uri, msg.collectionId);
				break;
			case 'renameImage':
				await this.favorites.renameImage(msg.uri);
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

	private async pushTemplates(): Promise<void> {
		this.post({ type: 'promptTemplates', templates: await listPromptTemplates() });
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
		await this.materials.pushLibraries();
		await this.materials.pushAutoLibraries();
	}

	/** 推送当前配置 + 由当前 Provider 派生的 options（下拉候选随 grsai/自定义切换） */
	private async pushConfig(): Promise<void> {
		const config = await readConfig(this.context);
		this.post({ type: 'config', config, options: configOptions(config) });
		this.warnIfCustomEmpty(config);
	}

	/**
	 * 自定义 Provider 选中但没有可用图片模型（settings.json 的 image[] 为空或全部无效）时给明确提示。
	 * 补「缺文件自愈」覆盖不到的一格：文件存在但内容没配模型——否则前端模型下拉空白、点生成才报错。
	 */
	private warnIfCustomEmpty(config: ImageFlowConfig): void {
		if (config.providerId === CUSTOM_PROVIDER_ID && !currentProvider(config).image.length) {
			this.post({
				type: 'error',
				message: '自定义 API 没有可用的图片模型，请在 settings.json 的 image[] 中配置（点「打开配置文件」），改后重载窗口生效。',
			});
		}
	}

	/**
	 * 切换 API（Provider）：存 providerId；选自定义则确保 settings.json 存在并重读；
	 * 再把工作台/编辑模型对齐到新 Provider 的有效值并播种参数默认值，最后回推配置与候选。
	 */
	private async selectProvider(providerId: string): Promise<void> {
		await writeConfig(this.context, { providerId });
		if (providerId === CUSTOM_PROVIDER_ID) {
			await ensureSettingsFile(this.context.extensionUri);
			await reloadCustomProvider();
		}
		const config = await readConfig(this.context);
		const patch = providerSwitchPatch(currentProvider(config), config);
		if (Object.keys(patch).length) {
			await writeConfig(this.context, patch);
		}
		await this.pushConfig();
	}

	/** 打开自定义配置文件：缺则先建脚手架，重读后用编辑器打开；刷新候选（刚创建时模型列表更新） */
	private async openProviderSettings(): Promise<void> {
		const uri = await ensureSettingsFile(this.context.extensionUri);
		await reloadCustomProvider();
		await vscode.commands.executeCommand('vscode.open', uri);
		await this.pushConfig();
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
}
