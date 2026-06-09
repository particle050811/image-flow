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
	return MIME_BY_EXT[ext.toLowerCase()] ?? 'image/png';
}
