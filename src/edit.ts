import { parseMediaDecls, buildNameTable, replaceMediaRefs, assertAllDeclsReferenced } from './command';
import { editConfigView } from './config';
import { joinPrompt, modelInjection } from './inject';
import { mediaDeclSnippet, namedRefSnippet } from './refs';
import type { ImageFlowConfig } from './shared';

/**
 * 编辑任务的最终提示词：把编辑区全部图拼成顶部 `![主名](文件名)` 声明（按编辑区顺序），
 * 正文即工作台 MD 格式，复用生成链路的 replaceMediaRefs——声明被删、命名引用 `[主名]`
 * 替换为 `【@图片N】`，编号按编辑区顺序。再前置编辑模型注入句（不拼工作台预设模板）。
 * 提交（tasks.submitEdit）与预览（sidebarProvider.doEditPreview）共用，保证不漂移。
 */
export function buildEditFinalPrompt(base: ImageFlowConfig, rawPrompt: string, names: string[]): string {
	const config = editConfigView(base);
	const decls = names.map((n) => mediaDeclSnippet(stemOf(n), n)).join('\n');
	const content = decls ? `${decls}\n${rawPrompt.trim()}` : rawPrompt.trim();
	const parsed = parseMediaDecls(content);
	assertAllDeclsReferenced(content, parsed);
	const replaced = replaceMediaRefs(content, buildNameTable(parsed));
	return joinPrompt([modelInjection(base, config.model), replaced]);
}

/**
 * 编辑任务的归档正文：在用户正文（含 `[名]` 命名引用）最前面前置编辑区全部图的声明
 * `![名](input/原名)`（按编辑区顺序），不拼注入句。归档即工作台 MD 格式，右键可直接重新生成——
 * 声明 alt = 命名引用主名，重生成时 `[名]` 替换为 `【@图片N】` 且参考图从 input/ 读回。
 * fileNames 为去重后的归档落盘名（与 archiveInputs 一致），与 names 一一对应。
 */
export function buildEditArchivePrompt(rawPrompt: string, names: string[], fileNames: string[]): string {
	const decls = names.map((n, i) => mediaDeclSnippet(stemOf(n), `input/${fileNames[i]}`)).join('\n');
	const body = rawPrompt.trim();
	return decls ? `${decls}\n${body}` : body;
}

/** 文件名去扩展主名，与 namedRefSnippet 内部一致——声明 alt 与命名引用必须同名才能对上 */
function stemOf(name: string): string {
	return namedRefSnippet(name).slice(1, -1);
}
