import * as vscode from 'vscode';
import * as path from 'path';
import type { MaterialLibrary, TaskImage } from './shared';
import { isImageExt } from './images';
import { uriBaseName } from './paths';

/** 素材库文件夹列表（file Uri 字符串）存于 workspaceState——按工作区隔离，不同项目互不混用 */
const LIBS_KEY = 'image-flow.materialLibraries';

/** 递归扫描时的目录深度上限 */
const MAX_DEPTH = 3;

/** 单个素材库扫描的条目数上限——防止用户误把 C 盘等超大目录加入导致卡死 */
const MAX_ENTRIES = 500;

function isImage(name: string): boolean {
	return isImageExt(path.extname(name));
}

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

	const images: TaskImage[] = [];
	for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		if (counter.count >= MAX_ENTRIES) {
			break;
		}
		counter.count++;
		const child = vscode.Uri.joinPath(dir, name);
		if (type === vscode.FileType.Directory) {
			images.push(...(await scanImages(child, depth + 1, counter)));
		} else if (type === vscode.FileType.File && isImage(name)) {
			images.push({ name, uri: child.toString() });
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
		const images = await scanImages(uri, 0, { count: 0 });
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
	const images: TaskImage[] = [];
	let scanned = 0;
	for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		if (scanned >= MAX_ENTRIES) {
			break;
		}
		scanned++;
		if (type === vscode.FileType.File && isImage(name)) {
			images.push({ name, uri: vscode.Uri.joinPath(dir, name).toString() });
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
		const images = await scanDirImages(cur);
		if (images.length) {
			libs.push({ folder: cur.toString(), name: seg, images });
		}
	}
	return libs;
}

