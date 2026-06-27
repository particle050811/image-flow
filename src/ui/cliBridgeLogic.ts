import * as path from 'path';

// CLI 文件桥的纯逻辑（不依赖 vscode / fs）：单条引用的处理决定、相对路径换算、报告生成。
// 抽出供直测——cliBridge.ts 只保留与 vscode.workspace.fs 纠缠的编排（读盘/stat/回写）。

/** 单条引用的处理决定（候选用 fsPath 字符串表达，保持本模块 vscode-free） */
export type Decision =
	| { action: 'keep' }
	| { action: 'rewrite'; dest: string }
	| { action: 'notfound' }
	| { action: 'multi'; cands: string[] }
	| { action: 'crossdrive'; cand: string };

/** 相对引用串：算 md 目录到目标的相对路径，跨盘符无法相对引用时返回 null；含空格/半角括号用尖括号包裹 */
export function toRelDest(mdDir: string, absPath: string): string | null {
	let rel = path.relative(mdDir, absPath).split(path.sep).join('/');
	if (path.isAbsolute(rel)) {
		return null;
	}
	if (!rel.startsWith('.')) {
		rel = './' + rel;
	}
	return /[ ()]/.test(rel) ? `<${rel}>` : rel;
}

/**
 * 据「当前是否已能解析」与「同名候选（fsPath 列表）」定夺单条引用：
 * 已能解析→keep；无候选→notfound；多候选→multi；唯一候选可相对引用→rewrite，跨盘符→crossdrive。
 */
export function decideRef(exists: boolean, candidates: string[], mdDir: string): Decision {
	if (exists) {
		return { action: 'keep' };
	}
	if (candidates.length === 0) {
		return { action: 'notfound' };
	}
	if (candidates.length > 1) {
		return { action: 'multi', cands: candidates };
	}
	const dest = toRelDest(mdDir, candidates[0]);
	return dest === null ? { action: 'crossdrive', cand: candidates[0] } : { action: 'rewrite', dest };
}

/** 把逐条决定汇成 AI 可读的纯文本报告 */
export function buildFixReport(order: string[], decisions: Map<string, Decision>): string {
	const rewrites: string[] = [];
	const problems: string[] = [];
	let keeps = 0;
	for (const p of order) {
		const d = decisions.get(p);
		if (!d) {
			continue;
		}
		switch (d.action) {
			case 'keep':
				keeps += 1;
				break;
			case 'rewrite':
				rewrites.push(`  ${p} → ${d.dest}`);
				break;
			case 'notfound':
				problems.push(`  ✗ 未找到：${p}`);
				break;
			case 'multi':
				problems.push(`  ✗ 多个候选：${p}`, ...d.cands.map((c) => `      - ${c}`));
				break;
			case 'crossdrive':
				problems.push(`  ✗ 跨磁盘无法相对引用：${p} → ${d.cand}`);
				break;
		}
	}
	const out: string[] = [
		`共 ${order.length} 处引用：修正 ${rewrites.length}，已正确 ${keeps}，问题 ${problems.length}`,
	];
	if (rewrites.length) {
		out.push('', '修正：', ...rewrites);
	}
	if (problems.length) {
		out.push('', '问题：', ...problems);
	}
	return out.join('\n') + '\n';
}
