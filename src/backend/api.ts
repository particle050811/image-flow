// 后端调用的公共底层：带超时的 fetch、瞬时错误标记、grsai 返回结构校验、vip 尺寸换算。
// 不依赖具体协议——各 adapter（src/adapters/*）在此之上拼协议。本文件是依赖叶子，不 import adapter/provider。

/** 可重试的瞬时错误（如上游网关 5xx）。轮询遇到此类错误保持 running、下轮再试，不直接判失败 */
export class TransientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TransientError';
	}
}

/** 网络请求默认超时（ms）：避免挂起的连接卡住轮询串行锁 */
const FETCH_TIMEOUT = 30000;

/** 响应体大小上限：JSON 体（含 base64 形式的成图）与 URL 下载共用，防异常 Provider 一次撑爆宿主内存 */
export const MAX_BODY_BYTES = 100 * 1024 * 1024;
/** 响应体读取窗口（ms）：fetchWithTimeout 只覆盖到收到响应头，这里覆盖正文传输全程 */
const BODY_TIMEOUT = 120 * 1000;
/** 控制面 JSON（提交回执/轮询状态/命名）正常只有 KB 级：小上限 + 短窗口，
 *  异常查询体不至于占 100MB 内存或把串行轮询卡住两分钟 */
export const CONTROL_BODY_BYTES = 5 * 1024 * 1024;
export const CONTROL_BODY_TIMEOUT = 30 * 1000;

/**
 * 按上限、带全程超时读取响应体（F100/F101）：
 * - Content-Length 预检 + 流式累计双保险，超限即断流报错；
 * - 超时覆盖从开始读到正文读完的全过程——上游只发响应头不发完正文时断流，
 *   抛 TransientError 让轮询按瞬时错误重试，而不是无限等待卡死轮询串行锁。
 */
export async function readBodyLimited(
	res: Response,
	what: string,
	maxBytes = MAX_BODY_BYTES,
	timeoutMs = BODY_TIMEOUT
): Promise<Uint8Array> {
	const overLimitError = () => new Error(`${what}超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`);
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		// 预检拒收也要取消正文：否则上游继续推送大响应，占着 socket/连接池，限量就只省了内存
		void res.body?.cancel().catch(() => {});
		throw overLimitError();
	}
	if (!res.body) {
		// 无流式 body（空体或实现差异）：一次性读取后按上限校验
		const data = new Uint8Array(await res.arrayBuffer());
		if (data.byteLength > maxBytes) {
			throw overLimitError();
		}
		return data;
	}
	const reader = res.body.getReader();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void reader.cancel().catch(() => {});
	}, timeoutMs);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw overLimitError();
			}
			chunks.push(value);
		}
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) {
		throw new TransientError(`${what}读取超时（${Math.round(timeoutMs / 1000)}s 内未传完）`);
	}
	return Buffer.concat(chunks);
}

/**
 * 限时限量读取响应体并解析为 JSON（替代裸 `response.json()`）。
 * 解析失败报带上下文的错误，而不是裸 SyntaxError。
 * 上限/超时默认按成图体（100MB/120s）；控制面调用传 CONTROL_BODY_BYTES/CONTROL_BODY_TIMEOUT。
 */
export async function readJsonLimited(
	res: Response,
	what: string,
	maxBytes = MAX_BODY_BYTES,
	timeoutMs = BODY_TIMEOUT
): Promise<unknown> {
	const bytes = await readBodyLimited(res, what, maxBytes, timeoutMs);
	// Response.json() 接受带 BOM 的 JSON，Buffer.toString 会保留 U+FEFF 导致 parse 报错——剥掉保持等价
	let text = Buffer.from(bytes).toString('utf8');
	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${what}不是合法 JSON（HTTP ${res.status}）`);
	}
}

/**
 * 带超时的 fetch：超时即 abort 抛错，由调用方按瞬时错误处理。
 * 抽出供 generate/result/下载图片共用，避免任一请求挂死拖垮整个轮询。
 */
export async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
	timeoutMs = FETCH_TIMEOUT
): Promise<Response> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ac.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 规整 baseUrl 再拼路径：去尾部斜杠 + 去尾部 `/v1`。
 * 内置 grsai 约定 baseUrl 为根地址（不带 /v1），但第三方 OpenAI 兼容地址用户常按 SDK 习惯填成
 * `https://host/v1`；各 adapter 拼完整路径（/v1/... 或 /v1beta/...）前先过它，避免 `/v1/v1/...` 重复。
 * 只剥精确的尾部 `/v1`，不动 `/v1beta`。
 */
export function normalizeBase(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** grsai generate / result 接口返回结构（与 nano-banana、gpt-image-2 共用） */
export interface GenerateResponse {
	/** generate 返回的任务 id；result 接口不带，故可选 */
	id?: string;
	status: 'running' | 'violation' | 'succeeded' | 'failed';
	results?: { url: string }[];
	progress?: number;
	error?: string;
}

const VALID_STATUS = new Set(['running', 'violation', 'succeeded', 'failed']);

/**
 * 校验并收窄接口返回：信任边界。status 必校验；id/results/error 若存在则校验其形状，
 * 缺省（undefined）放行——这样返回类型 GenerateResponse 的每个字段都名副其实，
 * 调用方据此取值不会撞上「类型说有、运行时没有」的隐性炸点，而非裸 as 一概断言。
 */
export function parseGenerateResponse(data: unknown): GenerateResponse {
	if (!data || typeof data !== 'object') {
		throw new Error('接口返回格式异常：非对象');
	}
	const obj = data as Record<string, unknown>;
	if (typeof obj.status !== 'string' || !VALID_STATUS.has(obj.status)) {
		throw new Error(`接口返回的 status 异常：${String(obj.status)}`);
	}
	if (obj.id !== undefined && typeof obj.id !== 'string') {
		throw new Error('接口返回的 id 类型异常');
	}
	if (obj.error !== undefined && typeof obj.error !== 'string') {
		throw new Error('接口返回的 error 类型异常');
	}
	if (
		obj.results !== undefined &&
		(!Array.isArray(obj.results) ||
			obj.results.some((r) => !r || typeof r !== 'object' || typeof (r as { url?: unknown }).url !== 'string'))
	) {
		throw new Error('接口返回的 results 结构异常');
	}
	return obj as unknown as GenerateResponse;
}

/**
 * gpt-image-2-vip 只接受像素值，这里按「比例 + 分辨率」换算。
 * 数值取自官方文档的 vip 比例参考表（1K / 2K / 4K，共 15 个比例 + auto）。
 * 第三方 openai-images 的 size 同此规则。
 */
const VIP_PIXEL_TABLE: Record<string, Partial<Record<'1K' | '2K' | '4K', string>>> = {
	'1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
	'16:9': { '1K': '1280x720', '2K': '2048x1152', '4K': '3840x2160' },
	'9:16': { '1K': '720x1280', '2K': '1152x2048', '4K': '2160x3840' },
	'4:3': { '1K': '1152x864', '2K': '2304x1728', '4K': '3264x2448' },
	'3:4': { '1K': '864x1152', '2K': '1728x2304', '4K': '2448x3264' },
	'3:2': { '1K': '1536x1024', '2K': '2048x1360', '4K': '3504x2336' },
	'2:3': { '1K': '1024x1536', '2K': '1360x2048', '4K': '2336x3504' },
	'5:4': { '1K': '1120x896', '2K': '2240x1792', '4K': '3200x2560' },
	'4:5': { '1K': '896x1120', '2K': '1792x2240', '4K': '2560x3200' },
	'21:9': { '1K': '1456x624', '2K': '2912x1248', '4K': '3840x1648' },
	'9:21': { '1K': '624x1456', '2K': '1248x2912', '4K': '1648x3840' },
	// 1:3 / 3:1 官方仅给 2K/4K（无 1K）：选 1K 时由 toVipPixels 并到最近可用档（2K）
	'1:3': { '2K': '688x2048', '4K': '1280x3840' },
	'3:1': { '2K': '2048x688', '4K': '3840x1280' },
	'2:1': { '1K': '1536x768', '2K': '3072x1536', '4K': '3840x1920' },
	'1:2': { '1K': '768x1536', '2K': '1536x3072', '4K': '1920x3840' },
};

/**
 * 把比例 + 分辨率换算成 gpt-image-2-vip 需要的像素值。
 * - auto：合法但不换算，原样发 "auto"（让后端定尺寸）。
 * - 未知比例回退 1:1；未知分辨率回退 1K。
 * - 1:3 / 3:1 无 1K 档：并到最近可用档（2K），避免取到 undefined。
 */
export function toVipPixels(aspectRatio: string, imageSize: string): string {
	if (aspectRatio === 'auto') {
		return 'auto';
	}
	const row = VIP_PIXEL_TABLE[aspectRatio] ?? VIP_PIXEL_TABLE['1:1'];
	const size = (['1K', '2K', '4K'].includes(imageSize) ? imageSize : '1K') as '1K' | '2K' | '4K';
	return row[size] ?? row['2K'] ?? row['4K'] ?? row['1K'] ?? '1024x1024';
}

/**
 * 把「比例 + 档位」解析成发给「只认像素 / 兼 OpenAI size」协议的真实尺寸串。
 * - imageSize 已是 \d+x\d+ 像素串（用户在 settings.json 直接写死像素）→ 原样发；
 * - 否则按比例 + 档位换算（auto 经 toVipPixels 原样返回 "auto"）。
 * 供 openai-images（size 字段）等同步协议复用。
 */
export function resolveImageSize(aspectRatio: string, imageSize: string): string {
	if (/^\d+x\d+$/.test(imageSize)) {
		return imageSize;
	}
	return toVipPixels(aspectRatio, imageSize);
}
