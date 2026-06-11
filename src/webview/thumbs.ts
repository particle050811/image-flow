// 缩略图生成（F051 / F042②）：扩展推送的图片若带 thumbKey（原图大、尚无缩略图），
// 在 webview 用 canvas 降采样为 ≤512px 的 webp 回传扩展落盘（saveThumb）；
// 编辑区图片同理按 name 回传（saveEditThumb），扩展存为压缩展示图、后续推送不再发原图。
// 队列限流：并发解码多张 20MB 级原图很吃内存，最多同时处理 2 张。

import { vscode } from './vscode';

const MAX_DIM = 512;
const QUALITY = 0.8;
const MAX_ACTIVE = 2;

interface Job {
	src: string;
	/** 生成结束回调（失败时 data 为 null）：负责去重清理与回传消息 */
	onResult: (data: string | null) => void;
}

const queue: Job[] = [];
let active = 0;

/** 已入队过的任务/素材图 key：扩展在确认落盘前会反复推送同一 key，按 key 终身去重（失败不重试，重载即重来） */
const requestedKeys = new Set<string>();
/** 生成中的编辑图 name：完成回传后扩展即停发 needsThumb，故只需在飞行期间去重 */
const inflightEdit = new Set<string>();

/** 任务/素材图：对带 thumbKey 的图入队生成，回传 saveThumb */
export function requestThumbs(images: { src: string; thumbKey?: string }[]): void {
	for (const img of images) {
		const key = img.thumbKey;
		if (!key || requestedKeys.has(key)) {
			continue;
		}
		requestedKeys.add(key);
		queue.push({
			src: img.src,
			onResult: (data) => {
				if (data) {
					vscode.postMessage({ type: 'saveThumb', key, data });
				}
			},
		});
	}
	pump();
}

/** 编辑区图片：对标记 needsThumb 的图入队生成，回传 saveEditThumb */
export function requestEditThumbs(images: { name: string; src: string; needsThumb?: boolean }[]): void {
	for (const img of images) {
		if (!img.needsThumb || inflightEdit.has(img.name)) {
			continue;
		}
		inflightEdit.add(img.name);
		const name = img.name;
		// 原图指纹：needsThumb 时 src 即原图 data URI。生成期间同名图被删后换图，
		// 扩展侧据此丢弃过期回传，避免旧图缩略图错挂到新图上
		const srcLength = img.src.length;
		queue.push({
			src: img.src,
			onResult: (data) => {
				inflightEdit.delete(name);
				if (data) {
					vscode.postMessage({ type: 'saveEditThumb', name, srcLength, data });
				}
			},
		});
	}
	pump();
}

function pump(): void {
	while (active < MAX_ACTIVE && queue.length) {
		const job = queue.shift()!;
		active++;
		void shrink(job.src)
			.catch(() => null)
			.then((data) => job.onResult(data))
			.finally(() => {
				active--;
				pump();
			});
	}
}

/** 降采样：最长边压到 MAX_DIM（小图不放大，仅重编码为 webp），输出 data URI */
async function shrink(src: string): Promise<string | null> {
	const img = new Image();
	img.src = src;
	await img.decode();
	const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight, 1));
	const w = Math.max(1, Math.round(img.naturalWidth * scale));
	const h = Math.max(1, Math.round(img.naturalHeight * scale));
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return null;
	}
	ctx.drawImage(img, 0, 0, w, h);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, 'image/webp', QUALITY)
	);
	if (!blob) {
		return null;
	}
	return await new Promise<string | null>((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(blob);
	});
}
