// OpenAI 兼容图片生成协议（同步一次返回）。按是否带参考图分两个标准端点：
// - 纯文生图：POST /v1/images/generations（JSON）
// - 图生图（有参考图）：POST /v1/images/edits（multipart/form-data，参考图作文件上传）
// 仅发 model/prompt/size + 用户自定义参数——部分渠道（如云雾 new-api）严格拒未知参数，
// 故不带 response_format / moderation / image（空），否则报 "Unknown parameter"。
// 返回统一取 data[].url 或 data[].b64_json（gpt-image 系列恒返回 b64_json）。

import { fetchWithTimeout, readJsonLimited, resolveImageSize, normalizeBase } from '../api';
import { extFromMime } from '../../util/images';
import type { ImageFlowConfig } from '../../shared';
import { mergeCustomParams } from './types';
import type { ImageAdapter, CallContext, SubmitSync, ResultItem } from './types';

/**
 * 同步生成超时（ms）：openai-images 是同步协议，整张图在这一次请求里生成完才返回——
 * gpt-image-2 图生图实测可达 160s+，给 5 分钟窗口，避免还在生成就被腰斩判失败
 * （服务端仍会跑完并扣费）。注意：同步请求被超时/重载打断即无法续拉（无 job id），不同于 grsai 异步。
 */
const SUBMIT_TIMEOUT = 300000;

/** 拼请求体时跳过的保留字段：避免用户自定义参数覆盖/重复这些固定字段 */
const RESERVED_KEYS = new Set(['model', 'prompt', 'size', 'image']);

/** data URI → { mime, bytes }；非 data URI 原样当作 base64、mime 兜底 png */
function dataUriToBytes(uri: string): { mime: string; bytes: Uint8Array } {
	const m = /^data:([^;]+);base64,(.*)$/s.exec(uri);
	const mime = m ? m[1] : 'image/png';
	const b64 = m ? m[2] : uri;
	return { mime, bytes: new Uint8Array(Buffer.from(b64, 'base64')) };
}

/**
 * 构造 /v1/images/generations（文生图）JSON 请求体：只放 model/prompt/size + 自定义参数。
 * 绝不带 image / response_format / moderation——严格渠道会拒未知参数。导出供单测锁定。
 */
export function buildImagesBody(config: ImageFlowConfig, prompt: string): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	mergeCustomParams(body, config.params);
	// 固定字段最后写，始终覆盖同名自定义参数
	Object.assign(body, {
		model: config.model,
		prompt,
		size: resolveImageSize(config.aspectRatio, config.imageSize),
	});
	return body;
}

/** 把返回的 data[] 解析为落盘结果项：优先 url，其次 b64_json（按 png 落盘） */
function parseImagesData(data: unknown): ResultItem[] {
	if (!Array.isArray(data)) {
		return [];
	}
	const results: ResultItem[] = [];
	for (const item of data) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const url = (item as { url?: unknown }).url;
		const b64 = (item as { b64_json?: unknown }).b64_json;
		if (typeof url === 'string' && url) {
			results.push({ kind: 'url', url });
		} else if (typeof b64 === 'string' && b64) {
			results.push({ kind: 'base64', data: b64, mime: 'image/png' });
		}
	}
	return results;
}

/** openai 兼容图片生成 adapter（同步）：文生图走 generations，图生图走 edits */
export const openaiImages: ImageAdapter = {
	id: 'openai-images',
	kind: 'sync',
	supportsBatch: false,

	async submit(ctx: CallContext, prompt: string, refs: string[]): Promise<SubmitSync> {
		const base = normalizeBase(ctx.baseUrl);
		const size = resolveImageSize(ctx.config.aspectRatio, ctx.config.imageSize);
		let response: Response;

		if (refs.length > 0) {
			// 图生图：参考图作文件上传到 /v1/images/edits（multipart）。
			// 多张参考图用重复的 image 字段（new-api 等按重复同名字段收成数组）。
			const form = new FormData();
			form.append('model', ctx.config.model);
			form.append('prompt', prompt);
			if (size) {
				form.append('size', size);
			}
			for (const [key, value] of Object.entries(ctx.config.params)) {
				if (value !== undefined && value !== '' && !RESERVED_KEYS.has(key)) {
					form.append(key, value);
				}
			}
			refs.forEach((ref, i) => {
				const { mime, bytes } = dataUriToBytes(ref);
				form.append('image', new Blob([bytes], { type: mime }), `image_${i + 1}.${extFromMime(mime)}`);
			});
			// 不手动设 Content-Type，让 fetch 自动带上 multipart boundary
			response = await fetchWithTimeout(
				`${base}/v1/images/edits`,
				{ method: 'POST', headers: { Authorization: `Bearer ${ctx.apiKey}` }, body: form },
				SUBMIT_TIMEOUT
			);
		} else {
			// 纯文生图：/v1/images/generations（JSON）
			response = await fetchWithTimeout(
				`${base}/v1/images/generations`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
					body: JSON.stringify(buildImagesBody(ctx.config, prompt)),
				},
				SUBMIT_TIMEOUT
			);
		}

		const data = (await readJsonLimited(response, '图片生成响应')) as {
			data?: unknown;
			error?: { message?: unknown };
		};
		if (!response.ok) {
			const msg = typeof data.error?.message === 'string' ? data.error.message : `HTTP ${response.status}`;
			throw new Error(`图片生成失败：${msg}`);
		}
		const results = parseImagesData(data.data);
		if (!results.length) {
			throw new Error('接口未返回图片结果');
		}
		return { results };
	},
};
