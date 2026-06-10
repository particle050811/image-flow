import * as assert from 'assert';
import { toVipPixels, buildRequestBody, TransientError } from '../api';
import { formatStamp, parseImageRefs, replaceImageRefs } from '../command';
import { isImageExt, isImageFileName, mimeOf } from '../images';
import { editConfigView } from '../config';
import { imageRefSnippet } from '../refs';
import { buildEditPrompt } from '../edit';
import { buildPromptFileContent, dataUriBytes } from '../taskFiles';
import { isTransientNetworkError, isTaskActive, aggregateProgress } from '../tasks';
import type { ImageFlowConfig, PendingTask, PendingJob } from '../shared';

const baseConfig: ImageFlowConfig = {
	apiKey: 'k',
	baseUrl: 'https://example.com',
	model: 'nano-banana-2',
	aspectRatio: '3:4',
	imageSize: '1K',
	concurrency: 1,
	workbenchCols: 4,
	tasksCols: 2,
	modelInjections: {},
	editModel: 'gpt-image-2',
	editAspectRatio: '16:9',
	editImageSize: '2K',
	editConcurrency: 3,
};

suite('images', () => {
	test('isImageExt 大小写不敏感、白名单内外', () => {
		assert.ok(isImageExt('.png'));
		assert.ok(isImageExt('.JPG'));
		assert.ok(!isImageExt('.txt'));
		assert.ok(!isImageExt(''));
	});
	test('mimeOf 已知映射与未知回退', () => {
		assert.strictEqual(mimeOf('.jpeg'), 'image/jpeg');
		assert.strictEqual(mimeOf('.bmp'), 'image/png');
	});
	test('isImageFileName 按文件名扩展名判断', () => {
		assert.ok(isImageFileName('a.png'));
		assert.ok(isImageFileName('封面.JPEG'));
		assert.ok(!isImageFileName('readme.md'));
		assert.ok(!isImageFileName('noext'));
	});
});

suite('toVipPixels', () => {
	test('正常比例 + 分辨率', () => {
		assert.strictEqual(toVipPixels('16:9', '4K'), '3840x2160');
		assert.strictEqual(toVipPixels('1:1', '1K'), '1024x1024');
	});
	test('未知比例回退 1:1，未知分辨率回退 1K', () => {
		assert.strictEqual(toVipPixels('21:9', '2K'), '2048x2048');
		assert.strictEqual(toVipPixels('1:1', '8K'), '1024x1024');
	});
});

suite('buildRequestBody', () => {
	test('nano-banana 系列带比例 + imageSize', () => {
		const body = buildRequestBody(baseConfig, 'hi', []);
		assert.strictEqual(body.model, 'nano-banana-2');
		assert.strictEqual(body.aspectRatio, '3:4');
		assert.strictEqual(body.imageSize, '1K');
		assert.strictEqual(body.replyType, 'async');
	});
	test('gpt-image-2 只带比例、无 imageSize', () => {
		const body = buildRequestBody({ ...baseConfig, model: 'gpt-image-2' }, 'hi', []);
		assert.strictEqual(body.aspectRatio, '3:4');
		assert.ok(!('imageSize' in body));
	});
	test('gpt-image-2-vip 把比例换算为像素', () => {
		const body = buildRequestBody(
			{ ...baseConfig, model: 'gpt-image-2-vip', aspectRatio: '16:9', imageSize: '2K' },
			'hi',
			[]
		);
		assert.strictEqual(body.aspectRatio, '2048x1152');
	});
});

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

suite('replaceImageRefs', () => {
	test('按编号表替换为 [imageN](文件名)', () => {
		const { indexByPath } = parseImageRefs('![a](pics/x.png) 文 ![b](y.jpg) 再 ![c](pics/x.png)');
		const out = replaceImageRefs('![a](pics/x.png) 文 ![b](y.jpg) 再 ![c](pics/x.png)', indexByPath);
		assert.strictEqual(out, '[image1](x) 文 [image2](y) 再 [image1](x)');
	});
	test('尖括号路径（含空格/半角括号）能解析并替换（F009 回归）', () => {
		const src = '![a](<../my image (1).png>)';
		const { indexByPath } = parseImageRefs(src);
		assert.strictEqual(replaceImageRefs(src, indexByPath), '[image1](my image (1))');
	});
	test('无图片原样返回', () => {
		assert.strictEqual(replaceImageRefs('纯文本', new Map()), '纯文本');
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

suite('editConfigView', () => {
	test('用编辑专属参数覆盖主参数，其余字段保留', () => {
		const view = editConfigView(baseConfig);
		assert.strictEqual(view.model, 'gpt-image-2');
		assert.strictEqual(view.aspectRatio, '16:9');
		assert.strictEqual(view.imageSize, '2K');
		assert.strictEqual(view.concurrency, 3);
		assert.strictEqual(view.apiKey, 'k');
		assert.strictEqual(view.baseUrl, 'https://example.com');
	});
});

suite('imageRefSnippet', () => {
	test('普通文件名直接拼接', () => {
		assert.strictEqual(imageRefSnippet('猫.png'), '![](猫.png)');
	});
	test('含空格或半角括号用尖括号包裹', () => {
		assert.strictEqual(imageRefSnippet('my cat (1).png'), '![](<my cat (1).png>)');
	});
});

suite('buildEditPrompt', () => {
	const names = ['猫.png', '狗 (1).png'];
	test('按编辑区顺序替换为 [imageN](名去扩展)', () => {
		const out = buildEditPrompt('把 ![](<狗 (1).png>) 放进 ![](猫.png) 的场景', names);
		// 序号按编辑区顺序：猫=1、狗=2，与文本出现顺序无关
		assert.strictEqual(out, '把 [image2](狗 (1)) 放进 [image1](猫) 的场景');
	});
	test('尖括号包裹的引用同样可解析', () => {
		assert.strictEqual(buildEditPrompt('看 ![](<狗 (1).png>)', names), '看 [image2](狗 (1))');
	});
	test('未引用任何图片时原文返回', () => {
		assert.strictEqual(buildEditPrompt('纯文本', names), '纯文本');
	});
	test('引用了编辑区不存在的图片名则报错', () => {
		assert.throws(() => buildEditPrompt('看 ![](不存在.png)', names), /不存在\.png/);
	});
});

suite('buildPromptFileContent', () => {
	test('frontmatter 记来源，正文为提示词', () => {
		assert.strictEqual(
			buildPromptFileContent('角色/角色设定.md', '画一只猫'),
			'---\nsource: 角色/角色设定.md\n---\n\n画一只猫\n'
		);
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
