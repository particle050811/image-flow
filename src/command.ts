import * as vscode from 'vscode';
import * as path from 'path';
import { generateImage } from './api';
import type { ImageFlowConfig, Task, TaskImage } from './shared';

/** 扩展名到 MIME 类型的映射，用于拼接参考图 base64 data URI */
const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

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
	const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
	const order: string[] = []; // 按首次出现顺序排列的去重相对路径
	const indexByPath = new Map<string, number>();

	// 第一遍：收集所有引用的相对路径并编号
	for (const match of content.matchAll(imageRegex)) {
		const relPath = match[1].trim();
		if (!indexByPath.has(relPath)) {
			indexByPath.set(relPath, order.length + 1);
			order.push(relPath);
		}
	}

	// 按顺序读取每张参考图，转 base64
	const images: string[] = [];
	const failed: string[] = [];
	for (const relPath of order) {
		const fileUri = vscode.Uri.joinPath(mdUri, '..', relPath);
		try {
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			const ext = path.extname(relPath).toLowerCase();
			const mime = MIME_BY_EXT[ext] ?? 'image/png';
			images.push(`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
		} catch {
			failed.push(relPath);
		}
	}
	if (failed.length) {
		throw new Error(`以下参考图读取失败：${failed.join('、')}`);
	}

	// 第二遍：把图片语法替换为有序引用 [imageN](文件名)
	const prompt = content.replace(imageRegex, (_full, rawPath: string) => {
		const relPath = rawPath.trim();
		const index = indexByPath.get(relPath)!;
		const baseName = path.basename(relPath, path.extname(relPath));
		return `[image${index}](${baseName})`;
	});

	return { prompt, images };
}

/** 生成过程的进度回调载荷 */
export type GenerateProgress =
	| { phase: 'start'; count: number }
	| { phase: 'error'; message: string };

/**
 * 对指定 Markdown 执行一次生成：解析提示词 → 按并发数并发请求 → 下载到同一 task 文件夹。
 * 进度通过 onProgress 上报（不弹窗），返回新生成的任务（含缩略图）。
 * 任一并发失败不影响其余，全部失败才抛错。
 */
export async function runGeneration(
	config: ImageFlowConfig,
	mdUri: vscode.Uri,
	onProgress: (p: GenerateProgress) => void
): Promise<Task> {
	const bytes = await vscode.workspace.fs.readFile(mdUri);
	const content = Buffer.from(bytes).toString('utf8').trim();
	if (!content) {
		throw new Error('Markdown 文件内容为空，无法生成。');
	}

	const { prompt, images } = await buildPrompt(mdUri, content);

	const count = Math.max(1, config.concurrency);
	onProgress({ phase: 'start', count });

	// 并发发起 N 次生成：用同一提示词同时请求，任一失败不影响其余
	const settled = await Promise.allSettled(
		Array.from({ length: count }, () => generateImage(config, prompt, images))
	);

	const urls: string[] = [];
	const errors: string[] = [];
	for (const r of settled) {
		if (r.status === 'fulfilled') {
			urls.push(...r.value);
		} else {
			const e = r.reason;
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}

	if (!urls.length) {
		throw new Error(`全部 ${count} 次生成均失败：${errors.join('；')}`);
	}
	for (const msg of errors) {
		onProgress({ phase: 'error', message: msg });
	}

	return downloadImages(mdUri, urls);
}

/** 把 Date 格式化为 yyMMddHHmmSS */
function formatStamp(d: Date): string {
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

/**
 * 下载图片到 Markdown 同级的 task-yyMMddHHmmSS 文件夹，文件名为 {MD文件名}-{序号}，
 * 返回新建任务（仅含文件引用，缩略图由 webview 侧用 asWebviewUri 加载）。
 */
async function downloadImages(mdUri: vscode.Uri, urls: string[]): Promise<Task> {
	const folder = `task-${formatStamp(new Date())}`;
	const dir = vscode.Uri.joinPath(mdUri, '..', folder);
	await vscode.workspace.fs.createDirectory(dir);

	// MD 文件名（去扩展名）作为图片名前缀
	const mdBase = path.basename(mdUri.path, path.extname(mdUri.path));

	const images: TaskImage[] = [];
	for (let i = 0; i < urls.length; i++) {
		const res = await fetch(urls[i]);
		if (!res.ok) {
			throw new Error(`下载图片失败（HTTP ${res.status}）`);
		}
		const data = new Uint8Array(await res.arrayBuffer());
		const ext = urls[i].split('?')[0].split('.').pop()?.toLowerCase() || 'png';
		const name = `${mdBase}-${i + 1}.${ext}`;
		const fileUri = vscode.Uri.joinPath(dir, name);
		await vscode.workspace.fs.writeFile(fileUri, data);
		images.push({ name, uri: fileUri.toString() });
	}

	return { folder, images };
}

/** 扩展名为图片的判断 */
function isImageFile(name: string): boolean {
	return path.extname(name).toLowerCase() in MIME_BY_EXT;
}

/**
 * 扫描 Markdown 同级目录下所有 task-* 文件夹，读取其中图片为缩略图，
 * 按文件夹名（含时间戳）倒序返回——较新的任务在前。
 */
export async function listHistory(mdUri: vscode.Uri): Promise<Task[]> {
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
 * 右键 Markdown 文件时触发：解析正文并把替换后的提示词文本打开成新文档，便于调试。
 * 不调用 API、不消耗额度。
 */
export async function previewPromptCommand(uri?: vscode.Uri): Promise<void> {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (!target) {
		vscode.window.showErrorMessage('Image Flow：请在 Markdown 文件上右键，或先打开一个文件。');
		return;
	}

	try {
		const bytes = await vscode.workspace.fs.readFile(target);
		const content = Buffer.from(bytes).toString('utf8').trim();
		if (!content) {
			vscode.window.showErrorMessage('Image Flow：Markdown 文件内容为空。');
			return;
		}

		const { prompt, images } = await buildPrompt(target, content);
		// 参考图 base64 可能很长，预览里只展示编号和长度，不刷屏
		const summary = images.length
			? images.map((img, i) => `image${i + 1}: ${img.slice(0, 48)}…（${img.length} 字符）`).join('\n')
			: '（无参考图）';
		const text =
			`===== 替换后的提示词 =====\n${prompt}\n\n` +
			`===== 参考图（${images.length} 张，按顺序对应 image1、image2…）=====\n${summary}\n`;

		const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
		await vscode.window.showTextDocument(doc, { preview: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Image Flow：${message}`);
	}
}


