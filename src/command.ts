import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import type { ImageFlowConfig, Task, TaskImage } from './shared';
import { buildRequestBody, fetchWithTimeout } from './api';
import { readConfig } from './config';
import { isImageExt, isImageFileName, mimeOf, mediaTypeOf, type MediaType } from './images';
import { uriStem } from './paths';
import { buildInjectedPrompt } from './inject';
import { dedupeName } from './favorites';
import { mediaDeclSnippet } from './refs';
import { tasksRoot } from './storage';
import { readTaskMeta } from './taskFiles';
import { errMsg } from './errors';

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

/** 一条媒体声明：alt（命名引用用的名字）、原始路径、媒体大类 */
export interface MediaDecl {
	alt: string;
	path: string;
	type: MediaType;
}

/** 名字表条目：命名引用 [名] 替换成 【@${标签}${index}】 时取用 */
export interface NameEntry {
	type: MediaType;
	index: number;
}

/**
 * 解析正文里所有 `![alt](路径)` 媒体声明，按出现顺序返回。
 * alt 单独从整段匹配上提取（共享 IMAGE_REGEX 只捕获路径，不动其捕获组）。
 */
export function parseMediaDecls(content: string): MediaDecl[] {
	const decls: MediaDecl[] = [];
	for (const m of content.matchAll(IMAGE_REGEX)) {
		const relPath = refPath(m);
		if (!relPath) {
			continue;
		}
		const alt = (m[0].match(/^!\[([^\]]*)\]/)?.[1] ?? '').trim();
		decls.push({ alt, path: relPath, type: mediaTypeOf(path.extname(relPath)) });
	}
	return decls;
}

/**
 * 由声明列表构建名字表：每类从 1 起独立编号（按出现顺序）。
 * 任意两条声明 alt 相同即抛错——避免命名引用 [名] 歧义。
 */
export function buildNameTable(decls: MediaDecl[]): Map<string, NameEntry> {
	const counters: Record<MediaType, number> = { image: 0, audio: 0, video: 0 };
	const table = new Map<string, NameEntry>();
	for (const d of decls) {
		if (table.has(d.alt)) {
			throw new Error(`提示词存在重名引用：${d.alt}`);
		}
		counters[d.type] += 1;
		table.set(d.alt, { type: d.type, index: counters[d.type] });
	}
	return table;
}

/** 媒体大类 → 命名引用标签 */
const MEDIA_LABEL: Record<MediaType, string> = { image: '图片', audio: '音频', video: '视频' };

/** 命名引用正则：声明删除后剩下的 `[名]`，`(?!\()` 跳过 markdown 链接 `[文字](url)` */
const NAMED_REF_REGEX = /\[([^\[\]]+)\](?!\()/g;

/**
 * 校验每条媒体声明都在正文里被 `[名]` 引用至少一次，否则抛错列出未引用名。
 * 防止声明名与引用名不一致（如声明 `![李樱三视图]` 但正文写 `[李樱]`）导致图片被上传却无
 * `【@图片N】` 指向、`[名]` 当字面文本残留这类静默错误。生成与编辑提交前各调一次。
 */
export function assertAllDeclsReferenced(content: string, decls: MediaDecl[]): void {
	const stripped = content.replace(IMAGE_REGEX, '');
	const referenced = new Set<string>();
	for (const m of stripped.matchAll(NAMED_REF_REGEX)) {
		referenced.add(m[1].trim());
	}
	const unused = [...new Set(decls.filter((d) => !referenced.has(d.alt)).map((d) => d.alt))];
	if (unused.length) {
		throw new Error(`以下声明的图片未被引用（检查 [名] 是否与声明名一致）：${unused.join('、')}`);
	}
}

/**
 * 生成发给模型的 prompt：先整体删除 `![...](...)` 声明（只删语法本身，前后空白保留），
 * 再把命中名字表的 `[名]` 替换为 `【@图片N】`/`【@音频N】`/`【@视频N】`，未命中原样保留。
 * 纯函数（不读盘），生成与编辑链路共用。
 */
export function replaceMediaRefs(content: string, table: Map<string, NameEntry>): string {
	const stripped = content.replace(IMAGE_REGEX, '');
	return stripped.replace(NAMED_REF_REGEX, (full, name: string) => {
		const hit = table.get(name.trim());
		return hit ? `【@${MEDIA_LABEL[hit.type]}${hit.index}】` : full;
	});
}

/** 解析后的提示词：替换图片语法后的正文、按序参考图 base64、参考图原文件名（与 images 等长，归档用） */
interface PromptResult {
	prompt: string;
	images: string[];
	/** 归档落盘文件名（保留原名，重名已去重），与 archivePrompt 的引用一一对应 */
	names: string[];
	/** 归档用正文：图片引用改写为指向任务 input/ 的 markdown，可直接右键重新生成 */
	archivePrompt: string;
}

/** 归档参考图文件名去重：保留原名，同名后续追加序号（a.png、a-1.png…），与 archiveInputs 落盘一致 */
export function dedupeArchiveNames(names: string[]): string[] {
	const used = new Set<string>();
	return names.map((name) => {
		const final = dedupeName(used, name);
		used.add(final);
		return final;
	});
}

/**
 * 把正文里的每处图片语法替换为指向任务文件夹 input/ 归档参考图的 markdown 声明 `![alt](input/原名)`，
 * 用于把提示词正文归档成可「直接右键生成」的 MD。序号取 indexBy（共用 parseImageRefs 编号表），
 * fileNames 是 archiveInputs 落盘的最终文件名（已去重），按序号顺序排列（fileNames[N-1] 即第 N 张）。
 * 保留原始 alt——命名引用 `[alt]` 依赖声明 alt 才能在重生成时替换为 `【@图片N】`。
 * 含空格/括号的名字由 mediaDeclSnippet 用尖括号包裹。未在编号表中的引用原样保留。
 */
export function archiveImageRefs(content: string, indexBy: Map<string, number>, fileNames: string[]): string {
	return content.replace(IMAGE_REGEX, (full: string, bracketed?: string, plain?: string) => {
		const key = (bracketed ?? plain ?? '').trim();
		const index = indexBy.get(key);
		if (index === undefined) {
			return full;
		}
		const alt = (full.match(/^!\[([^\]]*)\]/)?.[1] ?? '').trim();
		return mediaDeclSnippet(alt, `input/${fileNames[index - 1]}`);
	});
}

/**
 * 解析 Markdown 正文中的图片语法 `![alt](相对路径)`：
 * - 按首次出现顺序去重编号（同一图片复用同一序号）；
 * - 相对 Markdown 所在目录读取图片，转成 base64 data URI 作为参考图；
 * - 将每处图片语法替换为模型可理解的有序引用 `[imageN](文件名)`，其余正文保持不变。
 */
export async function buildPrompt(mdUri: vscode.Uri, content: string): Promise<PromptResult> {
	const { order, indexByPath } = parseImageRefs(content);

	// 声明解析与校验放在读盘之前，命名不一致/同名时尽早失败，不浪费读图
	const decls = parseMediaDecls(content);
	const table = buildNameTable(decls);
	assertAllDeclsReferenced(content, decls);

	// 按顺序读取每张参考图，转 base64
	const images: string[] = [];
	const names: string[] = [];
	const failed: string[] = [];
	for (const relPath of order) {
		const fileUri = vscode.Uri.joinPath(mdUri, '..', relPath);
		try {
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			const mime = mimeOf(path.extname(relPath));
			images.push(`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
			names.push(path.basename(relPath));
		} catch {
			failed.push(relPath);
		}
	}
	if (failed.length) {
		throw new Error(`以下参考图读取失败：${failed.join('、')}`);
	}

	// 发给模型的 prompt：删声明 + 命名引用替换为【@图片N】。
	// 已知限制：【@图片N】按媒体类型独立编号，而 images[] 由 parseImageRefs 按全局出现顺序（路径去重）
	// 上传。纯图片、无重复路径时两套编号一致；混合媒体或同路径多 alt 时编号与上传下标会错位，
	// 待接入音视频后端时再统一上传顺序（详见 logic.test.ts 的两条锁定测试）。
	const prompt = replaceMediaRefs(content, table);
	// 归档文件名：保留原名、重名去重，归档正文与 input/ 落盘共用，引用才能对上
	const fileNames = dedupeArchiveNames(names);
	const archivePrompt = archiveImageRefs(content, indexByPath, fileNames);

	return { prompt, images, names: fileNames, archivePrompt };
}

/** 把 Date 格式化为 yyMMddHHmmssSSS（毫秒级，任务文件夹名唯一性依赖它） */
export function formatStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		String(d.getFullYear()).slice(2) +
		p(d.getMonth() + 1) +
		p(d.getDate()) +
		p(d.getHours()) +
		p(d.getMinutes()) +
		p(d.getSeconds()) +
		String(d.getMilliseconds()).padStart(3, '0')
	);
}

/** Markdown 文件名（去扩展名），作为生成图片的名称前缀 */
export function mdBaseName(mdUri: vscode.Uri): string {
	return uriStem(mdUri);
}

/**
 * 在 .image-flow/tasks/ 下创建任务文件夹，返回 [文件夹名, 目录 Uri]。
 * 文件夹名 = 毫秒级时间戳；createDirectory 会递归补建父目录。
 */
export async function createTaskFolder(): Promise<[string, vscode.Uri]> {
	const folder = formatStamp(new Date());
	const dir = vscode.Uri.joinPath(tasksRoot(), folder);
	await vscode.workspace.fs.createDirectory(dir);
	return [folder, dir];
}

/**
 * 下载一批图片 URL 到任务文件夹，文件名为 {前缀}-{起始序号..}，返回新增的图片引用。
 * @param startIndex 已有图片数，用于接续编号，避免不同 job 的图片重名
 */
export async function downloadImages(
	taskDir: vscode.Uri,
	prefix: string,
	urls: string[],
	startIndex: number
): Promise<TaskImage[]> {
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
		const fileUri = vscode.Uri.joinPath(taskDir, name);
		await vscode.workspace.fs.writeFile(fileUri, data);
		images.push({ name, uri: fileUri.toString() });
	}
	return images;
}

/**
 * 扫描 .image-flow/tasks/ 下所有任务文件夹，读取其中图片为缩略图，
 * 按文件夹名（毫秒时间戳）倒序返回——较新的任务在前。
 * 非递归、仅收图片文件：提示词 .md 与 input/ 归档子目录天然被忽略。
 * @param exclude 进行中任务的文件夹名集合，这些由顶部待办卡片实时展示，历史里跳过避免重复。
 */
export async function listHistory(exclude?: Set<string>): Promise<Task[]> {
	let root: vscode.Uri;
	try {
		root = tasksRoot();
	} catch {
		return []; // 无工作区：无历史可言
	}
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(root);
	} catch {
		return [];
	}

	const folders = entries
		.filter(([, type]) => type === vscode.FileType.Directory)
		.map(([name]) => name)
		.filter((name) => !exclude?.has(name))
		.sort()
		.reverse();

	const tasks: Task[] = [];
	for (const folder of folders) {
		const dir = vscode.Uri.joinPath(root, folder);
		let files: [string, vscode.FileType][];
		try {
			files = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			continue;
		}
		const images: TaskImage[] = [];
		let promptName: string | undefined;
		for (const [name, type] of files.sort()) {
			if (type !== vscode.FileType.File) {
				continue;
			}
			// 归档的提示词 .md 主名（来源 md 名 / edit），仅作旧任务（无 meta.json）的回退展示
			if (!promptName && name.toLowerCase().endsWith('.md')) {
				promptName = name.slice(0, -3);
				continue;
			}
			if (!isImageFileName(name)) {
				continue;
			}
			const fileUri = vscode.Uri.joinPath(dir, name);
			images.push({ name, uri: fileUri.toString() });
		}
		// 以 meta.json 为准收录：失败任务（0 成图但有 meta）也留痕进历史；
		// 旧任务无 meta 时回退到「有图才收录」+ 按文件名推断 promptName。
		const meta = await readTaskMeta(dir);
		if (meta || images.length) {
			tasks.push({ folder, images, promptName, meta });
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
	const { prompt: basePrompt, images } = await buildPrompt(mdUri, content);
	const prompt = await buildInjectedPrompt(config, basePrompt);
	const text = buildPreviewText(config, prompt, images);
	await openTextPreview(text);
}

/** 请求预览文档统一命名 preview.md，拦截误触生成时按此名识别 */
export const PREVIEW_DOC_NAME = 'preview.md';

/** 该 Uri 是否为请求预览文档——其内容是请求参数而非正文，不能用于生成 */
export function isPreviewDoc(uri: vscode.Uri): boolean {
	return path.basename(uri.fsPath).toLowerCase() === PREVIEW_DOC_NAME;
}

/**
 * 把文本写入系统临时目录的 .md 文件并打开预览。
 * 用临时文件而非 untitled 文档：内容已落盘，关闭时不会弹「是否保存」。
 */
export async function openTextPreview(text: string): Promise<void> {
	const dir = path.join(os.tmpdir(), 'image-flow');
	const uri = vscode.Uri.file(path.join(dir, PREVIEW_DOC_NAME));
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
	const doc = await vscode.workspace.openTextDocument(uri);
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
		vscode.window.showErrorMessage(`Image Flow：${errMsg(err)}`);
	}
}
