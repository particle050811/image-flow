// grsai 异步图片生成协议：POST /v1/api/generate 拿 job id → 轮询 GET /v1/api/result。
// nano-banana / gpt-image-2 系列共用此协议。内置 grsai Provider 的图片模型即走这里。

import {
	fetchWithTimeout,
	readJsonLimited,
	parseGenerateResponse,
	toVipPixels,
	normalizeBase,
	TransientError,
	CONTROL_BODY_BYTES,
	CONTROL_BODY_TIMEOUT,
} from '../api';
import type { ImageFlowConfig } from '../../shared';
import type { ImageAdapter, CallContext, AdapterJobResult, ResultItem, SubmitAsync } from './types';

/**
 * 提交专用超时（ms）：提交要上传参考图的完整 base64，体量远大于查询/下载，
 * 给更长窗口避免大图上传被 30s 腰斩。
 */
const SUBMIT_TIMEOUT = 120000;

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
 * 导出供单测锁定参数拼装（与真实提交完全一致）。
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

/** grsai 异步协议 adapter */
export const grsaiAsync: ImageAdapter = {
	id: 'grsai-async',
	kind: 'async',
	supportsBatch: false,

	async submit(ctx: CallContext, prompt: string, refs: string[]): Promise<SubmitAsync> {
		const body = buildRequestBody(ctx.config, prompt, refs);
		const response = await fetchWithTimeout(
			`${normalizeBase(ctx.baseUrl)}/v1/api/generate`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${ctx.apiKey}`,
				},
				body: JSON.stringify(body),
			},
			SUBMIT_TIMEOUT
		);

		// 提交回执只有 job id 等 KB 级字段：按控制面小上限读，异常体不占大内存
		const data = parseGenerateResponse(
			await readJsonLimited(response, '提交响应', CONTROL_BODY_BYTES, CONTROL_BODY_TIMEOUT)
		);
		if (!response.ok || data.status === 'failed' || data.status === 'violation') {
			throw new Error(data.error || `提交生成失败（status: ${data.status}）`);
		}
		if (!data.id) {
			throw new Error('接口未返回任务 id');
		}
		return { jobId: data.id };
	},

	async poll(ctx: CallContext, jobId: string): Promise<AdapterJobResult> {
		const url = `${normalizeBase(ctx.baseUrl)}/v1/api/result?id=${encodeURIComponent(jobId)}`;
		const response = await fetchWithTimeout(url, {
			headers: { Authorization: `Bearer ${ctx.apiKey}` },
		});
		// 上游网关 5xx / 限流 429 是可恢复的瞬时故障（常返回 HTML body），抛 TransientError 让轮询下轮重试，不判失败
		if (!response.ok && (response.status >= 500 || response.status === 429)) {
			// 不读错误体就提前抛：先取消正文，别让异常上游占着 socket
			void response.body?.cancel().catch(() => {});
			throw new TransientError(`查询结果失败（HTTP ${response.status}）`);
		}
		// 查询结果只带状态与图片 url：按控制面小上限 + 短窗口读，异常体不把串行轮询卡两分钟
		const data = parseGenerateResponse(
			await readJsonLimited(response, '查询响应', CONTROL_BODY_BYTES, CONTROL_BODY_TIMEOUT)
		);

		if (data.status === 'failed' || data.status === 'violation') {
			return { status: data.status, results: [], error: data.error || `生成失败（status: ${data.status}）` };
		}
		if (data.status === 'succeeded') {
			const results: ResultItem[] = (data.results ?? [])
				.map((r) => r.url)
				.filter((u): u is string => typeof u === 'string' && !!u)
				.map((u) => ({ kind: 'url', url: u }));
			if (!results.length) {
				return { status: 'failed', results: [], error: '接口未返回图片结果' };
			}
			return { status: 'succeeded', results };
		}
		return {
			status: 'running',
			results: [],
			progress: typeof data.progress === 'number' ? data.progress : undefined,
		};
	},
};
