import * as vscode from 'vscode';
import type { Task, TaskImage } from '../shared';
import { fetchWithTimeout } from '../backend/api';
import { isImageExt, isImageFileName, extFromMime } from '../util/images';
import type { ResultItem } from '../backend/adapters/types';
import { uriStem } from '../storage/paths';
import { tasksRoot } from '../storage/storage';
import { readTaskMeta } from './taskFiles';

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
 * 把一批产出结果落盘到任务文件夹，文件名为 {前缀}-{起始序号..}，返回新增的图片引用。
 * 统一处理两类结果：url 下载、base64 解码写文件——async（grsai）与 sync（openai/gemini）adapter 共用。
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
		let data: Uint8Array;
		let ext: string;
		if (item.kind === 'url') {
			const res = await fetchWithTimeout(item.url);
			if (!res.ok) {
				throw new Error(`下载图片失败（HTTP ${res.status}）`);
			}
			data = new Uint8Array(await res.arrayBuffer());
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
