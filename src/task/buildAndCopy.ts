import * as vscode from 'vscode';
import { createTaskFolder } from './history';
import { writePromptFile, archiveInputs, writeTaskMeta, readTaskMeta, buildPromptFileContent } from './taskFiles';
import { PREVIEW_DOC_NAME } from './preview';
import { requestTaskName } from '../backend/providerRuntime';
import type { ImageFlowConfig } from '../shared';

/** 「构建并复制」一次导出所需的全部数据，工作台（来源 md）与编辑区（内存图）共用 */
export interface BuildAndCopyInput {
	/** 可复制的发送正文（含【@视频N】）：写进 preview.md + 复制到剪贴板 */
	prompt: string;
	/** 归档正文（`![名](input/原名)`）：写进归档式提示词文件，历史可渲染参考媒体 */
	archivePrompt: string;
	/** 归档式提示词文件名（工作台为 `<md名>.md`、编辑为 `edit.md`） */
	promptFileName: string;
	/** 参考媒体落盘名（已带顺序前缀 + 去重），与 images 一一对应 */
	names: string[];
	/** 参考媒体 base64 data URI，与 names 一一对应 */
	images: string[];
	/** 任务来源：生成 = 来源 md 相对路径；编辑 = （编辑任务） */
	source: string;
	/** 可读短名：工作台为 md 名、编辑为 edit */
	title: string;
}

/**
 * 「构建并复制」公共核心：本地/云端视频 API 用不起，故只把任务建好但不提交。
 * 建任务夹 → 写归档式提示词（可渲染参考媒体、历史「打开提示词」指向它）+ 可复制的 preview.md →
 * 按顺序归档参考媒体到 input/ → 写 meta（requested/succeeded 记 0，历史以 0/0 展示）→
 * 复制发送正文、打开 preview.md、资源管理器定位 input/。不调用 API、不轮询。
 * preview.md 命中「预览文档」约定（isPreviewDoc）：不顶替工作台当前 MD、不被误当可生成源，
 * listHistory/openTaskPrompt 也跳过它取归档式提示词作为历史的源提示词。
 * 任务夹若一直没放回成片，下次启动会被「无产物清理」清掉（满 1 天）。
 */
export async function writeBuildAndCopyTask(input: BuildAndCopyInput): Promise<vscode.Uri> {
	const [, dir] = await createTaskFolder();
	await writePromptFile(dir, input.promptFileName, buildPromptFileContent(input.archivePrompt));
	const copyUri = vscode.Uri.joinPath(dir, PREVIEW_DOC_NAME);
	await writePromptFile(dir, PREVIEW_DOC_NAME, buildPromptFileContent(input.prompt));
	await archiveInputs(dir, input.names.map((name, i) => ({ name, data: input.images[i] })));
	// 不调任何 API：模型走外部视频模型、分辨率/比例也在外部设定，此处无从知晓，故模型恒记「视频」、分辨率/比例留空
	await writeTaskMeta(dir, {
		source: input.source,
		title: input.title,
		model: '视频',
		aspectRatio: '',
		imageSize: '',
		requested: 0,
		succeeded: 0,
		durations: [],
	});

	await vscode.env.clipboard.writeText(input.prompt);
	await vscode.commands.executeCommand('vscode.open', copyUri);
	// 系统资源管理器定位到 input/（选中第一个文件、目录即展开），方便把排好序的文件拖进网页上传区。无引用则跳过
	if (input.names.length) {
		await vscode.commands.executeCommand(
			'revealFileInOS',
			vscode.Uri.joinPath(dir, 'input', input.names[0])
		);
	}
	return dir;
}

/**
 * 「构建并复制」任务的后台 AI 命名：与提交任务共用 requestTaskName，但任务已落盘定稿（不在进行中列表），
 * 故拿到短名后直接改写 meta.json 的 title 再刷新历史。命名是锦上添花——失败 / 无对话模型静默跳过、
 * 不阻塞构建本身（失败重试可能耗时数十秒），故调用方以 `void` 后台触发。
 */
export async function nameBuildAndCopyTask(
	dir: vscode.Uri,
	config: ImageFlowConfig,
	namingPrompt: string,
	refresh: () => Promise<void>
): Promise<void> {
	const title = await requestTaskName(config, namingPrompt);
	if (!title) {
		return;
	}
	const meta = await readTaskMeta(dir);
	if (!meta) {
		return;
	}
	await writeTaskMeta(dir, { ...meta, title });
	await refresh();
}
