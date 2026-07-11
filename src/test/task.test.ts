import * as assert from 'assert';
import { TransientError } from '../backend/api';
import { formatStamp } from '../task/history';
import {
	parseImageRefs,
	archiveImageRefs,
	dedupeArchiveNames,
	parseMediaDecls,
	buildNameTable,
	replaceMediaRefs,
	findUnreferencedDecls,
} from '../prompt/buildPrompt';
import { isTransientNetworkError, isTaskActive, aggregateProgress } from '../task/tasks';
import { buildPromptFileContent, dataUriBytes } from '../task/taskFiles';
import type { PendingTask, PendingJob } from '../shared';

suite('formatStamp', () => {
	test('补零到 yyMMddHHmmssSSS（毫秒级）', () => {
		assert.strictEqual(formatStamp(new Date(2026, 0, 2, 3, 4, 5, 6)), '260102030405006');
		assert.strictEqual(formatStamp(new Date(2026, 11, 31, 23, 59, 59, 999)), '261231235959999');
	});
});

suite('parseImageRefs', () => {
	test('普通图片语法去重编号', () => {
		const { order, indexByPath } = parseImageRefs('![a](x.png) text ![b](y.png) ![c](x.png)');
		assert.deepStrictEqual(order, ['x.png', 'y.png']);
		assert.strictEqual(indexByPath.get('x.png'), 1);
		assert.strictEqual(indexByPath.get('y.png'), 2);
	});
	test('尖括号包裹含空格/括号的路径', () => {
		const { order } = parseImageRefs('![a](<../my image (1).png>)');
		assert.deepStrictEqual(order, ['../my image (1).png']);
	});
	test('全角括号路径无需尖括号', () => {
		const { order } = parseImageRefs('![a](../李樱（手持剑）.png)');
		assert.deepStrictEqual(order, ['../李樱（手持剑）.png']);
	});
	test('无图片返回空', () => {
		const { order } = parseImageRefs('纯文本没有图片');
		assert.deepStrictEqual(order, []);
	});
});

suite('parseMediaDecls', () => {
	test('提取 alt、路径、类型，按出现顺序', () => {
		const decls = parseMediaDecls('![传送石](./传送石.png) ![开场曲](./bgm.mp3)');
		assert.deepStrictEqual(decls, [
			{ alt: '传送石', path: './传送石.png', type: 'image' },
			{ alt: '开场曲', path: './bgm.mp3', type: 'audio' },
		]);
	});
	test('尖括号路径可解析', () => {
		const decls = parseMediaDecls('![猫](<../my image (1).png>)');
		assert.deepStrictEqual(decls, [{ alt: '猫', path: '../my image (1).png', type: 'image' }]);
	});
	test('无声明返回空', () => {
		assert.deepStrictEqual(parseMediaDecls('纯文本 [传送石]'), []);
	});
});

suite('buildNameTable', () => {
	test('三类各自独立从 1 编号', () => {
		const table = buildNameTable([
			{ alt: '传送石', path: 'a.png', type: 'image' },
			{ alt: '开场曲', path: 'b.mp3', type: 'audio' },
			{ alt: '李樱', path: 'c.png', type: 'image' },
		]);
		assert.deepStrictEqual(table.get('传送石'), { type: 'image', index: 1 });
		assert.deepStrictEqual(table.get('李樱'), { type: 'image', index: 2 });
		assert.deepStrictEqual(table.get('开场曲'), { type: 'audio', index: 1 });
	});
	test('重名声明抛错', () => {
		assert.throws(
			() => buildNameTable([
				{ alt: '传送石', path: 'a.png', type: 'image' },
				{ alt: '传送石', path: 'b.png', type: 'image' },
			]),
			/传送石/
		);
	});
	test('同一路径声明多个名字抛错（产品决策：别名差异在模型侧丢失，只会误导作者），报错含两个名字', () => {
		assert.throws(
			() => buildNameTable([
				{ alt: '正面', path: 'x.png', type: 'image' },
				{ alt: '细节', path: 'x.png', type: 'image' },
			]),
			/x\.png[\s\S]*正面[\s\S]*细节/
		);
	});
});

suite('buildNameTable-extra', () => {
	test('空 alt 第一条即抛错（产品决策：声明必须命名），报错含路径', () => {
		assert.throws(
			() => buildNameTable([
				{ alt: '', path: 'a.png', type: 'image' },
				{ alt: '传送石', path: 'c.png', type: 'image' },
			]),
			/未命名声明[\s\S]*a\.png/
		);
	});
	test('纯空白 alt 经 trim 后也算空（content 级）', () => {
		assert.throws(
			() => buildNameTable(parseMediaDecls('![ ](a.png)')),
			/未命名声明[\s\S]*a\.png/
		);
	});
});

suite('isTransientNetworkError', () => {
	test('上游 5xx 标记的 TransientError 可重试', () => {
		assert.ok(isTransientNetworkError(new TransientError('HTTP 503')));
	});
	test('超时 AbortError 可重试', () => {
		const e = new Error('aborted');
		e.name = 'AbortError';
		assert.ok(isTransientNetworkError(e));
	});
	test('fetch failed 的 TypeError 可重试', () => {
		const e = new TypeError('fetch failed');
		assert.ok(isTransientNetworkError(e));
	});
	test('普通编程 TypeError 不可重试（不应被静默吞掉）', () => {
		assert.ok(!isTransientNetworkError(new TypeError('x is not a function')));
	});
	test('响应格式校验失败不可重试', () => {
		assert.ok(!isTransientNetworkError(new Error('接口返回格式异常：非对象')));
	});
});

suite('replaceMediaRefs', () => {
	const tableOf = (content: string) => buildNameTable(parseMediaDecls(content));
	test('删声明、命名引用替换为【@图片N】，未命中保留', () => {
		const src = '- [传送石] 传送道具。![传送石](./传送石.png)\n[李樱]一手持[传送石]，一手持[魂符]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, '- 【@图片1】 传送道具。\n[李樱]一手持【@图片1】，一手持[魂符]');
	});
	test('音频独立编号【@音频N】', () => {
		const src = '![开场曲](./bgm.mp3) 配乐用[开场曲]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, ' 配乐用【@音频1】');
	});
	test('只删语法本身，前后空格保留', () => {
		const src = 'A ![猫](a.png) B';
		assert.strictEqual(replaceMediaRefs(src, tableOf(src)), 'A  B');
	});
	test('markdown 链接 [文字](url) 不被替换', () => {
		const src = '![猫](a.png) 见[猫](http://x) 和[猫]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, ' 见[猫](http://x) 和【@图片1】');
	});
	test('无声明无命中原样返回', () => {
		assert.strictEqual(replaceMediaRefs('纯文本 [未知]', new Map()), '纯文本 [未知]');
	});
	// 以下两条锁定「按类型独立编号」的当前行为（已知限制：编号口径与 images[] 全局上传下标不对齐）
	test('混合媒体：图片/音频各自从 1 编号', () => {
		const src = '![传送石](a.png) ![开场曲](b.mp3) ![李樱](c.png) [传送石][开场曲][李樱]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, '   【@图片1】【@音频1】【@图片2】');
	});
	test('同一路径两个 alt 在建表时即抛错（content 级）', () => {
		assert.throws(() => tableOf('![甲](x.png) ![乙](x.png) [甲][乙]'), /同一文件声明了多个名字/);
	});
});

suite('findUnreferencedDecls', () => {
	test('声明名与引用名不一致（声明未被引用）→ 列出未引用名', () => {
		const src = '- [李樱] 主角。![李樱三视图](../李樱三视图.png)\n- [九胡] 女仆。![九胡三视图](../九胡三视图.png)';
		assert.deepStrictEqual(findUnreferencedDecls(src, parseMediaDecls(src)), ['李樱三视图', '九胡三视图']);
	});
	test('全部声明都被引用 → 空数组', () => {
		const src = '![传送石](a.png) [传送石]手持';
		assert.deepStrictEqual(findUnreferencedDecls(src, parseMediaDecls(src)), []);
	});
	test('无声明 → 空数组', () => {
		assert.deepStrictEqual(findUnreferencedDecls('纯文本 [未知]', parseMediaDecls('纯文本 [未知]')), []);
	});
});

suite('dedupeArchiveNames', () => {
	test('保留原名，重名追加序号', () => {
		assert.deepStrictEqual(dedupeArchiveNames(['a.png', 'b.png', 'a.png']), ['a.png', 'b.png', 'a-1.png']);
	});
	test('无重名原样返回', () => {
		assert.deepStrictEqual(dedupeArchiveNames(['x.png', 'y.jpg']), ['x.png', 'y.jpg']);
	});
});

suite('archiveImageRefs', () => {
	test('引用改写为 ![alt](input/原名)，保留 alt 供命名引用重生成', () => {
		const src = '![传送石](pics/x.png) 文 ![李樱](y.jpg) 再 ![传送石2](pics/x.png)';
		const { indexByPath } = parseImageRefs(src);
		const out = archiveImageRefs(src, indexByPath, ['x.png', 'y.jpg']);
		assert.strictEqual(out, '![传送石](input/x.png) 文 ![李樱](input/y.jpg) 再 ![传送石2](input/x.png)');
	});
	test('含空格的归档名用尖括号包裹，alt 保留', () => {
		const src = '![猫](<../my image (1).png>)';
		const { indexByPath } = parseImageRefs(src);
		assert.strictEqual(archiveImageRefs(src, indexByPath, ['my image (1).png']), '![猫](<input/my image (1).png>)');
	});
	test('无图片原样返回', () => {
		assert.strictEqual(archiveImageRefs('纯文本', new Map(), []), '纯文本');
	});
});

suite('isTaskActive', () => {
	const task = (statuses: PendingJob['status'][]): PendingTask =>
		({ jobs: statuses.map((status) => ({ status })) } as PendingTask);
	test('有 submitting 或 running 即活跃', () => {
		assert.ok(isTaskActive(task(['submitting'])));
		assert.ok(isTaskActive(task(['succeeded', 'running'])));
	});
	test('全部终结则不活跃', () => {
		assert.ok(!isTaskActive(task(['succeeded', 'failed', 'violation'])));
	});
});

suite('aggregateProgress', () => {
	const jobs = (xs: Partial<PendingJob>[]): PendingJob[] =>
		xs.map((x) => ({ status: 'running', ...x })) as PendingJob[];
	test('空 jobs 返回 0', () => {
		assert.strictEqual(aggregateProgress([]), 0);
	});
	test('终结 job 记满分、running 取远端进度、submitting 记 0 后均摊', () => {
		// 100(succeeded) + 50(running) + 0(submitting) = 150 / 3 = 50
		assert.strictEqual(
			aggregateProgress(jobs([{ status: 'succeeded' }, { status: 'running', progress: 50 }, { status: 'submitting' }])),
			50
		);
	});
	test('running 无远端进度按 0', () => {
		assert.strictEqual(aggregateProgress(jobs([{ status: 'running' }, { status: 'succeeded' }])), 50);
	});
	test('failed/violation 也记满分', () => {
		assert.strictEqual(aggregateProgress(jobs([{ status: 'failed' }, { status: 'violation' }])), 100);
	});
});

suite('buildPromptFileContent', () => {
	test('纯正文归档（来源已迁出到 meta.json，不再写 frontmatter）', () => {
		assert.strictEqual(buildPromptFileContent('画一只猫'), '画一只猫\n');
	});
});

suite('dataUriBytes', () => {
	test('解析 base64 data URI 为字节', () => {
		const data = `data:image/png;base64,${Buffer.from('abc').toString('base64')}`;
		assert.deepStrictEqual(Array.from(dataUriBytes(data)), [97, 98, 99]);
	});
	test('非 data URI 抛错', () => {
		assert.throws(() => dataUriBytes('https://x/y.png'), /data URI/);
	});
});
