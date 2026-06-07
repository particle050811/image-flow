import type { ImageFlowConfig } from './shared';

/** nano-banana generate 接口返回结构（json 模式） */
interface GenerateResponse {
	id: string;
	status: 'running' | 'violation' | 'succeeded' | 'failed';
	results?: { url: string }[];
	progress?: number;
	error?: string;
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
function toVipPixels(aspectRatio: string, imageSize: string): string {
	const size = (imageSize in { '1K': 0, '2K': 0, '4K': 0 } ? imageSize : '1K') as '1K' | '2K' | '4K';
	const row = VIP_PIXEL_TABLE[aspectRatio] ?? VIP_PIXEL_TABLE['1:1'];
	return row[size];
}


/**
 * 调用 generate 接口（nano-banana 与 gpt-image-2 系列共用 /v1/api/generate），
 * 返回生成图片的 URL 列表。
 * @param images 参考图列表，支持 base64（data URI）或 url 链接，按顺序对应模型感知的「第 N 张图」
 */
export async function generateImage(
	config: ImageFlowConfig,
	prompt: string,
	images: string[] = []
): Promise<string[]> {
	// 按模型系列拼请求体：
	// - nano-banana 系列：比例 + imageSize
	// - gpt-image-2（非 vip）：支持比例，传比例、不带 imageSize
	// - gpt-image-2-vip：只认像素值，按比例 + 分辨率换算
	const body: Record<string, unknown> = {
		model: config.model,
		prompt,
		images,
		replyType: 'json',
	};
	if (config.model === 'gpt-image-2-vip') {
		body.aspectRatio = toVipPixels(config.aspectRatio, config.imageSize);
	} else if (config.model === 'gpt-image-2') {
		body.aspectRatio = config.aspectRatio;
	} else {
		body.aspectRatio = config.aspectRatio;
		body.imageSize = config.imageSize;
	}

	const response = await fetch(`${config.baseUrl}/v1/api/generate`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify(body),
	});

	const data = (await response.json()) as GenerateResponse;

	if (!response.ok || data.status === 'failed' || data.status === 'violation') {
		throw new Error(data.error || `生成失败（status: ${data.status}）`);
	}
	if (data.status !== 'succeeded' || !data.results?.length) {
		throw new Error('接口未返回图片结果');
	}

	return data.results.map((r) => r.url);
}
