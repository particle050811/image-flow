import { archiveImageRefs, parseImageRefs, replaceImageRefs } from './command';
import { editConfigView } from './config';
import { joinPrompt, modelInjection } from './inject';
import type { ImageFlowConfig } from './shared';

/**
 * 编辑提示词的引用替换：`![](文件名)` → `[imageN](文件名去扩展)`。
 * 序号按编辑区图片顺序（names 的下标 + 1），与文本出现顺序无关——
 * 参考图按编辑区顺序整体发送，删图/调序后无需改写提示词文本。
 * 引用了编辑区不存在的名字则报错中止（通常是图已删除）。
 */
export function buildEditPrompt(content: string, names: string[]): string {
	const { order } = parseImageRefs(content);
	const known = new Set(names);
	const unknown = order.filter((n) => !known.has(n));
	if (unknown.length) {
		throw new Error(`提示词引用了不存在的图片：${unknown.join('、')}`);
	}
	const indexByName = new Map(names.map((n, i) => [n, i + 1] as const));
	return replaceImageRefs(content, indexByName);
}

/**
 * 编辑任务的最终提示词：引用替换 + 编辑模型注入句（不拼 IMAGES.md——编辑场景与图册说明无关）。
 * 提交（tasks.submitEdit）与预览（sidebarProvider.doEditPreview）共用，保证预览与实际提交永不漂移。
 */
export function buildEditFinalPrompt(base: ImageFlowConfig, rawPrompt: string, names: string[]): string {
	const config = editConfigView(base);
	return joinPrompt([modelInjection(base, config.model), buildEditPrompt(rawPrompt.trim(), names)]);
}

/**
 * 编辑任务的归档正文：把 `![](文件名)` 改写为指向任务 input/ 归档图的 `![](input/原名)`，
 * 不拼注入句——归档为可直接重新生成的正文。序号同 buildEditPrompt（按编辑区 names 顺序），
 * fileNames 为去重后的归档落盘名（与 archiveInputs 一致），引用才能对上。
 */
export function buildEditArchivePrompt(rawPrompt: string, names: string[], fileNames: string[]): string {
	const indexByName = new Map(names.map((n, i) => [n, i + 1] as const));
	return archiveImageRefs(rawPrompt.trim(), indexByName, fileNames);
}
