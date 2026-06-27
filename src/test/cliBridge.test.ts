import * as assert from 'assert';
import * as path from 'path';
import { toRelDest, decideRef, buildFixReport, type Decision } from '../ui/cliBridgeLogic';

// 跨盘符（C: vs D:）只有 win32 的 path.relative 才会退回绝对路径，非 Windows 跳过该断言
const isWin = process.platform === 'win32';

suite('cliBridgeLogic.toRelDest', () => {
	const md = path.resolve('proj', 'docs');
	test('同目录 → ./文件名', () => {
		assert.strictEqual(toRelDest(md, path.join(md, 'x.png')), './x.png');
	});
	test('子目录 → ./sub/文件名（统一正斜杠）', () => {
		assert.strictEqual(toRelDest(md, path.join(md, 'img', 'x.png')), './img/x.png');
	});
	test('上级目录 → ../文件名', () => {
		assert.strictEqual(toRelDest(md, path.join(path.resolve('proj'), 'x.png')), '../x.png');
	});
	test('含空格/半角括号 → 尖括号包裹', () => {
		assert.strictEqual(toRelDest(md, path.join(md, 'a b (1).png')), '<./a b (1).png>');
	});
	if (isWin) {
		test('跨盘符无法相对引用 → null', () => {
			assert.strictEqual(toRelDest('C:\\proj', 'D:\\img\\x.png'), null);
		});
	}
});

suite('cliBridgeLogic.decideRef', () => {
	const md = path.resolve('proj');
	test('已能解析 → keep（不看候选）', () => {
		assert.deepStrictEqual(decideRef(true, [path.join(md, 'x.png')], md), { action: 'keep' });
	});
	test('无候选 → notfound', () => {
		assert.deepStrictEqual(decideRef(false, [], md), { action: 'notfound' });
	});
	test('多候选 → multi（原样带回候选 fsPath）', () => {
		const cands = [path.join(md, 'a', 'x.png'), path.join(md, 'b', 'x.png')];
		assert.deepStrictEqual(decideRef(false, cands, md), { action: 'multi', cands });
	});
	test('唯一候选可相对引用 → rewrite', () => {
		assert.deepStrictEqual(decideRef(false, [path.join(md, 'img', 'x.png')], md), {
			action: 'rewrite',
			dest: './img/x.png',
		});
	});
	if (isWin) {
		test('唯一候选跨盘符 → crossdrive', () => {
			assert.deepStrictEqual(decideRef(false, ['D:\\img\\x.png'], 'C:\\proj'), {
				action: 'crossdrive',
				cand: 'D:\\img\\x.png',
			});
		});
	}
});

suite('cliBridgeLogic.buildFixReport', () => {
	test('汇总行 + 修正/问题分节，按 order 顺序', () => {
		const order = ['old.png', 'good.png', 'gone.png'];
		const decisions = new Map<string, Decision>([
			['old.png', { action: 'rewrite', dest: './img/old.png' }],
			['good.png', { action: 'keep' }],
			['gone.png', { action: 'notfound' }],
		]);
		const report = buildFixReport(order, decisions);
		assert.ok(report.startsWith('共 3 处引用：修正 1，已正确 1，问题 1'), report);
		assert.ok(report.includes('  old.png → ./img/old.png'), report);
		assert.ok(report.includes('  ✗ 未找到：gone.png'), report);
		assert.ok(report.endsWith('\n'));
	});
	test('多候选问题列出每个候选 fsPath', () => {
		const order = ['dup.png'];
		const decisions = new Map<string, Decision>([
			['dup.png', { action: 'multi', cands: ['/a/dup.png', '/b/dup.png'] }],
		]);
		const report = buildFixReport(order, decisions);
		assert.ok(report.includes('  ✗ 多个候选：dup.png'), report);
		assert.ok(report.includes('      - /a/dup.png'), report);
		assert.ok(report.includes('      - /b/dup.png'), report);
	});
	test('跨盘符问题列出目标 fsPath', () => {
		const order = ['x.png'];
		const decisions = new Map<string, Decision>([['x.png', { action: 'crossdrive', cand: 'D:\\img\\x.png' }]]);
		assert.ok(buildFixReport(order, decisions).includes('跨磁盘无法相对引用：x.png → D:\\img\\x.png'));
	});
	test('全部 keep → 只有汇总行，无修正/问题节', () => {
		const decisions = new Map<string, Decision>([['a.png', { action: 'keep' }]]);
		assert.strictEqual(buildFixReport(['a.png'], decisions), '共 1 处引用：修正 0，已正确 1，问题 0\n');
	});
});
