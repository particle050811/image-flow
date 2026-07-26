import * as vscode from 'vscode';
import { uriBaseName } from '../storage/paths';
import { mediaTypeOfFileName } from '../util/images';
import { readConfig, writeConfig } from './config';
import { configOptions, ensureSettingsFile, reloadCustomProvider } from '../backend/providerRuntime';
import { CUSTOM_PROVIDER_ID } from '../backend/providers';
import { jimengLogin } from '../backend/jimengGuide';
import { listHistory } from '../task/history';
import { isPreviewDoc, PREVIEW_DOC_NAME } from '../task/preview';
import { TaskManager } from '../task/tasks';
import { EditController } from '../prompt/editController';
import { WorkbenchController } from './workbenchController';
import { listPromptTemplates } from '../prompt/prompts';
import { tasksRoot } from '../storage/storage';
import { saveThumb } from '../storage/thumbs';
import { log } from '../util/log';
import { errMsg } from '../util/errors';
import { openImageInEditor } from '../util/openImage';
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
	/** 工作台页相关消息处理（生成/预览请求），「当前 MD」与视图推送经回调回到本类 */
	private readonly workbench: WorkbenchController;
	/** 编辑页相关消息处理（上传/生成/预览/缩略图），自持 EditSession，视图推送经回调回到本类 */
	private readonly editCtrl: EditController;
	/** 素材库相关消息处理（库增删/资源根/自动库/插入引用），view 与 currentMd 经 getter 回调取 */
	private readonly materials: MaterialsController;
	/** 历史推送的单调序号：每次 pushHistory 扫描开始时自增，前端据此丢弃晚到的旧快照 */
	private historySeq = 0;
	/** 进行中快照（unreadFolders / pendingTasks 共用）的单调序号：两类消息是同一列表的快照，共用序号让前端按捕获时刻排序应用 */
	private pendingSnapSeq = 0;
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
		this.workbench = new WorkbenchController(context, tasks, {
			post: (msg) => this.post(msg),
			currentMd: () => this.currentMd,
		});
		this.editCtrl = new EditController(context, tasks, {
			post: (msg) => this.post(msg),
		});
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
				// 未读登记先行（内存直出、同步 post）：秒败任务可能在下面慢的历史扫盘期间就移出
				// 进行中列表，等 pushPendingTasks 再读快照已看不到它，前端将永远登记不上未读
				this.post({
					type: 'unreadFolders',
					seq: ++this.pendingSnapSeq,
					folders: this.tasks.list().map((t) => t.folder),
				});
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
		await this.workbench.generateFor(mdUri);
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

	private baseName(uri: vscode.Uri): string {
		return uriBaseName(uri);
	}

	private async onMessage(msg: OutboundMessage): Promise<void> {
		switch (msg.type) {
			case 'init': {
				// 自愈：选中自定义渠道模型但缺 settings.json → 重建脚手架并重读，避免「选中自定义却无模型」的卡死
				const initConfig = await readConfig(this.context);
				if (initConfig.providerId === CUSTOM_PROVIDER_ID || initConfig.editProviderId === CUSTOM_PROVIDER_ID) {
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
			case 'openProviderSettings':
				await this.openProviderSettings();
				break;
			case 'jimengLogin':
				await jimengLogin();
				break;
			case 'generate':
				await this.workbench.generate();
				break;
			case 'previewRequest':
				await this.workbench.previewRequest();
				break;
			case 'openImage':
				await openImageInEditor(vscode.Uri.parse(msg.uri));
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
			case 'refreshAutoLibraries':
				await this.materials.pushAutoLibraries();
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
			// 跳过 preview.md（构建并复制的可复制副本，非源提示词），取归档式 <md名>.md
			const md = entries.find(
				([name, type]) =>
					type === vscode.FileType.File &&
					name.toLowerCase().endsWith('.md') &&
					name.toLowerCase() !== PREVIEW_DOC_NAME
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
			data.collections.map(async (c) => {
				const images = await toWebviewImages(
					this.view?.webview,
					c.items.map((i) => {
						const name = uriBaseName(vscode.Uri.parse(i.uri));
						return { name, uri: i.uri, media: mediaTypeOfFileName(name) };
					}),
					favSet
				);
				// 备注按序回填（toWebviewImages 保序）：悬浮提示展示「为何收藏这张」
				return {
					id: c.id,
					name: c.name,
					images: images.map((img, idx) => ({ ...img, note: c.items[idx].note })),
				};
			})
		);
		this.post({ type: 'favorites', collections, activeCollectionId: data.activeCollectionId });
	}

	/** 收藏发生变化后：收藏页 + 所有带星标的列表都要重推，星标态才会刷新。
	 *  公开给 CLI 桥的 favorite op（extension.ts 接线）：CLI 收藏后侧栏即时可见 */
	public async pushAfterFavoritesChange(): Promise<void> {
		await this.pushFavorites();
		await this.pushHistory();
		await this.pushPendingTasks();
		await this.materials.pushLibraries();
		await this.materials.pushAutoLibraries();
	}

	/** 推送当前配置 + 合并全渠道派生的 options（模型下拉分组候选） */
	private async pushConfig(): Promise<void> {
		const config = await readConfig(this.context);
		const options = configOptions();
		this.post({ type: 'config', config, options });
		this.warnIfCustomMissing(config, options);
	}

	/**
	 * 选中的是自定义渠道模型、但自定义渠道没有可用图片模型（settings.json 缺失/解析失败/image[] 为空）时给明确提示。
	 * 补「缺文件自愈」覆盖不到的一格：文件存在但内容没配模型——否则前端模型下拉回落首个、点生成才报错。
	 */
	private warnIfCustomMissing(config: ImageFlowConfig, options: ReturnType<typeof configOptions>): void {
		const usesCustom = config.providerId === CUSTOM_PROVIDER_ID || config.editProviderId === CUSTOM_PROVIDER_ID;
		if (usesCustom && !options.imageModels.some((m) => m.provider === CUSTOM_PROVIDER_ID)) {
			this.post({
				type: 'error',
				message: '自定义 API 没有可用的图片模型，请在 settings.json 的 image[] 中配置（点「打开配置文件」），改后重载窗口生效。',
			});
		}
	}

	/** 打开自定义配置文件：缺则先建脚手架，重读后用编辑器打开；刷新候选（刚创建时模型列表更新） */
	private async openProviderSettings(): Promise<void> {
		const uri = await ensureSettingsFile(this.context.extensionUri);
		await reloadCustomProvider();
		await vscode.commands.executeCommand('vscode.open', uri);
		await this.pushConfig();
	}

	private async pushHistory(): Promise<void> {
		// 扫描开始即取号：并发的多次刷新（onChange 不串行 + init/refreshHistory/收藏变更各自触发）
		// 完成顺序不定，旧扫描可能晚到；前端按 seq 丢弃更旧的快照，防止覆盖新状态/误剪未读
		const seq = ++this.historySeq;
		const favSet = favoriteUriSet(await readFavorites());
		const tasks: Task[] = await listHistory(this.tasks.activeFolders());
		const payload = await Promise.all(tasks.map((t) => toWebviewTask(this.view?.webview, t, favSet)));
		// 发送前复核取号仍是最新：期间有更新的扫描启动即说明本快照已过期，直接不发——
		// 只靠前端丢弃防不住「旧快照先于新快照送达」（此时前端还没有更大序号可比）
		if (seq !== this.historySeq) {
			return;
		}
		this.post({ type: 'history', seq, tasks: payload });
	}

	/** 推送进行中任务（聚合进度 + 已存缩略图）给前端；全部进行中任务，不按 MD 过滤 */
	private async pushPendingTasks(): Promise<void> {
		// 取号与快照捕获同步相邻：seq 代表 list() 的捕获时刻，前端据此与 unreadFolders 统一排序应用
		const seq = ++this.pendingSnapSeq;
		const tasks = this.tasks.list();
		const favSet = favoriteUriSet(await readFavorites());
		const payload = await Promise.all(tasks.map((t) => toWebviewPendingTask(this.view?.webview, t, favSet)));
		// 缩略图转换耗时，期间可能已有更新的快照（unreadFolders 或下一轮 pendingTasks）取号：
		// 本快照已过期则不发，防止旧 pending 卡片复活、已完成任务被重新登记未读
		if (seq !== this.pendingSnapSeq) {
			return;
		}
		this.post({ type: 'pendingTasks', seq, tasks: payload });
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
