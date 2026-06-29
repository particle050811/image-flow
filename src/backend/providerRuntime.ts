// 运行时解析层：把「当前配置」解析成「该用哪个 adapter + 什么 baseUrl/apiKey/模型」，
// 并管理自定义 Provider（~/.image-flow/settings.json）的加载缓存与脚手架落盘。
// settings.json 激活时读一次并缓存（改后重载窗口生效，无 file watch）；切到自定义/打开配置时重读一次。

import * as vscode from 'vscode';
import type { ImageFlowConfig, ConfigOptions } from '../shared';
import { getImageAdapter, getChatAdapter } from './adapters';
import type { ImageAdapter, ChatAdapter, CallContext, ChatContext } from './adapters';
import {
	BUILTIN_GRSAI,
	GRSAI_PROVIDER_ID,
	CUSTOM_PROVIDER_ID,
	parseCustomProvider,
	parseJsonc,
	buildOptions,
} from './providers';
import type { RuntimeProvider } from './providers';
import { settingsFile } from '../storage/storage';

/** 自定义 Provider 缓存：激活时由 reloadCustomProvider 填充；文件缺失/解析失败为 undefined */
let cachedCustom: RuntimeProvider | undefined;

/**
 * 读 settings.json → 自定义 Provider 缓存。激活时调一次；切到自定义/打开配置后重读。
 * 文件缺失或 JSON 解析失败 → 缓存置 undefined（自定义 Provider 视为不可用，回落内置 grsai）。
 */
export async function reloadCustomProvider(): Promise<void> {
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(settingsFile());
	} catch {
		// 文件缺失属正常（尚未配置自定义），静默置空、回落内置 grsai，不打扰
		cachedCustom = undefined;
		return;
	}
	try {
		// settings.json 是 JSONC（可含注释/尾逗号），用 jsonc-parser 解析
		cachedCustom = parseCustomProvider(parseJsonc(Buffer.from(bytes).toString('utf8')));
	} catch {
		// 文件存在但写坏（非法 JSONC）：显式提示，否则会静默以 grsai 模型冒充「自定义」，配置被吞掉无感知
		cachedCustom = undefined;
		void vscode.window.showErrorMessage(
			'Image Flow：settings.json 解析失败（非法 JSONC），已临时回落内置 grsai。请修正后重载窗口生效。'
		);
	}
}

/** 缺 settings.json 则从扩展内置模板（media/settings.template.jsonc）复制一份（不覆盖已存在），返回文件 Uri */
export async function ensureSettingsFile(extensionUri: vscode.Uri): Promise<vscode.Uri> {
	const uri = settingsFile();
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		const template = await vscode.workspace.fs.readFile(
			vscode.Uri.joinPath(extensionUri, 'media', 'settings.template.jsonc')
		);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, template);
	}
	return uri;
}

/** 当前生效 Provider：providerId=custom 且已加载到自定义 → 自定义；否则内置 grsai */
export function currentProvider(config: ImageFlowConfig): RuntimeProvider {
	if (config.providerId === CUSTOM_PROVIDER_ID && cachedCustom) {
		return cachedCustom;
	}
	return BUILTIN_GRSAI;
}

/** 由当前 Provider 构建发往 webview 的 ConfigOptions（不含 url/key） */
export function configOptions(config: ImageFlowConfig): ConfigOptions {
	return buildOptions(currentProvider(config));
}

/** 一次图片调用的落点：用哪个 adapter + 调用上下文（地址/密钥/配置） */
export interface ImageCall {
	adapter: ImageAdapter;
	ctx: CallContext;
}

/**
 * 解析图片生成调用：在当前 Provider 内按 config.model 找模型（找不到回落首个），
 * 取该模型的 adapter，url/key 优先用模型自带（自定义），缺省回落 config（内置 grsai 走 secrets）。
 */
export function resolveImageCall(config: ImageFlowConfig): ImageCall {
	const provider = currentProvider(config);
	const m = provider.image.find((x) => x.model === config.model) ?? provider.image[0];
	if (!m) {
		throw new Error('当前 API 没有可用的图片模型，请检查 settings.json 配置。');
	}
	// 自定义模型必须自带 apiKey：缺则报错，绝不回落 config.apiKey（那是 grsai 的 secret，
	// 否则会把 grsai 密钥静默发往该模型的第三方 baseUrl）。内置 grsai 模型不带 key，按设计回落 config。
	if (provider.id !== GRSAI_PROVIDER_ID && !m.apiKey) {
		throw new Error(`自定义模型「${m.model}」未配置 apiKey，请在 settings.json 中填写后重载窗口。`);
	}
	return {
		adapter: getImageAdapter(m.adapter),
		ctx: { baseUrl: m.baseUrl ?? config.baseUrl, apiKey: m.apiKey ?? config.apiKey, config },
	};
}

/** 一次对话调用的落点：adapter + 上下文 + 模型名 */
export interface ChatCall {
	adapter: ChatAdapter;
	ctx: ChatContext;
	model: string;
}

/**
 * 解析对话调用（AI 命名用）：当前 Provider 内按 config.namingModel 找（找不到回落首个）。
 * Provider 无对话模型 → 返回 undefined，由调用方静默跳过命名（chat[] 可选，缺则不自动命名）。
 */
export function resolveChatCall(config: ImageFlowConfig): ChatCall | undefined {
	const provider = currentProvider(config);
	const c = provider.chat.find((x) => x.model === config.namingModel) ?? provider.chat[0];
	if (!c) {
		return undefined;
	}
	// 自定义 chat 模型缺 key：跳过命名（命名是锦上添花），不回落 grsai 密钥发往第三方域名
	if (provider.id !== GRSAI_PROVIDER_ID && !c.apiKey) {
		return undefined;
	}
	return {
		adapter: getChatAdapter(c.adapter),
		ctx: { baseUrl: c.baseUrl ?? config.baseUrl, apiKey: c.apiKey ?? config.apiKey },
		model: c.model,
	};
}

/** 命名输出上限：短名不需要长文，用 max_tokens 硬卡，避免模型啰嗦。
 *  中文每字常占 1~3 token，留 32 以免 10 字短名被提前截断 */
const NAMING_MAX_TOKENS = 32;
/** 命名短名展示长度兜底：模型可能无视指令多吐，截断到可读长度 */
const NAMING_MAX_CHARS = 20;

/** 命名指令（system 角色）：通用于生成与编辑两类任务，只输出简短中文短名 */
const NAMING_SYSTEM =
	'你是 AI 绘图任务的命名助手。把用户给出的绘图 / 编辑提示词概括成不超过 10 个汉字的中文短名，' +
	'体现画面主题或编辑意图。只输出短名本身，不要引号、标点、解释或前后缀。';

/** 清洗模型返回的短名：去首尾空白、去包裹引号、去换行、截断到展示上限 */
function cleanTitle(raw: string): string {
	const oneLine = raw.replace(/\s+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
	return oneLine.slice(0, NAMING_MAX_CHARS);
}

/** 命名重试次数：命名模型偶发失败（adapter 失败即返回 undefined），多试几次提高成功率 */
const NAMING_MAX_ATTEMPTS = 3;
/** 命名失败后重试前的暂停（毫秒）：给瞬时限流 / 抖动留恢复时间 */
const NAMING_RETRY_DELAY_MS = 20_000;

/**
 * 调对话 adapter 给任务起短名（生成与编辑通用）。无对话模型直接返回 undefined；
 * 失败 / 超时 / 返回空最多重试 NAMING_MAX_ATTEMPTS 次，仍拿不到则返回 undefined，
 * 由调用方静默回退占位名——命名是锦上添花，绝不影响任务本身。
 */
export async function requestTaskName(config: ImageFlowConfig, rawPrompt: string): Promise<string | undefined> {
	const call = resolveChatCall(config);
	if (!call) {
		return undefined;
	}
	for (let attempt = 0; attempt < NAMING_MAX_ATTEMPTS; attempt++) {
		const content = await call.adapter.chat(
			call.ctx,
			call.model,
			[
				{ role: 'system', content: NAMING_SYSTEM },
				{ role: 'user', content: rawPrompt },
			],
			NAMING_MAX_TOKENS
		);
		if (typeof content === 'string') {
			const title = cleanTitle(content);
			if (title) {
				return title;
			}
		}
		// 非末次失败才暂停后重试；末次不等待，直接退出回退占位名
		if (attempt < NAMING_MAX_ATTEMPTS - 1) {
			await new Promise((resolve) => setTimeout(resolve, NAMING_RETRY_DELAY_MS));
		}
	}
	return undefined;
}
