// Provider 数据模型（纯逻辑，禁止引入 vscode/node/fs/DOM——前后端可共用）：
// 内置 grsai Provider、settings.json → 自定义 Provider 的解析、发往 webview 的 ConfigOptions 构建、
// 自定义参数默认值播种、切 Provider/模型时的模型对齐、缺文件时的脚手架内容。
// 真正的文件 IO（读/写 settings.json）在 providerRuntime.ts（node 侧）。

import { parse as jsoncParse, type ParseError } from 'jsonc-parser';
import type { ConfigOptions, CustomParam } from '../shared';

export const GRSAI_PROVIDER_ID = 'grsai';
export const CUSTOM_PROVIDER_ID = 'custom';
const GRSAI_LABEL = 'Grsai';
const CUSTOM_LABEL = '自定义';

/** 运行时图片模型（含 baseUrl/apiKey，仅后端持有，绝不下发 webview） */
export interface RuntimeImageModel {
	model: string;
	label: string;
	adapter: string;
	/** 该模型的 api 地址；内置 grsai 缺省 → 调用方回落 config.baseUrl */
	baseUrl?: string;
	/** 该模型的密钥；内置 grsai 缺省 → 调用方回落 config.apiKey（secrets） */
	apiKey?: string;
	aspectRatios: string[];
	imageSizes: string[];
	custom: CustomParam[];
}

/** 运行时对话模型（AI 命名用） */
export interface RuntimeChatModel {
	model: string;
	label: string;
	adapter: string;
	baseUrl?: string;
	apiKey?: string;
}

/** 运行时 Provider：一批图片模型 + 一批对话模型 */
export interface RuntimeProvider {
	id: string;
	label: string;
	image: RuntimeImageModel[];
	chat: RuntimeChatModel[];
}

// —— 内置 grsai —— //
const GRSAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const GRSAI_SIZES_FULL = ['1K', '2K', '4K'];
/** AI 命名可选的对话模型（内置 grsai） */
const GRSAI_CHAT_MODELS = [
	'gemini-3.5-flash',
	'gemini-3.1-flash-lite',
	'gemini-3-flash',
	'gemini-2.5-flash',
	'gemini-3.1-pro',
	'gemini-3-pro',
	'gemini-2.5-pro',
	'gpt-5.5',
	'gpt-5.4',
];

function grsaiImage(model: string, label: string, imageSizes: string[]): RuntimeImageModel {
	return { model, label, adapter: 'grsai-async', aspectRatios: GRSAI_ASPECT_RATIOS, imageSizes, custom: [] };
}

/** 内置 grsai Provider：模型固定、baseUrl/apiKey 走 config/secrets（此处不带） */
export const BUILTIN_GRSAI: RuntimeProvider = {
	id: GRSAI_PROVIDER_ID,
	label: GRSAI_LABEL,
	image: [
		// gpt-image-2（非 vip）仅 1K；其余支持全集
		grsaiImage('nano-banana-2', 'Nano Banana 2', GRSAI_SIZES_FULL),
		grsaiImage('nano-banana-pro', 'Nano Banana Pro', GRSAI_SIZES_FULL),
		grsaiImage('gpt-image-2', 'GPT Image 2', ['1K']),
		grsaiImage('gpt-image-2-vip', 'GPT Image 2 VIP', GRSAI_SIZES_FULL),
	],
	chat: GRSAI_CHAT_MODELS.map((m) => ({ model: m, label: m, adapter: 'openai-chat' })),
};

// —— settings.json 解析 —— //

/** 取字符串字段，非字符串返回兜底 */
function str(obj: Record<string, unknown>, key: string, fallback = ''): string {
	const v = obj[key];
	return typeof v === 'string' ? v : fallback;
}

/** 取字符串数组字段（过滤非字符串项），缺省空数组 */
function strArray(obj: Record<string, unknown>, key: string): string[] {
	const v = obj[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 解析一个 custom 参数项；缺 key/default 则视为无效返回 null */
function parseCustomParam(raw: unknown): CustomParam | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const obj = raw as Record<string, unknown>;
	const key = str(obj, 'key');
	if (!key) {
		return null;
	}
	const options = strArray(obj, 'options');
	return {
		key,
		label: str(obj, 'label', key),
		options,
		default: str(obj, 'default', options[0] ?? ''),
	};
}

/** 解析图片模型数组；跳过缺 model/adapter 的无效项 */
function parseImageModels(raw: unknown): RuntimeImageModel[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const models: RuntimeImageModel[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const obj = item as Record<string, unknown>;
		const model = str(obj, 'model');
		const adapter = str(obj, 'adapter');
		if (!model || !adapter) {
			continue;
		}
		const custom = Array.isArray(obj.custom)
			? obj.custom.map(parseCustomParam).filter((c): c is CustomParam => c !== null)
			: [];
		models.push({
			model,
			label: str(obj, 'label', model),
			adapter,
			baseUrl: str(obj, 'baseUrl') || undefined,
			apiKey: str(obj, 'apiKey') || undefined,
			aspectRatios: strArray(obj, 'aspectRatios'),
			imageSizes: strArray(obj, 'imageSizes'),
			custom,
		});
	}
	return models;
}

/** 解析对话模型数组；跳过缺 model 的无效项（adapter 缺省即 openai-chat） */
function parseChatModels(raw: unknown): RuntimeChatModel[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const models: RuntimeChatModel[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const obj = item as Record<string, unknown>;
		const model = str(obj, 'model');
		if (!model) {
			continue;
		}
		models.push({
			model,
			label: str(obj, 'label', model),
			adapter: str(obj, 'adapter', 'openai-chat'),
			baseUrl: str(obj, 'baseUrl') || undefined,
			apiKey: str(obj, 'apiKey') || undefined,
		});
	}
	return models;
}

/** 把 settings.json 顶层对象解析为自定义 Provider（容错：非对象/缺字段不抛错，给空列表） */
export function parseCustomProvider(raw: unknown): RuntimeProvider {
	const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return {
		id: CUSTOM_PROVIDER_ID,
		label: CUSTOM_LABEL,
		image: parseImageModels(obj.image),
		chat: parseChatModels(obj.chat),
	};
}

// —— 发往 webview 的 ConfigOptions（剥掉 baseUrl/apiKey） —— //

/** 合并全部可用渠道的图片模型，构建 ConfigOptions（只含展示/下拉所需，绝不含 url/key） */
export function buildOptions(providers: readonly RuntimeProvider[]): ConfigOptions {
	return {
		imageModels: providers.flatMap((p) =>
			p.image.map((m) => ({
				provider: p.id,
				providerLabel: p.label,
				model: m.model,
				label: m.label,
				aspectRatios: m.aspectRatios,
				imageSizes: m.imageSizes,
				custom: m.custom,
			}))
		),
	};
}

/** 某模型的可见参数默认值（切模型时播种进 config.params） */
export function paramDefaults(custom: readonly CustomParam[]): Record<string, string> {
	return Object.fromEntries(custom.map((c) => [c.key, c.default]));
}

/**
 * 解析 JSONC（可含 // 与 /* *​/ 注释、尾逗号）的 settings.json。
 * 用 VS Code 同款的 jsonc-parser，与宿主对 settings.json 的解析行为一致。
 * jsonc-parser 自身遇错不抛、尽量恢复；这里收集错误并显式抛出，
 * 让调用方（reloadCustomProvider 的 catch）在配置写坏时回落内置 grsai，而非产出空的自定义 Provider。
 */
export function parseJsonc(text: string): unknown {
	const errors: ParseError[] = [];
	const result = jsoncParse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		throw new Error('settings.json 不是合法的 JSONC');
	}
	return result;
}
