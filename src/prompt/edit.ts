import {
	parseMediaDecls,
	buildNameTable,
	replaceMediaRefs,
	assertAllDeclsReferenced,
	orderPrefixNames,
	dedupeArchiveNames,
} from './buildPrompt';
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

/** 编辑「构建并复制」的导出结果：发送正文 + 归档正文 + 有序落盘名（与编辑区图一一对应） */
export interface EditExportResult {
	/** 发送给外部后端的可复制正文：命名引用替换为 `【@图片N】`/`【@视频N】`，不含注入句/模板 */
	prompt: string;
	/** 归档正文（`![名](input/类型N-原名)`）：与生成/编辑任务一致，历史可渲染参考媒体 */
	archivePrompt: string;
	/** 参考媒体落盘名（类型序号前缀 + 重名去重），按编辑区顺序与图一一对应 */
	fileNames: string[];
}

/**
 * 编辑区「构建并复制」：把编辑区全部图（含音/视频）+ 用户正文导出，供粘贴到外部网页/APP 后端。
 * 不调用 API、不拼注入句。复用生成链路的声明解析/编号/替换，编号规则与生成一致；
 * 落盘名加「类型N-」前缀与发送正文的 `【@类型N】` 对齐，外部按文件名顺序上传不错位。
 * 与 buildEditFinalPrompt 的区别：不限图片（允许音视频）、不拼注入句、文件名带顺序前缀。
 */
export function buildEditExportPrompt(rawPrompt: string, names: string[]): EditExportResult {
	const decls = names.map((n) => mediaDeclSnippet(stemOf(n), n)).join('\n');
	const content = decls ? `${decls}\n${rawPrompt.trim()}` : rawPrompt.trim();
	const parsed = parseMediaDecls(content);
	const table = buildNameTable(parsed);
	assertAllDeclsReferenced(content, parsed);
	const prompt = replaceMediaRefs(content, table);
	const fileNames = dedupeArchiveNames(orderPrefixNames(names));
	const archivePrompt = buildEditArchivePrompt(rawPrompt, names, fileNames);
	return { prompt, archivePrompt, fileNames };
}

/** 文件名去扩展主名，与 namedRefSnippet 内部一致——声明 alt 与命名引用必须同名才能对上 */
function stemOf(name: string): string {
	return namedRefSnippet(name).slice(1, -1);
}
