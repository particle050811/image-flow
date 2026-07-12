import { parseMediaDecls, buildNameTable, replaceMediaRefs } from './buildPrompt';
import { editConfigView } from '../ui/config';
import { joinPrompt, modelInjection } from './inject';
import { mediaDeclSnippet, namedRefSnippet } from '../refs';
import { mediaTypeOfFileName } from '../util/images';
import type { ImageFlowConfig } from '../shared';

/**
 * 编辑任务的最终提示词：把编辑区全部图拼成顶部 `![主名](文件名)` 声明（按编辑区顺序），
 * 正文即工作台 MD 格式，复用生成链路的 replaceMediaRefs——声明被删、命名引用 `[主名]`
 * 替换为 `【@图片N】`，编号按编辑区顺序。再前置编辑模型注入句（不拼工作台预设模板）。
 * 提交（tasks.submitEdit）与预览（sidebarProvider.doEditPreview）共用，保证不漂移。
 */
export function buildEditFinalPrompt(base: ImageFlowConfig, rawPrompt: string, names: string[]): string {
	// 本地后端只能生成图片：编辑区含音/视频就报错。提交与预览共用此函数，一处守两路。
	const nonImage = names.filter((n) => mediaTypeOfFileName(n) !== 'image');
	if (nonImage.length) {
		throw new Error(`本地后端不支持音视频生成，请从编辑区移除：${nonImage.join('、')}`);
	}
	const config = editConfigView(base);
	const content = prependDecls(rawPrompt, names);
	const parsed = parseMediaDecls(content);
	// 编辑区不校验声明是否都被引用（不拦截也不警告）：未被正文引用的图同样按声明顺序上传，只是正文里没有对应 【@图片N】 指向
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
	return prependDecls(rawPrompt, names, (_n, i) => `input/${fileNames[i]}`);
}

/**
 * 把编辑区图按序拼成顶部声明块 `![名](路径)` 前置到正文之上（无图则原样返回正文）。
 * pathOf 默认取文件名（提交/发送场景，路径即落盘名）；归档场景传 `(_, i) => input/${fileNames[i]}` 指向 input/。
 * 提交（buildEditFinalPrompt）与归档（buildEditArchivePrompt）共用此拼装，避免漂移。
 */
function prependDecls(rawPrompt: string, names: string[], pathOf: (name: string, i: number) => string = (n) => n): string {
	const decls = names.map((n, i) => mediaDeclSnippet(stemOf(n), pathOf(n, i))).join('\n');
	const body = rawPrompt.trim();
	return decls ? `${decls}\n${body}` : body;
}

/** 文件名去扩展主名，与 namedRefSnippet 内部一致——声明 alt 与命名引用必须同名才能对上 */
function stemOf(name: string): string {
	return namedRefSnippet(name).slice(1, -1);
}
