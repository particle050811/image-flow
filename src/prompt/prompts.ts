import * as vscode from 'vscode';
import { promptsRoot } from '../storage/storage';
import { log } from '../util/log';
import type { PromptTemplate } from '../shared';

/**
 * 扫描 .image-flow/prompts/ 下的 .md 模板：文件名（去扩展名）为模板名，全文为内容。
 * 目录不存在 / 无工作区 / 单文件读取失败均静默跳过——模板是可选增强，不阻断编辑页。
 */
export async function listPromptTemplates(): Promise<PromptTemplate[]> {
	let dir: vscode.Uri;
	try {
		dir = promptsRoot();
	} catch {
		return [];
	}
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return [];
	}
	const templates: PromptTemplate[] = [];
	for (const [name, type] of entries.sort()) {
		if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.md')) {
			continue;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
			templates.push({ name: name.slice(0, -3), content: Buffer.from(bytes).toString('utf8') });
		} catch {
			// 单个模板读取失败不影响其余
		}
	}
	return templates;
}

/**
 * 按名读单个预设模板内容（.image-flow/prompts/<name>.md 全文，trim）。
 * 空名 / 文件不存在 / 读取失败 / 空内容均返回空串——工作台预设是可选前置，缺失不阻断生成。
 * 空名是「未选模板」属正常静默；非空名读不到说明用户选了模板但文件被删/读坏，
 * 生成会静默少掉模板段，记台账日志留痕，避免「为什么模板没生效」无从排查。
 */
export async function readTemplateContent(name: string): Promise<string> {
	if (!name) {
		return '';
	}
	try {
		const uri = vscode.Uri.joinPath(promptsRoot(), `${name}.md`);
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('utf8').trim();
	} catch (err) {
		log(`警告：预设模板「${name}」读取失败（.image-flow/prompts/${name}.md），本次生成不含该模板段：${err instanceof Error ? err.message : String(err)}`);
		return '';
	}
}
