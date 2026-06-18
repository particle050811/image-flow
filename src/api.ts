import type { ImageFlowConfig } from './shared';

/** 可重试的瞬时错误（如上游网关 5xx）。轮询遇到此类错误保持 running、下轮再试，不直接判失败 */
export class TransientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TransientError';
	}
}

/** 网络请求默认超时（ms）：避免挂起的连接卡住轮询串行锁 */
const FETCH_TIMEOUT = 30000;

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

/** generate / result 接口返回结构（与 nano-banana、gpt-image-2 共用） */
interface GenerateResponse {
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
function parseGenerateResponse(data: unknown): GenerateResponse {
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

/** 命名输出上限：短名不需要长文，用 max_tokens 硬卡，避免模型啰嗦 */
const NAMING_MAX_TOKENS = 16;
/** 命名短名展示长度兜底：模型可能无视指令多吐，截断到可读长度 */
const NAMING_MAX_CHARS = 20;

/** 命名提示词：要求只输出简短中文短名，不带标点与解释 */
function buildNamingPrompt(rawPrompt: string): string {
	return (
		'下面是一段图片编辑指令，请用不超过 10 个汉字概括其编辑意图，作为任务短名。' +
		'只输出短名本身，不要标点、引号、解释或前后缀。\n\n指令：' +
		rawPrompt
	);
}

/** 清洗模型返回的短名：去首尾空白、去包裹引号、去换行、截断到展示上限 */
function cleanTitle(raw: string): string {
	const oneLine = raw.replace(/\s+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
	return oneLine.slice(0, NAMING_MAX_CHARS);
}

/**
 * 调 OpenAI 兼容对话接口给编辑任务起短名（非流式）。失败 / 超时 / 返回空一律返回 undefined，
 * 由调用方静默回退占位名——命名是锦上添花，绝不影响任务本身。
 */
export async function nameEditTask(config: ImageFlowConfig, rawPrompt: string): Promise<string | undefined> {
	try {
		const response = await fetchWithTimeout(`${config.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model: config.namingModel,
				stream: false,
				max_tokens: NAMING_MAX_TOKENS,
				messages: [{ role: 'user', content: buildNamingPrompt(rawPrompt) }],
			}),
		});
		if (!response.ok) {
			return undefined;
		}
		const data = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
		const content = data.choices?.[0]?.message?.content;
		if (typeof content !== 'string') {
			return undefined;
		}
		const title = cleanTitle(content);
		return title || undefined;
	} catch {
		return undefined;
	}
}

/** 异步查询结果：running 时图片未就绪，succeeded 时带 results */
export interface JobResult {
	status: 'running' | 'succeeded' | 'failed' | 'violation';
	urls: string[];
	error?: string;
	/** running 态的生成进度 0~100（远端返回，可能缺省） */
	progress?: number;
}

/**
 * gpt-image-2-vip 只接受像素值，这里按「比例 + 分辨率」换算。
 * 数值取自官方文档的 vip 比例参考表（1K / 2K / 4K）。
 */
const VIP_PIXEL_TABLE: Record<string, { '1K': string; '2K': string; '4K': string }> = {
	'1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
	'16:9': { '1K': '1280x720', '2K': '2048x1152', '4K': '3840x2160' },
	'9:16': { '1K': '720x1280', '2K': '1152x2048', '4K': '2160x3840' },
	'4:3': { '1K': '1152x864', '2K': '2304x1728', '4K': '3264x2448' },
	'3:4': { '1K': '864x1152', '2K': '1728x2304', '4K': '2448x3264' },
};

/** 把比例 + 分辨率换算成 gpt-image-2-vip 需要的像素值 */
export function toVipPixels(aspectRatio: string, imageSize: string): string {
	const size = (['1K', '2K', '4K'].includes(imageSize) ? imageSize : '1K') as '1K' | '2K' | '4K';
	const row = VIP_PIXEL_TABLE[aspectRatio] ?? VIP_PIXEL_TABLE['1:1'];
	return row[size];
}

/** 按模型系列拼 generate 请求体的尺寸字段 */
function applySizeFields(config: ImageFlowConfig, body: Record<string, unknown>): void {
	// - nano-banana 系列：比例 + imageSize
	// - gpt-image-2（非 vip）：支持比例，传比例、不带 imageSize
	// - gpt-image-2-vip：只认像素值，按比例 + 分辨率换算
	if (config.model === 'gpt-image-2-vip') {
		body.aspectRatio = toVipPixels(config.aspectRatio, config.imageSize);
	} else if (config.model === 'gpt-image-2') {
		body.aspectRatio = config.aspectRatio;
	} else {
		body.aspectRatio = config.aspectRatio;
		body.imageSize = config.imageSize;
	}
}

/**
 * 构造 generate 请求体：模型 + 提示词 + 参考图 + 按模型系列拼好的尺寸字段。
 * 抽出独立函数供「预览请求」复用，保证预览展示的参数与真实提交完全一致。
 */
export function buildRequestBody(
	config: ImageFlowConfig,
	prompt: string,
	images: string[] = []
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: config.model,
		prompt,
		images,
		replyType: 'async',
	};
	applySizeFields(config, body);
	return body;
}

/**
 * 异步提交一次生成（replyType: async）：接口立即返回 job id，不等图片生成完。
 * 后续凭 id 调 queryResult 轮询结果。
 * @param images 参考图列表，支持 base64（data URI）或 url 链接，按顺序对应模型感知的「第 N 张图」
 * @returns 远端任务 id
 */
export async function submitGeneration(
	config: ImageFlowConfig,
	prompt: string,
	images: string[] = []
): Promise<string> {
	const body = buildRequestBody(config, prompt, images);

	const response = await fetchWithTimeout(`${config.baseUrl}/v1/api/generate`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify(body),
	});

	const data = parseGenerateResponse(await response.json());

	if (!response.ok || data.status === 'failed' || data.status === 'violation') {
		throw new Error(data.error || `提交生成失败（status: ${data.status}）`);
	}
	if (!data.id) {
		throw new Error('接口未返回任务 id');
	}
	return data.id;
}

/**
 * 查询异步任务结果（GET /v1/api/result?id=）。
 * running 时 urls 为空；succeeded 时带图片 url 列表；failed/violation 带 error。
 * 注意：网络层错误（fetch 抛出）由调用方按「瞬时错误、下轮重试」处理，不在此吞掉。
 */
export async function queryResult(config: ImageFlowConfig, id: string): Promise<JobResult> {
	const url = `${config.baseUrl}/v1/api/result?id=${encodeURIComponent(id)}`;
	const response = await fetchWithTimeout(url, {
		headers: { Authorization: `Bearer ${config.apiKey}` },
	});
	// 上游网关 5xx / 限流 429 是可恢复的瞬时故障（常返回 HTML body），抛 TransientError 让轮询下轮重试，不判失败
	if (!response.ok && (response.status >= 500 || response.status === 429)) {
		throw new TransientError(`查询结果失败（HTTP ${response.status}）`);
	}
	const data = parseGenerateResponse(await response.json());

	if (data.status === 'failed' || data.status === 'violation') {
		return { status: data.status, urls: [], error: data.error || `生成失败（status: ${data.status}）` };
	}
	if (data.status === 'succeeded') {
		const urls = (data.results ?? []).map((r) => r.url).filter((u): u is string => typeof u === 'string' && !!u);
		if (!urls.length) {
			return { status: 'failed', urls: [], error: '接口未返回图片结果' };
		}
		return { status: 'succeeded', urls };
	}
	return { status: 'running', urls: [], progress: typeof data.progress === 'number' ? data.progress : undefined };
}
