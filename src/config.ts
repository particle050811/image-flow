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

/** globalState 里持久化的部分（不含 apiKey） */
type StoredConfig = Omit<ImageFlowConfig, 'apiKey'>;

const DEFAULTS: StoredConfig = {
	baseUrl: 'https://grsai.dakka.com.cn',
	model: 'nano-banana-2',
	aspectRatio: '3:4',
	imageSize: '1K',
	concurrency: 1,
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

const MIGRATED_KEY = 'image-flow.migratedLegacySettings';

/**
 * 一次性迁移：把旧版本写在 settings.json 里的 image-flow.* 配置导入到 globalState/secrets。
 * 旧配置项已从 package.json 移除，这里用 inspect 直接读用户/工作区设置值，迁移后打标记不再执行。
 */
export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(MIGRATED_KEY)) {
		return;
	}
	const legacy = vscode.workspace.getConfiguration('image-flow');
	const read = <T>(key: string): T | undefined => {
		const v = legacy.inspect<T>(key);
		return v?.workspaceValue ?? v?.globalValue;
	};

	const patch: Partial<ImageFlowConfig> = {};
	for (const key of ['baseUrl', 'model', 'aspectRatio', 'imageSize'] as const) {
		const v = read<string>(key);
		if (v !== undefined) {
			patch[key] = v;
		}
	}
	const concurrency = read<number>('concurrency');
	if (concurrency !== undefined) {
		patch.concurrency = concurrency;
	}
	const apiKey = read<string>('apiKey');
	if (apiKey) {
		patch.apiKey = apiKey;
	}

	if (Object.keys(patch).length) {
		await writeConfig(context, patch);
	}
	await context.globalState.update(MIGRATED_KEY, true);
}
