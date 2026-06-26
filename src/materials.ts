import * as vscode from 'vscode';
import type { MaterialLibrary, TaskImage } from './shared';
import { isImageFileName } from './images';
import { uriBaseName } from './paths';

/** 素材库文件夹列表（file Uri 字符串）存于 workspaceState——按工作区隔离，不同项目互不混用 */
const LIBS_KEY = 'image-flow.materialLibraries';

/** 递归扫描时的目录深度上限 */
const MAX_DEPTH = 3;

/** 从一份目录条目中收集所有 .md 文件的主名（小写，Windows 文件名大小写不敏感） */
export function mdStems(entries: [string, vscode.FileType][]): Set<string> {
	const stems = new Set<string>();
	for (const [name, type] of entries) {
		if (type === vscode.FileType.File && name.toLowerCase().endsWith('.md')) {
			stems.add(name.slice(0, -3).toLowerCase());
		}
	}
	return stems;
}

/** 图片主名（去扩展名、小写），用于与同目录 .md 主名匹配 */
export function imageStem(name: string): string {
	const dot = name.lastIndexOf('.');
	return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** 稳定排序：带同名 MD 描述的图片排前面，组内保持原序 */
export function sortDescFirst(images: TaskImage[]): TaskImage[] {
	return [...images.filter((i) => i.hasDesc), ...images.filter((i) => !i.hasDesc)];
}

/**
 * 读取图片旁同主名 .md 描述文件的内容（trim 后）。
 * 列父目录后按 imageStem/mdStems 同一套小写口径匹配真实文件名，
 * 与扫描打标 hasDesc 的判断完全一致（大小写敏感的文件系统上也不漂移）。
 * 不存在或读取失败返回空串——插入引用时退化为只插引用，不中断。
 */
export async function readImageDesc(imageUri: string): Promise<string> {
	const uri = vscode.Uri.parse(imageUri);
	const stem = imageStem(uri.path.split('/').pop() ?? '');
	if (!stem) {
		return '';
	}
	const parent = vscode.Uri.joinPath(uri, '..');
	try {
		const entries = await vscode.workspace.fs.readDirectory(parent);
		const mdName = entries.find(
			([name, type]) =>
				type === vscode.FileType.File &&
				name.toLowerCase().endsWith('.md') &&
				name.slice(0, -3).toLowerCase() === stem
		)?.[0];
		if (!mdName) {
			return '';
		}
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(parent, mdName));
		return Buffer.from(bytes).toString('utf8').trim();
	} catch {
		return '';
	}
}

/**
 * 从同主名 .md 描述里取「别名」：描述首个 `[别名]` 方括号片段（如 `- [九胡] 酒狐…` → `九胡`）。
 * 没有方括号片段返回空串，调用方退化为用文件名做 alt。
 */
export function aliasFromDesc(desc: string): string {
	return /\[([^\]]+)\]/.exec(desc)?.[1].trim() ?? '';
}

/** 单个素材库扫描的条目数上限——防止用户误把 C 盘等超大目录加入导致卡死 */
const MAX_ENTRIES = 500;

/** 读取已保存的素材库文件夹 Uri 列表 */
export function getLibraryFolders(context: vscode.ExtensionContext): string[] {
	return context.workspaceState.get<string[]>(LIBS_KEY, []);
}

/** 添加一个素材库文件夹（去重） */
export async function addLibraryFolder(
	context: vscode.ExtensionContext,
	folder: string
): Promise<void> {
	const list = getLibraryFolders(context);
	if (!list.includes(folder)) {
		await context.workspaceState.update(LIBS_KEY, [...list, folder]);
	}
}

/** 移除一个素材库文件夹 */
export async function removeLibraryFolder(
	context: vscode.ExtensionContext,
	folder: string
): Promise<void> {
	const list = getLibraryFolders(context).filter((f) => f !== folder);
	await context.workspaceState.update(LIBS_KEY, list);
}

/** 递归扫描一个目录下的所有图片。
 * counter 在递归间共享，统计已遍历条目数；超过 MAX_ENTRIES 即停止，
 * 防止用户误把 C 盘等超大目录加入导致卡死。 */
async function scanImages(
	dir: vscode.Uri,
	depth: number,
	counter: { count: number }
): Promise<TaskImage[]> {
	if (depth > MAX_DEPTH || counter.count >= MAX_ENTRIES) {
		return [];
	}
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return [];
	}

	const stems = mdStems(entries);
	const images: TaskImage[] = [];
	for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		if (counter.count >= MAX_ENTRIES) {
			break;
		}
		counter.count++;
		const child = vscode.Uri.joinPath(dir, name);
		if (type === vscode.FileType.Directory) {
			// 跳过扩展自身的工作目录：thumbs/ 是缩略图、tasks/ 是归档参考图，
			// 混入素材库会被当原图收藏/送编辑（缩略图路径还会读取失败）
			if (name === '.image-flow') {
				continue;
			}
			images.push(...(await scanImages(child, depth + 1, counter)));
		} else if (type === vscode.FileType.File && isImageFileName(name)) {
			images.push({ name, uri: child.toString(), hasDesc: stems.has(imageStem(name)) });
		}
	}
	return images;
}

/** 读取所有素材库并递归扫描各自的图片 */
export async function listLibraries(
	context: vscode.ExtensionContext
): Promise<MaterialLibrary[]> {
	const folders = getLibraryFolders(context);
	const libs: MaterialLibrary[] = [];
	for (const folder of folders) {
		const uri = vscode.Uri.parse(folder);
		const name = uriBaseName(uri);
		const images = sortDescFirst(await scanImages(uri, 0, { count: 0 }));
		libs.push({ folder, name, images });
	}
	return libs;
}

/** 只扫描单层目录里直接的图片（不递归），同样受 MAX_ENTRIES 保护（按遍历条目计数，与递归版口径一致） */
async function scanDirImages(dir: vscode.Uri): Promise<TaskImage[]> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return [];
	}
	const stems = mdStems(entries);
	const images: TaskImage[] = [];
	let scanned = 0;
	for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		if (scanned >= MAX_ENTRIES) {
			break;
		}
		scanned++;
		if (type === vscode.FileType.File && isImageFileName(name)) {
			images.push({
				name,
				uri: vscode.Uri.joinPath(dir, name).toString(),
				hasDesc: stems.has(imageStem(name)),
			});
		}
	}
	return images;
}

/**
 * 根据当前 Markdown 的路径自动生成素材库：
 * 从工作区根目录的下一层起，到 MD 所在目录为止，每一层各成一个库，
 * 只取该层目录里直接的图片（不递归）。不含工作区根目录本身那一层。
 */
export async function listAutoLibraries(mdUri: vscode.Uri): Promise<MaterialLibrary[]> {
	const ws = vscode.workspace.getWorkspaceFolder(mdUri);
	if (!ws) {
		return [];
	}
	const rootPath = ws.uri.path.replace(/\/+$/, '');
	const parentPath = mdUri.path.split('/').slice(0, -1).join('/');
	if (parentPath !== rootPath && !parentPath.startsWith(rootPath + '/')) {
		return [];
	}
	const segments = parentPath.slice(rootPath.length).split('/').filter(Boolean);

	const libs: MaterialLibrary[] = [];
	let cur = ws.uri;
	for (const seg of segments) {
		cur = vscode.Uri.joinPath(cur, seg);
		const images = sortDescFirst(await scanDirImages(cur));
		if (images.length) {
			libs.push({ folder: cur.toString(), name: seg, images });
		}
	}
	return libs;
}

