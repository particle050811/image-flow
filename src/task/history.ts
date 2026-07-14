import * as vscode from 'vscode';
import type { Task, TaskImage } from '../shared';
import { fetchWithTimeout, readBodyLimited } from '../backend/api';
import { isImageExt, isMediaExt, isMediaFileName, mediaTypeOfFileName, extFromMime } from '../util/images';
import type { ResultItem } from '../backend/adapters/types';
import { uriStem } from '../storage/paths';
import { tasksRoot } from '../storage/storage';
import { readTaskMeta } from './taskFiles';
import { PREVIEW_DOC_NAME } from './preview';

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
 * 在 .image-flow/tasks/ 下创建任务文件夹，返回 [文件夹标识, 目录 Uri]。
 * 两级结构 <yyMMdd>/<HHmmssSSS>（按天分组便于人工浏览），标识 = "天/时刻"（含斜杠，
 * 全库唯一、等长字段字典序即时间序）；createDirectory 会递归补建父目录。
 */
export async function createTaskFolder(): Promise<[string, vscode.Uri]> {
	const stamp = formatStamp(new Date());
	const folder = `${stamp.slice(0, 6)}/${stamp.slice(6)}`;
	const dir = vscode.Uri.joinPath(tasksRoot(), folder);
	await vscode.workspace.fs.createDirectory(dir);
	return [folder, dir];
}

/**
 * 把一批产出结果落盘到任务文件夹，文件名为 {前缀}-{起始序号..}，返回新增的图片引用。
 * 统一处理三类结果：url 下载、base64 解码写文件、file（CLI 已下载的本地临时文件）移入并重命名——
 * async（grsai/jimeng）与 sync（openai/gemini）adapter 共用。
 * @param startIndex 已有图片数，用于接续编号，避免不同 job 的图片重名
 */
export async function saveResults(
	taskDir: vscode.Uri,
	prefix: string,
	items: ResultItem[],
	startIndex: number
): Promise<TaskImage[]> {
	const images: TaskImage[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.kind === 'file') {
			// CLI 型结果：临时目录里的成品移入任务文件夹并按统一规则重命名（保留原扩展名，视频 .mp4 同样落盘）
			const rawExt = '.' + (item.path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '');
			const ext = isMediaExt(rawExt) ? rawExt.slice(1) : 'png';
			const name = `${prefix}-${startIndex + i + 1}.${ext}`;
			const fileUri = vscode.Uri.joinPath(taskDir, name);
			const src = vscode.Uri.file(item.path);
			try {
				await vscode.workspace.fs.rename(src, fileUri, { overwrite: true });
			} catch {
				// 临时目录与工作区可能跨盘（rename 失败）：退回复制 + 尽力删源
				await vscode.workspace.fs.copy(src, fileUri, { overwrite: true });
				try {
					await vscode.workspace.fs.delete(src);
				} catch {
					/* 源清理失败无害，系统临时目录自然回收 */
				}
			}
			images.push({ name, uri: fileUri.toString(), media: mediaTypeOfFileName(name) });
			continue;
		}
		let data: Uint8Array;
		let ext: string;
		if (item.kind === 'url') {
			const res = await fetchWithTimeout(item.url);
			if (!res.ok) {
				// 不读错误体就抛：先取消正文释放连接
				void res.body?.cancel().catch(() => {});
				throw new Error(`下载图片失败（HTTP ${res.status}）`);
			}
			data = await readBodyLimited(res, '下载图片');
			// 从 URL 取扩展名，校验落在图片白名单内，否则回退 png——避免畸形 URL 落地怪扩展名
			const rawExt = '.' + (item.url.split('?')[0].split('.').pop()?.toLowerCase() || 'png');
			ext = isImageExt(rawExt) ? rawExt.slice(1) : 'png';
		} else {
			data = new Uint8Array(Buffer.from(item.data, 'base64'));
			ext = extFromMime(item.mime);
		}
		const name = `${prefix}-${startIndex + i + 1}.${ext}`;
		const fileUri = vscode.Uri.joinPath(taskDir, name);
		await vscode.workspace.fs.writeFile(fileUri, data);
		images.push({ name, uri: fileUri.toString() });
	}
	return images;
}

/**
 * 扫描 .image-flow/tasks/<天>/<时刻> 两级结构下所有任务文件夹，读取其中图片为缩略图，
 * 按文件夹标识（"天/时刻"）倒序返回——较新的任务在前。
 * 任务夹内非递归、仅收图片文件：提示词 .md 与 input/ 归档子目录天然被忽略。
 * @param exclude 进行中任务的文件夹标识集合，这些由顶部待办卡片实时展示，历史里跳过避免重复。
 */
export async function listHistory(exclude?: Set<string>): Promise<Task[]> {
	let root: vscode.Uri;
	try {
		root = tasksRoot();
	} catch {
		return []; // 无工作区：无历史可言
	}
	let dayEntries: [string, vscode.FileType][];
	try {
		dayEntries = await vscode.workspace.fs.readDirectory(root);
	} catch {
		return [];
	}

	const folders: string[] = [];
	for (const [day, type] of dayEntries) {
		// 只认 6 位日期夹：用户手工放进 tasks/ 的目录不当任务层级扫描
		if (type !== vscode.FileType.Directory || !/^\d{6}$/.test(day)) {
			continue;
		}
		let subs: [string, vscode.FileType][];
		try {
			subs = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, day));
		} catch {
			continue;
		}
		for (const [sub, subType] of subs) {
			// 只认 9 位时刻夹：日期夹里混入的备份/手工目录不误收为任务
			if (subType !== vscode.FileType.Directory || !/^\d{9}$/.test(sub)) {
				continue;
			}
			const folder = `${day}/${sub}`;
			if (!exclude?.has(folder)) {
				folders.push(folder);
			}
		}
	}
	folders.sort().reverse();

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
			// 归档的提示词 .md 主名（来源 md 名 / edit），仅作旧任务（无 meta.json）的回退展示。
			// 跳过 preview.md（构建并复制的可复制副本，非源提示词）
			if (!promptName && name.toLowerCase().endsWith('.md') && name.toLowerCase() !== PREVIEW_DOC_NAME) {
				promptName = name.slice(0, -3);
				continue;
			}
			// 收图片 + 音/视频：「构建并复制」的视频任务把外部下载的成片放回任务夹后，卡片也能展示
			if (!isMediaFileName(name)) {
				continue;
			}
			const fileUri = vscode.Uri.joinPath(dir, name);
			images.push({ name, uri: fileUri.toString(), media: mediaTypeOfFileName(name) });
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

/** 清理保留期：只清创建超过此时长的无产物夹，给「构建并复制」后去外部出片留足时间 */
const CLEAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 解析任务文件夹标识（"yyMMdd/HHmmssSSS"）为创建时刻 epoch ms；非该格式返回 null。
 * 用于清理时按文件夹年龄判定，而非依赖各平台不一的 mtime。
 */
function folderCreatedAt(folder: string): number | null {
	if (!/^\d{6}\/\d{9}$/.test(folder)) {
		return null;
	}
	const digits = folder.replace('/', '');
	const n = (a: number, b: number) => Number(digits.slice(a, b));
	const year = 2000 + n(0, 2);
	const month = n(2, 4);
	const day = n(4, 6);
	const d = new Date(year, month - 1, day, n(6, 8), n(8, 10), n(10, 12), n(12, 15));
	// 回环校验：拒绝月/日越界的伪时间戳
	if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
		return null;
	}
	return d.getTime();
}

/**
 * 启动时清理「无产物」任务文件夹：顶层无图/音/视频文件、且创建满 minAgeMs（默认 1 天）的整夹删除。
 * 覆盖两类：「构建并复制」后外部视频未下载回来的空壳、以及生成失败（0 成图）的留痕夹。
 * 任务夹内非递归只看顶层——input/ 归档子目录里的参考媒体不计数，避免把还没回收成片的视频任务误判为有产物。
 * 时间戳解析不出（非任务文件夹标识）或还不够老的一律保留，宁可少清不误删。
 * 任务夹清完后顺带删掉被清空的日期夹（仅限 6 位日期命名的，其余目录不碰）。
 * @param exclude 进行中（持久化待续拉）任务的文件夹标识集合，正在下载中不能删。
 * @param minAgeMs 文件夹至少存在多久才允许清理，默认 1 天。
 * @returns 实际删除的任务文件夹数（不含日期夹）。
 */
export async function cleanEmptyTaskFolders(
	exclude: Set<string>,
	minAgeMs = CLEAN_MIN_AGE_MS
): Promise<number> {
	let root: vscode.Uri;
	try {
		root = tasksRoot();
	} catch {
		return 0; // 无工作区：无任务可清
	}
	let dayEntries: [string, vscode.FileType][];
	try {
		dayEntries = await vscode.workspace.fs.readDirectory(root);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const [day, type] of dayEntries) {
		if (type !== vscode.FileType.Directory) {
			continue;
		}
		const dayDir = vscode.Uri.joinPath(root, day);
		let subs: [string, vscode.FileType][];
		try {
			subs = await vscode.workspace.fs.readDirectory(dayDir);
		} catch {
			continue;
		}
		for (const [sub, subType] of subs) {
			const folder = `${day}/${sub}`;
			if (subType !== vscode.FileType.Directory || exclude.has(folder)) {
				continue;
			}
			// 只清够老的：时间戳解析不出或还不满保留期的一律保留，给外部出片留足时间
			const createdAt = folderCreatedAt(folder);
			if (createdAt === null || Date.now() - createdAt < minAgeMs) {
				continue;
			}
			const dir = vscode.Uri.joinPath(dayDir, sub);
			let files: [string, vscode.FileType][];
			try {
				files = await vscode.workspace.fs.readDirectory(dir);
			} catch {
				continue;
			}
			const hasMedia = files.some(([name, t]) => t === vscode.FileType.File && isMediaFileName(name));
			if (hasMedia) {
				continue;
			}
			try {
				await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
				removed++;
			} catch {
				/* 删除失败（占用/权限）跳过，不阻断启动 */
			}
		}
		// 日期夹被清空则顺带删除；只删 6 位日期命名的，避免误删用户手工放进 tasks/ 的目录
		if (/^\d{6}$/.test(day)) {
			try {
				const remain = await vscode.workspace.fs.readDirectory(dayDir);
				if (!remain.length) {
					await vscode.workspace.fs.delete(dayDir, { recursive: false, useTrash: false });
				}
			} catch {
				/* 读取/删除失败无害，留待下次启动再清 */
			}
		}
	}
	return removed;
}
