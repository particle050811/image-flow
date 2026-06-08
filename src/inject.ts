import * as vscode from 'vscode';
import type { ImageFlowConfig } from './shared';

/** 取某模型的注入句：直接读配置（内置默认已在首次激活时种入），无则空串 */
export function modelInjection(config: ImageFlowConfig, model: string): string {
	return (config.modelInjections?.[model] ?? '').trim();
}

/** 把多段文本中的非空段（trim 后）用空行连接 */
export function joinPrompt(parts: string[]): string {
	return parts.map((p) => p.trim()).filter((p) => p).join('\n\n');
}

/** 读工作区根的 IMAGES.md 全文；找不到 / 空 / 无工作区 → 空串（注入可选，不阻断生成） */
async function readImagesMd(): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		return '';
	}
	try {
		const uri = vscode.Uri.joinPath(root.uri, 'IMAGES.md');
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('utf8').trim();
	} catch {
		return '';
	}
}

/**
 * 组装最终 prompt：模型注入句 + IMAGES.md + 正文，顺序固定前置，空段省略。
 * 注入文本不含图片语法，不影响 basePrompt 里 [imageN] 的编号。
 */
export async function buildInjectedPrompt(
	config: ImageFlowConfig,
	basePrompt: string
): Promise<string> {
	const injection = modelInjection(config, config.model);
	const imagesMd = await readImagesMd();
	return joinPrompt([injection, imagesMd, basePrompt]);
}
