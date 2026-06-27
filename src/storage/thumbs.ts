// 真缩略图（F051）：素材库/任务历史/进行中任务的图片原先以全尺寸原图直接作 <img src>，
// 解码内存、首屏延迟、SW 缓存全按原图付费。方案：扩展侧解析「该图有没有缩略图」，
// 有则下发缩略图 Uri 作 src；没有则照常下发原图 src 并附带 thumbKey，由 webview 用
// canvas 降采样（见 src/webview/thumbs.ts）后回传，这里落盘到 .image-flow/thumbs/。
// key 取 sha1(uri+mtime+size)：原图被覆盖/重新生成时自动得到新 key，旧缩略图自然失效。
// 已知取舍：失效的旧缩略图不做回收（单张 ~20KB，量级可忽略），换实现简单。

import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { workspaceRoot } from './storage';

/** 缩略图统一存放目录：<工作区根>/.image-flow/thumbs；无工作区返回 undefined（此时不做缩略图） */
export function thumbsRoot(): vscode.Uri | undefined {
	const root = workspaceRoot();
	return root ? vscode.Uri.joinPath(root, '.image-flow', 'thumbs') : undefined;
}

/** 不做缩略图的格式：svg 是矢量文本本就小，gif 降采样会丢动画 */
const SKIP_EXTS = new Set(['.svg', '.gif']);
/** 原图小于此字节数时直接展示原图，不值得做缩略图 */
const MIN_SIZE = 100 * 1024;

/** 单张图的缩略图解析结果。两字段互斥：有缩略图给 thumbUri，需要生成给 thumbKey，不适用则都缺省 */
export interface ThumbInfo {
	thumbUri?: vscode.Uri;
	thumbKey?: string;
}

interface CacheEntry {
	/** undefined = 跳过（svg/gif/小图/stat 失败） */
	key?: string;
	hasThumb: boolean;
}

// 会话级内存缓存：任务产物与素材图基本不可变，缓存住可避免每次推送（任务进度每 4s 触发）都 stat 全量图片。
// 代价是图片在会话中被替换时缩略图不刷新——重载窗口即恢复，接受。
const cache = new Map<string, CacheEntry>();
const byKey = new Map<string, CacheEntry>();

/** 缩略图 key：uri+mtime+size 的 sha1 */
export function thumbKeyOf(uri: string, mtime: number, size: number): string {
	return createHash('sha1').update(`${uri}|${mtime}|${size}`).digest('hex');
}

function thumbFile(root: vscode.Uri, key: string): vscode.Uri {
	return vscode.Uri.joinPath(root, `${key}.webp`);
}

/** 解析一张图的缩略图状态（带会话级缓存） */
export async function resolveThumb(uriStr: string): Promise<ThumbInfo> {
	const root = thumbsRoot();
	if (!root) {
		return {};
	}
	let entry = cache.get(uriStr);
	if (!entry) {
		const built = await buildEntry(uriStr, root);
		// stat 瞬时失败（文件被占用等）不进缓存，下次推送重试；只缓存确定的判定
		if (!built) {
			return {};
		}
		entry = built;
		cache.set(uriStr, entry);
		if (entry.key) {
			byKey.set(entry.key, entry);
		}
	}
	if (!entry.key) {
		return {};
	}
	return entry.hasThumb ? { thumbUri: thumbFile(root, entry.key) } : { thumbKey: entry.key };
}

/** 构建一张图的缓存条目；原图 stat 失败返回 null（不可缓存，留待重试） */
async function buildEntry(uriStr: string, root: vscode.Uri): Promise<CacheEntry | null> {
	const uri = vscode.Uri.parse(uriStr);
	if (SKIP_EXTS.has(path.extname(uri.path).toLowerCase())) {
		return { hasThumb: false };
	}
	let stat: vscode.FileStat;
	try {
		stat = await vscode.workspace.fs.stat(uri);
	} catch {
		return null;
	}
	if (stat.size < MIN_SIZE) {
		return { hasThumb: false };
	}
	const key = thumbKeyOf(uriStr, stat.mtime, stat.size);
	let hasThumb = false;
	try {
		await vscode.workspace.fs.stat(thumbFile(root, key));
		hasThumb = true;
	} catch {
		// 缩略图尚不存在
	}
	return { key, hasThumb };
}

const DATA_RE = /^data:image\/webp;base64,([A-Za-z0-9+/]+=*)$/;

/** 写入 webview 回传的缩略图。只接受本会话下发过的 key——天然限定了文件名形状（sha1 hex），防路径穿越 */
export async function saveThumb(key: string, dataUri: string): Promise<void> {
	const root = thumbsRoot();
	const entry = byKey.get(key);
	if (!root || !entry || entry.hasThumb) {
		return;
	}
	const m = DATA_RE.exec(dataUri);
	if (!m) {
		return;
	}
	await vscode.workspace.fs.createDirectory(root);
	await vscode.workspace.fs.writeFile(thumbFile(root, key), Buffer.from(m[1], 'base64'));
	entry.hasThumb = true;
}
