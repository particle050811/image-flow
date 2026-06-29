import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { EditSession } from './editSession';
import { buildEditFinalPrompt, buildEditExportPrompt } from './edit';
import { readConfig, editConfigView } from '../ui/config';
import { openTextPreview } from '../task/preview';
import { writeBuildAndCopyTask } from '../task/buildAndCopy';
import { TaskManager } from '../task/tasks';
import { errMsg } from '../util/errors';
import { showTransientInfo } from '../util/notify';
import { openImageInEditor } from '../util/openImage';
import { mediaTypeOfFileName, MEDIA_EXTS } from '../util/images';
import type { InboundMessage } from '../shared';

/** 编辑控制器依赖：错误/状态/视图推送仍由 SidebarProvider 持有，经回调回去 */
export interface EditDeps {
	post(msg: InboundMessage): void;
	/** 刷新历史列表（「构建并复制」建出已完成任务卡后调用） */
	refreshHistory(): Promise<void>;
}

/**
 * 编辑页相关的消息处理：上传/拖入/移除/清空/打开图片、缩略图回填、生成与预览。
 * 自持 EditSession（编辑区图片列表，统一存 data URI，webview 重建不丢），
 * 数据与提交全在本类内，视图推送经 deps 回调，故不依赖 Provider 的其它状态。
 */
export class EditController {
	/** 编辑区图片列表：扩展侧持有，webview 重建不丢 */
	private readonly edit = new EditSession();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly tasks: TaskManager,
		private readonly deps: EditDeps
	) {}

	/** 弹出文件选择器，把选中图片加入编辑区 */
	async upload(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			openLabel: '加入编辑区',
			filters: { 图片: MEDIA_EXTS.image, 音频: MEDIA_EXTS.audio, 视频: MEDIA_EXTS.video },
		});
		if (!picked?.length) {
			return;
		}
		await this.addImages(picked.map((u) => u.toString()));
	}

	/** 批量按 uri 加入编辑区：逐张收集错误（重名/非图/读取失败），一次性提示 */
	async addImages(uris: string[]): Promise<void> {
		const errors: string[] = [];
		for (const uri of uris) {
			const err = await this.edit.addUri(uri);
			if (err) {
				errors.push(err);
			}
		}
		if (errors.length) {
			this.deps.post({ type: 'error', message: errors.join('；') });
		}
		this.push();
	}

	/** 批量收齐后一次性添加 + 单次推送：避免逐张消息 × 各全量推送的 O(N²) 序列化 */
	addImagesData(items: { name: string; data: string }[]): void {
		const errors = items
			.map((item) => this.edit.addData(item.name, item.data))
			.filter((e): e is string => !!e);
		if (errors.length) {
			this.deps.post({ type: 'error', message: errors.join('；') });
		}
		this.push();
	}

	removeImage(name: string): void {
		this.edit.remove(name);
		this.push();
	}

	clearImages(): void {
		this.edit.clear();
		this.push();
	}

	/** 编辑区图片只驻内存（data URI），落临时文件后用内置图片查看器打开。
	 *  临时文件按名覆盖、不主动清理（单图 MB 级，交给 OS 临时目录回收） */
	async openImage(name: string): Promise<void> {
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
		await openImageInEditor(file);
	}

	/** webview 回传压缩展示图，缓存进 EditSession */
	saveThumb(name: string, srcLength: number, data: string): void {
		this.edit.setDisplay(name, srcLength, data);
	}

	push(): void {
		this.deps.post({
			type: 'editImages',
			// 展示用压缩图（webview 回传后缓存于 EditSession），原图只在提交时使用；
			// 尚无展示图的大图标记 needsThumb，webview 据此生成回传
			images: this.edit.list().map((i) => ({
				name: i.name,
				src: i.display ?? i.data,
				media: mediaTypeOfFileName(i.name),
				needsThumb: this.edit.needsDisplay(i),
			})),
		});
	}

	/** 编辑页生成：校验 Key → submitEdit 提交异步任务 */
	async generate(prompt: string): Promise<void> {
		const config = await readConfig(this.context);
		if (!config.apiKey) {
			this.deps.post({ type: 'error', message: '尚未配置 API Key，请在设置页填写。' });
			return;
		}
		this.deps.post({ type: 'busy', busy: true });
		try {
			await this.tasks.submitEdit(prompt, this.edit.list());
		} catch (err: unknown) {
			this.deps.post({ type: 'error', message: errMsg(err) });
		} finally {
			this.deps.post({ type: 'busy', busy: false });
		}
	}

	/**
	 * 编辑页「构建并复制」：与工作台共用 writeBuildAndCopyTask，只是参考媒体来自编辑区（内存 data URI）、
	 * 参数走编辑专属配置（editConfigView）。本地/云端视频 API 用不起，故只建任务不提交、不调 API。
	 */
	async buildAndCopy(rawPrompt: string): Promise<void> {
		if (!rawPrompt.trim()) {
			this.deps.post({ type: 'error', message: '提示词为空，无法构建。' });
			return;
		}
		const config = editConfigView(await readConfig(this.context));
		this.deps.post({ type: 'busy', busy: true });
		try {
			const refs = this.edit.list();
			const { prompt, archivePrompt, fileNames } = buildEditExportPrompt(rawPrompt, refs.map((r) => r.name));
			await writeBuildAndCopyTask({
				prompt,
				archivePrompt,
				promptFileName: 'edit.md',
				names: fileNames,
				images: refs.map((r) => r.data),
				meta: {
					source: '（编辑任务）',
					title: 'edit',
					model: config.model,
					aspectRatio: config.aspectRatio,
					imageSize: config.imageSize,
					requested: 0,
					succeeded: 0,
					durations: [],
				},
			});
			await this.deps.refreshHistory();
			showTransientInfo('已构建任务并复制提示词，参考媒体已按顺序导出到 input/。');
		} catch (err: unknown) {
			this.deps.post({ type: 'error', message: errMsg(err) });
		} finally {
			this.deps.post({ type: 'busy', busy: false });
		}
	}

	/** 编辑页预览请求：与 submitEdit 共用 buildEditFinalPrompt，打开成预览文档（不调 API） */
	async preview(prompt: string): Promise<void> {
		try {
			const base = await readConfig(this.context);
			const refs = this.edit.list();
			const finalPrompt = buildEditFinalPrompt(base, prompt, refs.map((r) => r.name));
			await openTextPreview(finalPrompt);
		} catch (err: unknown) {
			this.deps.post({ type: 'error', message: errMsg(err) });
		}
	}
}
