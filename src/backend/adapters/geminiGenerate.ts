// Google Gemini 原生图片生成协议（同步一次返回）：POST /v1beta/models/<model>:generateContent。
// 参考图以 inline_data（base64）放进 contents[].parts；结果取 candidates[]...inlineData.data（base64），直接落盘。
// 鉴权用 Bearer：本 adapter 只面向「说原生 :generateContent 协议」的渠道（如转发原生协议的聚合代理）。
// OpenAI 兼容的 gemini 代理（说 /v1/images 或 /v1/chat 那套）请改用 openai-images / openai-chat adapter；
// 谷歌原生端点（generativelanguage.googleapis.com，用 ?key=/x-goog-api-key）暂不在支持范围。

import { fetchWithTimeout, normalizeBase } from '../api';
import { mergeCustomParams } from './types';
import type { ImageFlowConfig } from '../../shared';
import type { ImageAdapter, CallContext, SubmitSync, ResultItem } from './types';

/**
 * 同步生成超时（ms）：gemini-generate 是同步协议，整张图在这一次请求里生成完才返回，
 * 给 5 分钟窗口避免慢生成被腰斩判失败。同步请求被超时/重载打断即无法续拉（无 job id）。
 */
const SUBMIT_TIMEOUT = 300000;

/** 解析 data URI → { mime, data(裸 base64) }；非 data URI 原样当作 base64、mime 兜底 png */
function splitDataUri(uri: string): { mime: string; data: string } {
	const m = /^data:([^;]+);base64,(.*)$/s.exec(uri);
	return m ? { mime: m[1], data: m[2] } : { mime: 'image/png', data: uri };
}

/** 构造 generateContent 请求体：文本 + 参考图 inline_data。导出供单测锁定参数拼装。 */
export function buildGenerateContentBody(
	config: ImageFlowConfig,
	prompt: string,
	refs: string[]
): Record<string, unknown> {
	const parts: unknown[] = [{ text: prompt }];
	for (const ref of refs) {
		const { mime, data } = splitDataUri(ref);
		parts.push({ inline_data: { mime_type: mime, data } });
	}
	// 先并入 custom 参数，再写 contents——固定字段始终覆盖同名 custom，不可被改写
	const body: Record<string, unknown> = {};
	mergeCustomParams(body, config.params);
	Object.assign(body, { contents: [{ parts }] });
	return body;
}

/** 从 candidates 取出所有内联图片（base64）。兼容响应 camelCase（inlineData/mimeType） */
function parseCandidates(candidates: unknown): ResultItem[] {
	if (!Array.isArray(candidates)) {
		return [];
	}
	const results: ResultItem[] = [];
	for (const cand of candidates) {
		const parts = (cand as { content?: { parts?: unknown } })?.content?.parts;
		if (!Array.isArray(parts)) {
			continue;
		}
		for (const part of parts) {
			const inline =
				(part as { inlineData?: unknown; inline_data?: unknown })?.inlineData ??
				(part as { inline_data?: unknown })?.inline_data;
			const data = (inline as { data?: unknown })?.data;
			if (typeof data === 'string' && data) {
				const mime = (inline as { mimeType?: unknown; mime_type?: unknown }).mimeType
					?? (inline as { mime_type?: unknown }).mime_type;
				results.push({ kind: 'base64', data, mime: typeof mime === 'string' ? mime : 'image/png' });
			}
		}
	}
	return results;
}

/** Gemini 原生图片生成 adapter（同步） */
export const geminiGenerate: ImageAdapter = {
	id: 'gemini-generate',
	kind: 'sync',
	supportsBatch: false,

	async submit(ctx: CallContext, prompt: string, refs: string[]): Promise<SubmitSync> {
		const url = `${normalizeBase(ctx.baseUrl)}/v1beta/models/${encodeURIComponent(ctx.config.model)}:generateContent`;
		const response = await fetchWithTimeout(
			url,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${ctx.apiKey}`,
				},
				body: JSON.stringify(buildGenerateContentBody(ctx.config, prompt, refs)),
			},
			SUBMIT_TIMEOUT
		);

		const data = (await response.json()) as {
			candidates?: unknown;
			error?: { message?: unknown };
		};
		if (!response.ok) {
			const msg = typeof data.error?.message === 'string' ? data.error.message : `HTTP ${response.status}`;
			throw new Error(`图片生成失败：${msg}`);
		}
		const results = parseCandidates(data.candidates);
		if (!results.length) {
			throw new Error('接口未返回图片结果');
		}
		return { results };
	},
};
