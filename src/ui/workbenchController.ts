import * as vscode from 'vscode';
import { uriBaseName } from '../storage/paths';
import { readConfig } from './config';
import { GRSAI_PROVIDER_ID, JIMENG_PROVIDER_ID, isJimengVideoModel } from '../backend/providers';
import { TaskManager } from '../task/tasks';
import { openRequestPreview } from '../task/preview';
import { errMsg } from '../util/errors';
import type { InboundMessage } from '../shared';

/** 工作台控制器依赖：错误/状态/视图推送与「当前 MD」仍由 SidebarProvider 持有，经回调取用 */
export interface WorkbenchDeps {
	post(msg: InboundMessage): void;
	/** 当前侧栏关联的 MD（由宿主跟随活动编辑器维护，工作台无独立状态） */
	currentMd(): vscode.Uri | undefined;
}

/**
 * 工作台页的消息处理：生成 / 预览请求，与编辑页的 EditController 对称。
 * 编排（busy 包裹、apiKey 校验、错误收敛）原内联在 SidebarProvider，析出本类后
 * Provider 回归「webview 宿主 + 消息路由」单一职责。工作台无 EditSession 那样的常驻状态，
 * 「当前 MD」与视图推送经 deps 回调取用。
 */
export class WorkbenchController {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly tasks: TaskManager,
		private readonly deps: WorkbenchDeps
	) {}

	/** 主编辑区当前激活标签打开的文件是否正是生效 MD。切到 preview.md、图片等其它标签后返回 false */
	private activeTabIsCurrentMd(md: vscode.Uri): boolean {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const uri =
			input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
				? input.uri
				: undefined;
		return uri?.toString() === md.toString();
	}

	/** 预览/生成前的统一校验：有生效 MD 且正是主标签页打开的文件才返回它，否则弹错返回 undefined */
	private requireActiveMd(action: string): vscode.Uri | undefined {
		const md = this.deps.currentMd();
		if (!md) {
			this.deps.post({ type: 'error', message: '请先在编辑器中打开一个 Markdown 文件。' });
			return undefined;
		}
		if (!this.activeTabIsCurrentMd(md)) {
			this.deps.post({
				type: 'error',
				message: `主标签页当前打开的不是加载文件「${uriBaseName(md)}」，无法${action}。请切回该文件再操作。`,
			});
			return undefined;
		}
		return md;
	}

	/** 工作台「生成」按钮：校验生效 MD 后提交 */
	async generate(): Promise<void> {
		const md = this.requireActiveMd('生成');
		if (md) {
			await this.doGenerate(md);
		}
	}

	/** 右键命令路径：对给定 MD 直接生成（右键文件即目标，跳过主标签页校验） */
	async generateFor(mdUri: vscode.Uri): Promise<void> {
		await this.doGenerate(mdUri);
	}

	/** 执行生成：校验 Key → 调 taskManager.submit 提交异步任务（立即返回，后台轮询） */
	private async doGenerate(mdUri: vscode.Uri): Promise<void> {
		const config = await readConfig(this.context);
		// 密钥检查按当前渠道分流（F095）：只有 grsai 用 secrets 里的 apiKey；
		// 自定义模型自带密钥，缺失时由 resolveImageCall 报错，不能在这里用 grsai 密钥一票拦截
		if (config.providerId === GRSAI_PROVIDER_ID && !config.apiKey) {
			this.deps.post({ type: 'error', message: '尚未配置 API Key，请在设置页填写。' });
			return;
		}
		// 视频生成昂贵，默认只放行文件名以 v.md 结尾的 Markdown，防止对生图提示词误点视频模型
		if (
			config.videoOnlyVmd &&
			config.providerId === JIMENG_PROVIDER_ID &&
			isJimengVideoModel(config.model) &&
			!uriBaseName(mdUri).toLowerCase().endsWith('v.md')
		) {
			this.deps.post({
				type: 'error',
				message: '视频模型仅允许文件名以 v.md 结尾的 Markdown 生成（防误触发付费视频任务）。可在设置页关闭此限制。',
			});
			return;
		}
		this.deps.post({ type: 'busy', busy: true });
		try {
			await this.tasks.submit(mdUri);
		} catch (err: unknown) {
			this.deps.post({ type: 'error', message: errMsg(err) });
		} finally {
			this.deps.post({ type: 'busy', busy: false });
		}
	}

	/** 预览请求：对当前关联的 MD 解析提示词，打开成预览文档（不调 API） */
	async previewRequest(): Promise<void> {
		const md = this.requireActiveMd('预览请求');
		if (!md) {
			return;
		}
		try {
			const config = await readConfig(this.context);
			await openRequestPreview(config, md);
		} catch (err: unknown) {
			this.deps.post({ type: 'error', message: errMsg(err) });
		}
	}
}
