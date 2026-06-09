import * as vscode from 'vscode';
import type { ImageFlowConfig, ConfigOptions } from './shared';

/** 各配置项的可选值，供侧栏下拉渲染与默认值回退 */
export const CONFIG_OPTIONS: ConfigOptions = {
	baseUrl: [
		{ value: 'https://grsai.dakka.com.cn', label: '国内节点' },
		{ value: 'https://grsaiapi.com', label: '全球节点' },
	],
	model: ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2', 'gpt-image-2-vip'],
	aspectRatio: ['1:1', '16:9', '9:16', '4:3', '3:4'],
	imageSize: ['1K', '2K', '4K'],
};

/** globalState 中存放非敏感配置的键；API Key 单独走 secrets */
const STATE_KEY = 'image-flow.config';
const SECRET_KEY = 'image-flow.apiKey';

/**
 * 模型 → 内置注入句的初始种子。
 * gpt-image 系列生成非真实图片易出噪点，预置抑噪句；nano-banana 系列不需要，不在表内即不种入。
 * 仅种入「配置里尚不存在」的模型键，用户改动（含清空为空串）后不再被覆盖。
 */
const MODEL_INJECTION_SEEDS: Record<string, string> = {
	'gpt-image-2': '整体画面弱化微小细节，避免过度刻画。',
	'gpt-image-2-vip': '整体画面弱化微小细节，避免过度刻画。',
};

/** globalState 里持久化的部分（不含 apiKey） */
type StoredConfig = Omit<ImageFlowConfig, 'apiKey'>;

const DEFAULTS: StoredConfig = {
	baseUrl: 'https://grsai.dakka.com.cn',
	model: 'nano-banana-2',
	aspectRatio: '3:4',
	imageSize: '1K',
	concurrency: 1,
	workbenchCols: 4,
	tasksCols: 2,
	modelInjections: {},
};

/** 读取完整配置：非敏感项来自 globalState，apiKey 来自加密的 secrets */
export async function readConfig(context: vscode.ExtensionContext): Promise<ImageFlowConfig> {
	const stored = context.globalState.get<Partial<StoredConfig>>(STATE_KEY, {});
	const apiKey = (await context.secrets.get(SECRET_KEY)) ?? '';
	return { ...DEFAULTS, ...stored, apiKey };
}

/** 写回配置：apiKey 存 secrets，其余存 globalState（按字段合并） */
export async function writeConfig(
	context: vscode.ExtensionContext,
	patch: Partial<ImageFlowConfig>
): Promise<void> {
	if (patch.apiKey !== undefined) {
		await context.secrets.store(SECRET_KEY, patch.apiKey);
	}
	const { apiKey: _omit, ...rest } = patch;
	if (Object.keys(rest).length) {
		const stored = context.globalState.get<Partial<StoredConfig>>(STATE_KEY, {});
		await context.globalState.update(STATE_KEY, { ...stored, ...rest });
	}
}

/**
 * 首次激活时把内置注入种子写入配置：仅补「配置中尚不存在」的模型键，
 * 已存在的（含用户清空后的空串）保持不动。让 gpt-image 等模型的默认抑噪句在输入框里可见可改。
 */
export async function seedModelInjections(context: vscode.ExtensionContext): Promise<void> {
	const stored = context.globalState.get<Partial<StoredConfig>>(STATE_KEY, {});
	const current = stored.modelInjections ?? {};
	const merged = { ...current };
	let changed = false;
	for (const [model, seed] of Object.entries(MODEL_INJECTION_SEEDS)) {
		if (!(model in merged)) {
			merged[model] = seed;
			changed = true;
		}
	}
	if (changed) {
		await context.globalState.update(STATE_KEY, { ...stored, modelInjections: merged });
	}
}

