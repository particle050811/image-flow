import * as assert from 'assert';
import * as path from 'path';
import * as http from 'http';
import { toRelDest, decideRef, buildFixReport, type Decision } from '../ui/cliBridgeLogic';
import { listenOnFreePort } from '../ui/cliBridge';

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

suite('cliBridge.listenOnFreePort', () => {
	/** 在指定端口起一个占位服务；绑定失败返回 null（说明该端口本就被占，换个基准端口重试） */
	function bindBlocker(port: number): Promise<http.Server | null> {
		return new Promise((resolve) => {
			const s = http.createServer();
			s.once('error', () => resolve(null));
			s.listen(port, '127.0.0.1', () => resolve(s));
		});
	}

	/** 等待服务真正关闭（端口释放），避免跨用例的端口残留 */
	function closeServer(s: http.Server): Promise<void> {
		return new Promise((resolve) => s.close(() => resolve()));
	}

	/** 找一段「前两个可占住、第三个空闲」的连续端口，避免与本机已有服务冲突导致测试不稳定 */
	async function occupyTwo(): Promise<{ base: number; blockers: http.Server[] } | null> {
		for (const base of [49610, 49710, 49810, 49910, 50010]) {
			const b1 = await bindBlocker(base);
			if (!b1) {
				continue;
			}
			const b2 = await bindBlocker(base + 1);
			if (!b2) {
				await closeServer(b1);
				continue;
			}
			const b3 = await bindBlocker(base + 2);
			if (!b3) {
				await closeServer(b1);
				await closeServer(b2);
				continue;
			}
			// base+2 只验证空闲即释放，留给被测函数绑定
			await closeServer(b3);
			return { base, blockers: [b1, b2] };
		}
		return null;
	}

	test('前两个端口被占 → 跳过并 resolve 到实际监听端口（回归：残留 listening 回调曾致 resolve 失败端口）', async function () {
		const occupied = await occupyTwo();
		if (!occupied) {
			// 候选基准端口段全被本机其他服务占用，环境不具备条件
			this.skip();
		}
		const server = http.createServer();
		try {
			const port = await listenOnFreePort(server, occupied.base, 3);
			assert.strictEqual(port, occupied.base + 2);
			const addr = server.address();
			assert.ok(addr && typeof addr !== 'string');
			assert.strictEqual(addr.port, occupied.base + 2);
		} finally {
			await closeServer(server);
			for (const b of occupied.blockers) {
				await closeServer(b);
			}
		}
	});

	test('候选端口全被占 → resolve null', async function () {
		const occupied = await occupyTwo();
		if (!occupied) {
			this.skip();
		}
		const server = http.createServer();
		try {
			const port = await listenOnFreePort(server, occupied.base, 2);
			assert.strictEqual(port, null);
		} finally {
			await closeServer(server);
			for (const b of occupied.blockers) {
				await closeServer(b);
			}
		}
	});
});
