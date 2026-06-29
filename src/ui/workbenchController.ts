import * as vscode from 'vscode';
import { uriBaseName } from '../storage/paths';
import { readConfig } from './config';
import { TaskManager } from '../task/tasks';
import { buildExportPrompt } from '../prompt/buildPrompt';
import { openRequestPreview } from '../task/preview';
import { writeBuildAndCopyTask, nameBuildAndCopyTask } from '../task/buildAndCopy';
import { mdBaseName } from '../task/history';
import { errMsg } from '../util/errors';
import { showTransientInfo } from '../util/notify';
import type { InboundMessage } from '../shared';

/** 工作台控制器依赖：错误/状态/视图推送与「当前 MD」仍由 SidebarProvider 持有，经回调取用 */
export interface WorkbenchDeps {
	post(msg: InboundMessage): void;
	/** 刷新历史列表（构建并复制建出已完成任务卡后调用） */
	refreshHistory(): Promise<void>;
	/** 当前侧栏关联的 MD（由宿主跟随活动编辑器维护，工作台无独立状态） */
	currentMd(): vscode.Uri | undefined;
}

/**
 * 工作台页的消息处理：生成 / 构建并复制 / 预览请求，与编辑页的 EditController 对称。
 * 三件套的编排（busy 包裹、apiKey 校验、错误收敛）原内联在 SidebarProvider，析出本类后
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
		if (!config.apiKey) {
			this.deps.post({ type: 'error', message: '尚未配置 API Key，请在设置页填写。' });
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

	/**
	 * 「构建并复制」：本地/云端视频 API 用不起，故只在本地把任务建好但不提交——
	 * 建任务夹 → 写归档式 `<md名>.md`（可渲染参考图、历史「打开提示词」指向它）+ 可复制的 preview.md →
	 * 按顺序归档参考媒体到 input/ → 复制发送正文并打开 preview.md + 资源管理器定位 input/。不调 API、不轮询。
	 */
	async buildAndCopy(): Promise<void> {
		const md = this.requireActiveMd('构建并复制');
		if (!md) {
			return;
		}
		this.deps.post({ type: 'busy', busy: true });
		try {
			const bytes = await vscode.workspace.fs.readFile(md);
			const content = Buffer.from(bytes).toString('utf8').trim();
			if (!content) {
				throw new Error('Markdown 文件内容为空，无法构建。');
			}
			const { prompt, images, names, archivePrompt } = await buildExportPrompt(md, content);
			const prefix = mdBaseName(md);
			const dir = await writeBuildAndCopyTask({
				prompt,
				archivePrompt,
				promptFileName: `${prefix}.md`,
				names,
				images,
				source: vscode.workspace.asRelativePath(md),
				title: prefix,
			});
			await this.deps.refreshHistory();
			showTransientInfo('已构建任务并复制提示词，参考媒体已按顺序导出到 input/。');
			// 不提交也 AI 命名：后台非阻塞，失败静默回退 md 名占位
			const config = await readConfig(this.context);
			if (config.autoName) {
				void nameBuildAndCopyTask(dir, config, prompt, () => this.deps.refreshHistory());
			}
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
