import type { ImageFlowConfig } from './shared';
import { readTemplateContent } from './prompts';

/** 取某模型的注入句：直接读配置（内置默认已在首次激活时种入），无则空串 */
export function modelInjection(config: ImageFlowConfig, model: string): string {
	return (config.modelInjections?.[model] ?? '').trim();
}

/** 把多段文本中的非空段（trim 后）用空行连接 */
export function joinPrompt(parts: string[]): string {
	return parts.map((p) => p.trim()).filter((p) => p).join('\n\n');
}

/**
 * 组装最终 prompt：模型注入句 + 工作台预设模板 + 正文，顺序固定前置，空段省略。
 * 预设模板由 config.workbenchTemplate 指定，缺失/未选时为空段。
 * 注入文本不含图片语法，不影响 basePrompt 里 [imageN] 的编号。
 */
export async function buildInjectedPrompt(
	config: ImageFlowConfig,
	basePrompt: string
): Promise<string> {
	const injection = modelInjection(config, config.model);
	const preset = await readTemplateContent(config.workbenchTemplate);
	return joinPrompt([injection, preset, basePrompt]);
}
