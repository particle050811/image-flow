import * as vscode from 'vscode';
import * as path from 'path';
import type { ImageFlowConfig, Task, TaskImage } from './shared';
import { buildRequestBody, fetchWithTimeout } from './api';
import { readConfig } from './config';
import { isImageExt, mimeOf } from './images';
import { uriStem } from './paths';

/**
 * Markdown 图片语法的正则：匹配 `![alt](路径)`，路径可选 `<>` 包裹。
 * 两种形式分两个捕获组——尖括号形式 `<...>` 内部可含空格与半角括号（取非 `>`），
 * 普通形式取非 `)`。「右键插入引用」对含空格/半角括号的路径用尖括号包裹，
 * 解析端必须能完整读回，否则这类参考图会被判读取失败而中断生成。
 */
const IMAGE_REGEX = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)]+?))\s*\)/g;

/** 从一次匹配中取出路径（尖括号组优先，否则普通组） */
function refPath(m: RegExpMatchArray): string {
	return (m[1] ?? m[2] ?? '').trim();
}

/** 解析正文中所有图片引用，按首次出现顺序去重编号 */
export function parseImageRefs(content: string): { order: string[]; indexByPath: Map<string, number> } {
	const order: string[] = [];
	const indexByPath = new Map<string, number>();
	for (const match of content.matchAll(IMAGE_REGEX)) {
		const relPath = refPath(match);
		if (relPath && !indexByPath.has(relPath)) {
			indexByPath.set(relPath, order.length + 1);
			order.push(relPath);
		}
	}
	return { order, indexByPath };
}

/** 解析后的提示词：替换图片语法后的正文，以及按顺序读取的参考图 base64 列表 */
interface PromptResult {
	prompt: string;
	images: string[];
}

/**
 * 解析 Markdown 正文中的图片语法 `![alt](相对路径)`：
 * - 按首次出现顺序去重编号（同一图片复用同一序号）；
 * - 相对 Markdown 所在目录读取图片，转成 base64 data URI 作为参考图；
 * - 将每处图片语法替换为模型可理解的有序引用 `[imageN](文件名)`，其余正文保持不变。
 */
export async function buildPrompt(mdUri: vscode.Uri, content: string): Promise<PromptResult> {
	const { order, indexByPath } = parseImageRefs(content);

	// 按顺序读取每张参考图，转 base64
	const images: string[] = [];
	const failed: string[] = [];
	for (const relPath of order) {
		const fileUri = vscode.Uri.joinPath(mdUri, '..', relPath);
		try {
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			const mime = mimeOf(path.extname(relPath));
			images.push(`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
		} catch {
			failed.push(relPath);
		}
	}
	if (failed.length) {
		throw new Error(`以下参考图读取失败：${failed.join('、')}`);
	}

	// 第二遍：把图片语法替换为有序引用 [imageN](文件名)
	const prompt = content.replace(IMAGE_REGEX, (full, bracketed?: string, plain?: string) => {
		const relPath = (bracketed ?? plain ?? '').trim();
		const index = indexByPath.get(relPath);
		if (index === undefined) {
			return full;
		}
		const baseName = path.basename(relPath, path.extname(relPath));
		return `[image${index}](${baseName})`;
	});

	return { prompt, images };
}

/** 把 Date 格式化为 yyMMddHHmmSS */
export function formatStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		String(d.getFullYear()).slice(2) +
		p(d.getMonth() + 1) +
		p(d.getDate()) +
		p(d.getHours()) +
		p(d.getMinutes()) +
		p(d.getSeconds())
	);
}

/** Markdown 文件名（去扩展名），作为生成图片的名称前缀 */
export function mdBaseName(mdUri: vscode.Uri): string {
	return uriStem(mdUri);
}

/**
 * 在 Markdown 同级创建任务文件夹，返回 [文件夹名, 目录 Uri]。
 * 时间戳仅精确到秒，同一秒内的连续提交靠 seq 后缀区分，避免撞同一文件夹导致结果互相覆盖。
 */
export async function createTaskFolder(
	mdUri: vscode.Uri,
	seq: number
): Promise<[string, vscode.Uri]> {
	const folder = `task-${formatStamp(new Date())}-${seq}`;
	const dir = vscode.Uri.joinPath(mdUri, '..', folder);
	await vscode.workspace.fs.createDirectory(dir);
	return [folder, dir];
}

/**
 * 下载一批图片 URL 到任务文件夹，文件名为 {前缀}-{起始序号..}，返回新增的图片引用。
 * @param startIndex 已有图片数，用于接续编号，避免不同 job 的图片重名
 */
export async function downloadImages(
	mdUri: vscode.Uri,
	folder: string,
	urls: string[],
	startIndex: number
): Promise<TaskImage[]> {
	const dir = vscode.Uri.joinPath(mdUri, '..', folder);
	const prefix = mdBaseName(mdUri);
	const images: TaskImage[] = [];
	for (let i = 0; i < urls.length; i++) {
		const res = await fetchWithTimeout(urls[i]);
		if (!res.ok) {
			throw new Error(`下载图片失败（HTTP ${res.status}）`);
		}
		const data = new Uint8Array(await res.arrayBuffer());
		// 从 URL 取扩展名，校验落在图片白名单内，否则回退 png——避免畸形 URL 落地怪扩展名
		const rawExt = '.' + (urls[i].split('?')[0].split('.').pop()?.toLowerCase() || 'png');
		const ext = isImageExt(rawExt) ? rawExt.slice(1) : 'png';
		const name = `${prefix}-${startIndex + i + 1}.${ext}`;
		const fileUri = vscode.Uri.joinPath(dir, name);
		await vscode.workspace.fs.writeFile(fileUri, data);
		images.push({ name, uri: fileUri.toString() });
	}
	return images;
}

/** 扩展名为图片的判断 */
function isImageFile(name: string): boolean {
	return isImageExt(path.extname(name));
}

/**
 * 扫描 Markdown 同级目录下所有 task-* 文件夹，读取其中图片为缩略图，
 * 按文件夹名（含时间戳）倒序返回——较新的任务在前。
 * @param exclude 进行中任务的文件夹名集合，这些由顶部待办卡片实时展示，历史里跳过避免重复。
 */
export async function listHistory(mdUri: vscode.Uri, exclude?: Set<string>): Promise<Task[]> {
	const parent = vscode.Uri.joinPath(mdUri, '..');
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(parent);
	} catch {
		return [];
	}

	const folders = entries
		.filter(([name, type]) => type === vscode.FileType.Directory && name.startsWith('task-'))
		.map(([name]) => name)
		.filter((name) => !exclude?.has(name))
		.sort()
		.reverse();

	const tasks: Task[] = [];
	for (const folder of folders) {
		const dir = vscode.Uri.joinPath(parent, folder);
		let files: [string, vscode.FileType][];
		try {
			files = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			continue;
		}
		const images: TaskImage[] = [];
		for (const [name, type] of files.sort()) {
			if (type !== vscode.FileType.File || !isImageFile(name)) {
				continue;
			}
			const fileUri = vscode.Uri.joinPath(dir, name);
			images.push({ name, uri: fileUri.toString() });
		}
		if (images.length) {
			tasks.push({ folder, images });
		}
	}
	return tasks;
}

/**
 * 拼出「请求预览」文本：实际会发送给后端的请求参数 + 单独成段的替换后提示词 + 参考图概览。
 * prompt 含大量换行、images 含超长 base64，都从 JSON 参数块里剔除单独展示，避免转义符刷屏。
 * 请求体经 buildRequestBody 构造，与真实提交完全一致，避免预览与实际漂移。
 */
export function buildPreviewText(
	config: ImageFlowConfig,
	prompt: string,
	images: string[]
): string {
	const body = buildRequestBody(config, prompt, images);
	// prompt 单独成段、images 单独概览，参数块里只留其余字段
	const { prompt: _p, images: _i, ...rest } = body;
	const params = JSON.stringify(rest, null, 2);
	const summary = images.length
		? images.map((img, i) => `image${i + 1}: ${img.slice(0, 48)}…（${img.length} 字符）`).join('\n')
		: '（无参考图）';
	return (
		`===== 提示词（prompt）=====\n${prompt}\n\n` +
		`===== 请求地址 =====\nPOST ${config.baseUrl}/v1/api/generate\n\n` +
		`===== 请求参数 =====\n${params}\n\n` +
		`===== 参考图（${images.length} 张，按顺序对应 image1、image2…）=====\n${summary}\n`
	);
}

/**
 * 解析指定 Markdown 并把「替换后提示词 + 请求参数」打开成预览文档。供右键命令与侧栏按钮共用。
 * 不调用 API、不消耗额度。
 */
export async function openRequestPreview(
	config: ImageFlowConfig,
	mdUri: vscode.Uri
): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(mdUri);
	const content = Buffer.from(bytes).toString('utf8').trim();
	if (!content) {
		throw new Error('Markdown 文件内容为空。');
	}
	const { prompt, images } = await buildPrompt(mdUri, content);
	const text = buildPreviewText(config, prompt, images);
	const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
	await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * 右键 Markdown 文件时触发：解析正文并把替换后的提示词与请求参数打开成预览文档，便于调试。
 * 不调用 API、不消耗额度。
 */
export async function previewRequestCommand(
	context: vscode.ExtensionContext,
	uri?: vscode.Uri
): Promise<void> {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (!target) {
		vscode.window.showErrorMessage('Image Flow：请在 Markdown 文件上右键，或先打开一个文件。');
		return;
	}
	try {
		const config = await readConfig(context);
		await openRequestPreview(config, target);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Image Flow：${message}`);
	}
}
