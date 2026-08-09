// 输出格式化与计时工具。
// list_model 默认只输出「当前选中 + 图片模型档位」的精简表格（AI 消费，省 token）；
// 传 --full 才展开完整原始 JSON（排查问题用）。--debug 在 stdout 末尾追加耗时行。

/**
 * 把 list_model 的原始响应折叠成精简文本。
 * @param {any} data list_model 原始响应（{ current, models: [...] }）
 * @returns {string} 精简文本
 */
export function formatListModelCompact(data) {
	if (!data || !Array.isArray(data.models)) {
		// 结构不符时不做精简，原样 JSON 兜底
		return JSON.stringify(data, null, 2);
	}
	const lines = [];
	// 当前选中（submit/edit 不带覆盖参数时生效的默认值）
	const cur = data.current ?? {};
	lines.push('【当前选中】' + (cur.model ? `${cur.model} (${cur.provider ?? ''}) ratio=${cur.ratio ?? '-'} resolution=${cur.resolution ?? '-'} generate_num=${cur.generate_num ?? '-'}` : '(无)'));
	// 图片模型（video=false）完整展示档位；先滤掉 null/非对象元素，避免访问属性抛错
	const images = data.models.filter((m) => m && typeof m === 'object' && !m.video);
	if (images.length) {
		lines.push('');
		lines.push('【图片模型】');
		for (const m of images) {
			lines.push(`- ${m.provider}:${m.model}${m.label ? ` (${m.label})` : ''}`);
			if (Array.isArray(m.aspectRatios)) {
				lines.push(`  ratio: ${m.aspectRatios.join(', ')}`);
			}
			if (Array.isArray(m.imageSizes)) {
				lines.push(`  resolution: ${m.imageSizes.join(', ')}`);
			}
		}
	}
	// 视频模型只列名字 + 说明（避免把 duration 档位、分辨率全量展开刷屏）
	const videos = data.models.filter((m) => m && typeof m === 'object' && m.video);
	if (videos.length) {
		lines.push('');
		lines.push('【视频模型】');
		for (const m of videos) {
			lines.push(`- ${m.provider}:${m.model}${m.label ? ` (${m.label})` : ''}（视频，只放行 v.md）`);
		}
		lines.push('  （视频模型完整档位不在此展开，需要时用 --full 查看）');
	}
	return lines.join('\n');
}

/**
 * 计时工具：start() 返回计时器，end() 返回「自 start 起的毫秒数」并追加 debug 行。
 * 注意：Node 里 Date.now() 可用（与 Workflow 沙箱不同），这里记录单调时钟。
 */
export function createTimer() {
	const start = Date.now();
	return {
		/** 输出 debug 耗时行到 stdout（格式：[debug] <秒>s，1 位小数；自带换行分隔，避免贴在上文末尾） */
		end(label = '') {
			const ms = Date.now() - start;
			process.stdout.write(`\n[debug] ${label ? label + ' ' : ''}${(ms / 1000).toFixed(1)}s\n`);
		},
	};
}
