import { parseImageRefs, replaceImageRefs } from './command';

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
