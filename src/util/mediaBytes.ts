// 参考素材的字节预检：把文件读成 base64 之前先按大小拦一道。
// 素材全程以 base64（约 4/3 膨胀）驻内存，误引用一个超大文件就能把扩展宿主拖垮。
// 纯函数（不碰 IO），调用方自行 stat 出字节数后调用，便于直测。
// 注意这是 best-effort 预检、不是硬内存上限：stat 与真正读盘之间文件仍可能被换大（TOCTOU），
// 目的只是拦住「明显传错文件」，本机单用户创作场景不为该窗口再加锁或复检。

/** 一条待检素材：name 仅用于报错文案（路径或文件名皆可），size 为字节数 */
export interface MediaSize {
	name: string;
	size: number;
}

/** 一档上限。张数上限省略表示不限 */
export interface MediaByteLimits {
	maxCount?: number;
	/** 单个文件字节上限 */
	maxBytes: number;
	/** 合计字节上限 */
	maxTotalBytes: number;
	/** 报错文案里对素材的称呼 */
	label: string;
}

const MB = 1024 * 1024;

/** CLI edit 严格档：编辑模式只吃图片，真实参考图远小于此，触发基本意味着传错了文件 */
export const CLI_EDIT_LIMITS: MediaByteLimits = {
	maxCount: 20,
	maxBytes: 30 * MB,
	maxTotalBytes: 60 * MB,
	label: '参考图',
};

/**
 * 工作台正文引用与编辑区上传的宽松档：即梦全能参考视频模型吃数十 MB 的音视频素材是合法工作流，
 * 一刀切用严格档会砍掉现有能力，故这里只拦「明显传错文件」（整段片源、磁盘镜像之类），且不限个数。
 */
export const REF_MEDIA_LIMITS: MediaByteLimits = {
	maxBytes: 200 * MB,
	// 合计压到 300MB 而非 400MB：素材最终要拼进请求体一起 JSON.stringify，400MB 的 base64
	// 约 5.59 亿字符已超 V8 字符串上限（约 5.37 亿），会先抛不可读的 RangeError，友好文案反而兜不住
	maxTotalBytes: 300 * MB,
	label: '参考素材',
};

/** 字节数转 MB 文案（报错用）。向上取整到 0.1MB——只超几个字节时若四舍五入，
 *  会打出「超过单个上限 200MB（200MB）」这种自相矛盾的文案；上限值都是整数 MB，取整不影响 */
export function formatMb(bytes: number): string {
	return `${Math.ceil((bytes / MB) * 10) / 10}MB`;
}

/** data URI 的近似字节数：取逗号后的 base64 段按 3/4 折算（预检用，无需精确到 padding，会高估 1~2 字节）。
 *  名字带 approx 前缀与 taskFiles 的 dataUriBytes（真解码、返回 Uint8Array）区分，两者都服务参考图链路 */
export function approxDataUriBytes(dataUri: string): number {
	const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
	return Math.floor((base64.length * 3) / 4);
}

/**
 * 只校验个数上限，返回错误文案，null 表示通过（无 maxCount 的档位恒通过）。
 * 单独导出是给「stat 之前就要按张数拒掉」的调用方用——张数超标时不该再去访问任何路径。
 * 文案按图片场景写「张」：目前只有 CLI edit 档设了 maxCount，都是图片。
 */
export function checkMediaCount(count: number, limits: MediaByteLimits): string | null {
	const { label, maxCount } = limits;
	if (maxCount !== undefined && count > maxCount) {
		return `${label}最多 ${maxCount} 张，收到 ${count} 张`;
	}
	return null;
}

/**
 * 校验一组素材的个数与单个/合计字节是否在上限内，返回错误文案，null 表示通过。
 * 允许对「已扫到的前缀」增量调用（每 stat 一个调一次），以便调用方一超限就立刻停下。
 * baseBytes 是「已占用但不该再逐个复检」的字节基数（编辑区已入列的图），只计入合计——
 * 它们入列时已过一遍单个上限，且按 data URI 折算会高估，再检一遍会拿老图的名字报错。
 */
export function checkMediaBytes(items: MediaSize[], limits: MediaByteLimits, baseBytes = 0): string | null {
	const { label, maxBytes, maxTotalBytes } = limits;
	const overCount = checkMediaCount(items.length, limits);
	if (overCount) {
		return overCount;
	}
	let total = baseBytes;
	for (const item of items) {
		if (item.size > maxBytes) {
			return `${label}超过单个上限 ${formatMb(maxBytes)}（${formatMb(item.size)}）：${item.name}`;
		}
		total += item.size;
		if (total > maxTotalBytes) {
			return `${label}合计超过 ${formatMb(maxTotalBytes)} 上限，请减少数量或换小文件`;
		}
	}
	return null;
}
