// 图片相关的共享常量与判断。扩展名白名单原先在 command.ts 与 materials.ts 各有一份，
// 这里统一为单一来源，避免漂移。

import * as path from 'path';

/** 扩展名到 MIME 类型的映射，用于拼接参考图 base64 data URI（单一来源，对外只暴露下方判断函数） */
const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

/** 音频扩展名 → MIME。与图片分表，类型判定与 data URI 拼接共用 */
const AUDIO_BY_EXT: Record<string, string> = {
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
};

/** 视频扩展名 → MIME */
const VIDEO_BY_EXT: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.mkv': 'video/x-matroska',
	'.avi': 'video/x-msvideo',
};

/** 媒体大类：图片 / 音频 / 视频。扩展名区分，未知回退图片（沿用旧行为：任意 ![](路径) 当图片处理） */
export type MediaType = 'image' | 'audio' | 'video';

/** 取扩展名（含点，大小写不敏感）所属的媒体大类 */
export function mediaTypeOf(ext: string): MediaType {
	const e = ext.toLowerCase();
	if (e in AUDIO_BY_EXT) {
		return 'audio';
	}
	if (e in VIDEO_BY_EXT) {
		return 'video';
	}
	return 'image';
}

/** 扩展名（含点，大小写不敏感）是否为受支持的图片 */
export function isImageExt(ext: string): boolean {
	return ext.toLowerCase() in MIME_BY_EXT;
}

/** 文件名（取其扩展名）是否为受支持的图片 */
export function isImageFileName(name: string): boolean {
	return isImageExt(path.extname(name));
}

/** 取扩展名对应的 MIME，未知回退 image/png */
export function mimeOf(ext: string): string {
	const e = ext.toLowerCase();
	return MIME_BY_EXT[e] ?? AUDIO_BY_EXT[e] ?? VIDEO_BY_EXT[e] ?? 'image/png';
}
