import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { toVipPixels, buildRequestBody, TransientError } from '../api';
import { mdStems, imageStem, sortDescFirst, readImageDesc } from '../materials';
import { formatStamp, parseImageRefs, replaceImageRefs } from '../command';
import { isImageExt, isImageFileName, mimeOf } from '../images';
import { editConfigView } from '../config';
import { imageRefSnippet } from '../refs';
import { buildEditPrompt, buildEditFinalPrompt } from '../edit';
import { buildPromptFileContent, dataUriBytes } from '../taskFiles';
import { EditSession } from '../editSession';
import { thumbKeyOf } from '../thumbs';
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
	namingModel: 'gemini-3.5-flash',
	autoNameEdit: true,
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

suite('buildEditFinalPrompt', () => {
	test('按编辑模型取注入句前置，再接替换后的提示词', () => {
		const config = { ...baseConfig, modelInjections: { 'gpt-image-2': '注入句' } };
		assert.strictEqual(
			buildEditFinalPrompt(config, ' 看 ![](猫.png) ', ['猫.png']),
			'注入句\n\n看 [image1](猫)'
		);
	});
	test('编辑模型无注入句时只剩替换后的提示词', () => {
		assert.strictEqual(buildEditFinalPrompt(baseConfig, '纯文本', []), '纯文本');
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

suite('EditSession', () => {
	const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
	test('addData 正常添加并保持顺序', () => {
		const s = new EditSession();
		assert.strictEqual(s.addData('a.png', png), null);
		assert.strictEqual(s.addData('b.png', png), null);
		assert.deepStrictEqual(s.list().map((i) => i.name), ['a.png', 'b.png']);
	});
	test('重名拒绝并返回错误消息', () => {
		const s = new EditSession();
		s.addData('a.png', png);
		const err = s.addData('a.png', png);
		assert.ok(err && /a\.png/.test(err));
		assert.strictEqual(s.list().length, 1);
	});
	test('非图片扩展名拒绝', () => {
		const s = new EditSession();
		assert.ok(s.addData('a.txt', png));
	});
	test('非图片 data URI 拒绝', () => {
		const s = new EditSession();
		assert.ok(s.addData('a.png', 'data:text/plain;base64,eA=='));
	});
	test('remove 按名移除', () => {
		const s = new EditSession();
		s.addData('a.png', png);
		s.addData('b.png', png);
		s.remove('a.png');
		assert.deepStrictEqual(s.list().map((i) => i.name), ['b.png']);
	});
	test('needsDisplay：大图需要、小图/gif/已有展示图不需要', () => {
		const s = new EditSession();
		const big = `data:image/png;base64,${'A'.repeat(200 * 1024)}`;
		const bigGif = `data:image/gif;base64,${'A'.repeat(200 * 1024)}`;
		s.addData('big.png', big);
		s.addData('small.png', png);
		s.addData('anim.gif', bigGif);
		const [bigImg, smallImg, gifImg] = s.list();
		assert.strictEqual(s.needsDisplay(bigImg), true);
		assert.strictEqual(s.needsDisplay(smallImg), false);
		assert.strictEqual(s.needsDisplay(gifImg), false);
		s.setDisplay('big.png', big.length, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.needsDisplay(bigImg), false);
	});
	test('setDisplay 只接受 webp data URI 且校验原图指纹，不动原图 data', () => {
		const s = new EditSession();
		s.addData('a.png', png);
		s.setDisplay('a.png', png.length, 'data:image/png;base64,eA==');
		assert.strictEqual(s.list()[0].display, undefined);
		// 指纹（原图长度）不匹配：同名换图后的过期回传应被丢弃
		s.setDisplay('a.png', png.length + 1, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.list()[0].display, undefined);
		s.setDisplay('a.png', png.length, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.list()[0].display, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.list()[0].data, png);
		// 不存在的名字静默忽略
		s.setDisplay('ghost.png', 1, 'data:image/webp;base64,eA==');
	});
});

suite('thumbKeyOf', () => {
	test('同输入稳定，uri/mtime/size 任一变化即换 key', () => {
		const k = thumbKeyOf('file:///a.png', 100, 200);
		assert.strictEqual(k, thumbKeyOf('file:///a.png', 100, 200));
		assert.match(k, /^[0-9a-f]{40}$/);
		assert.notStrictEqual(k, thumbKeyOf('file:///b.png', 100, 200));
		assert.notStrictEqual(k, thumbKeyOf('file:///a.png', 101, 200));
		assert.notStrictEqual(k, thumbKeyOf('file:///a.png', 100, 201));
	});
});

suite('materials 同名 MD 描述', () => {
	const file = vscode.FileType.File;
	const dir = vscode.FileType.Directory;
	test('mdStems 收集 .md 主名，大小写不敏感，忽略目录与非 md', () => {
		const stems = mdStems([
			['Foo.MD', file],
			['bar.md', file],
			['baz.png', file],
			['sub.md', dir],
		]);
		assert.deepStrictEqual([...stems].sort(), ['bar', 'foo']);
	});
	test('imageStem 去扩展名并小写，无扩展名/点开头不误切', () => {
		assert.strictEqual(imageStem('Foo.PNG'), 'foo');
		assert.strictEqual(imageStem('a.b.png'), 'a.b');
		assert.strictEqual(imageStem('noext'), 'noext');
		assert.strictEqual(imageStem('.hidden'), '.hidden');
	});
	test('sortDescFirst 有描述的排前面，组内保持原序', () => {
		const sorted = sortDescFirst([
			{ name: 'a.png', uri: 'a' },
			{ name: 'b.png', uri: 'b', hasDesc: true },
			{ name: 'c.png', uri: 'c' },
			{ name: 'd.png', uri: 'd', hasDesc: true },
		]);
		assert.deepStrictEqual(
			sorted.map((i) => i.name),
			['b.png', 'd.png', 'a.png', 'c.png']
		);
	});
	test('readImageDesc 大小写不匹配也能读到，缺失返回空串', async () => {
		const tmp = vscode.Uri.file(
			path.join(os.tmpdir(), `imageflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		);
		await vscode.workspace.fs.createDirectory(tmp);
		try {
			const img = vscode.Uri.joinPath(tmp, 'Foo.PNG');
			await vscode.workspace.fs.writeFile(img, new Uint8Array([0]));
			// 与图片主名大小写不一致的描述文件，仍按小写口径匹配（与 hasDesc 打标一致）
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(tmp, 'foo.md'),
				Buffer.from('  一张测试图\n', 'utf8')
			);
			assert.strictEqual(await readImageDesc(img.toString()), '一张测试图');

			const noDesc = vscode.Uri.joinPath(tmp, 'bare.png');
			await vscode.workspace.fs.writeFile(noDesc, new Uint8Array([0]));
			assert.strictEqual(await readImageDesc(noDesc.toString()), '');
		} finally {
			await vscode.workspace.fs.delete(tmp, { recursive: true });
		}
	});
});
