import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { toVipPixels, buildRequestBody, TransientError } from '../api';
import { mdStems, imageStem, sortDescFirst, readImageDesc } from '../materials';
import { formatStamp, parseImageRefs, archiveImageRefs, dedupeArchiveNames, parseMediaDecls, buildNameTable, replaceMediaRefs, assertAllDeclsReferenced } from '../command';
import { isImageExt, isImageFileName, mimeOf, mediaTypeOf } from '../images';
import { editConfigView } from '../config';
import { namedRefSnippet, mediaDeclSnippet } from '../refs';
import { buildEditFinalPrompt, buildEditArchivePrompt } from '../edit';
import { buildPromptFileContent, dataUriBytes } from '../taskFiles';
import { EditSession } from '../editSession';
import { thumbKeyOf } from '../thumbs';
import { isTransientNetworkError, isTaskActive, aggregateProgress } from '../tasks';
import type { ImageFlowConfig, PendingTask, PendingJob } from '../shared';
import {
	DEFAULT_COLLECTION_ID,
	emptyFavorites,
	migrateFavorites,
	favoriteUriSet,
	toggleFavorite,
	moveFavorite,
	renameFavoriteUri,
	createCollection,
	renameCollection,
	deleteCollection,
	setActiveCollection,
	dedupeName,
	collectionNameError,
} from '../favorites';

const baseConfig: ImageFlowConfig = {
	apiKey: 'k',
	baseUrl: 'https://example.com',
	model: 'nano-banana-2',
	aspectRatio: '3:4',
	imageSize: '1K',
	concurrency: 1,
	workbenchCols: 4,
	tasksCols: 2,
	favoritesCols: 2,
	workbenchTabCols: 4,
	tasksTabCols: 2,
	favoritesTabCols: 2,
	modelInjections: {},
	editModel: 'gpt-image-2',
	editAspectRatio: '16:9',
	editImageSize: '2K',
	editConcurrency: 3,
	namingModel: 'gemini-3.5-flash',
	autoName: true,
	showThumbActions: true,
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

suite('mediaTypeOf', () => {
	test('图片扩展名归 image', () => {
		assert.strictEqual(mediaTypeOf('.png'), 'image');
		assert.strictEqual(mediaTypeOf('.JPG'), 'image');
	});
	test('音频扩展名归 audio', () => {
		assert.strictEqual(mediaTypeOf('.mp3'), 'audio');
		assert.strictEqual(mediaTypeOf('.wav'), 'audio');
	});
	test('视频扩展名归 video', () => {
		assert.strictEqual(mediaTypeOf('.mp4'), 'video');
		assert.strictEqual(mediaTypeOf('.mov'), 'video');
	});
	test('未知扩展名回退 image', () => {
		assert.strictEqual(mediaTypeOf('.txt'), 'image');
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
	test('同一路径两个 alt 各自编号（仅上传 1 张，编号到 2 为已知限制）', () => {
		const src = '![甲](x.png) ![乙](x.png) [甲][乙]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, '  【@图片1】【@图片2】');
	});
});

suite('assertAllDeclsReferenced', () => {
	test('声明名与引用名不一致（声明未被引用）→ 抛错列出未引用名', () => {
		const src = '- [李樱] 主角。![李樱三视图](../李樱三视图.png)\n- [九胡] 女仆。![九胡三视图](../九胡三视图.png)';
		assert.throws(() => assertAllDeclsReferenced(src, parseMediaDecls(src)), /李樱三视图/);
	});
	test('全部声明都被引用 → 不抛', () => {
		const src = '![传送石](a.png) [传送石]手持';
		assert.doesNotThrow(() => assertAllDeclsReferenced(src, parseMediaDecls(src)));
	});
	test('无声明 → 不抛', () => {
		assert.doesNotThrow(() => assertAllDeclsReferenced('纯文本 [未知]', parseMediaDecls('纯文本 [未知]')));
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

suite('namedRefSnippet', () => {
	test('去扩展名后用中括号包裹', () => {
		assert.strictEqual(namedRefSnippet('传送石.png'), '[传送石]');
	});
	test('含空格的文件名取主名', () => {
		assert.strictEqual(namedRefSnippet('my cat (1).png'), '[my cat (1)]');
	});
	test('无扩展名原样', () => {
		assert.strictEqual(namedRefSnippet('李樱'), '[李樱]');
	});
});

suite('mediaDeclSnippet', () => {
	test('普通文件名直接拼接', () => {
		assert.strictEqual(mediaDeclSnippet('猫', '猫.png'), '![猫](猫.png)');
	});
	test('含空格或半角括号的路径用尖括号包裹', () => {
		assert.strictEqual(mediaDeclSnippet('猫', 'my cat (1).png'), '![猫](<my cat (1).png>)');
	});
});

suite('buildEditFinalPrompt', () => {
	test('全部图拼成顶部声明，命名引用替换为【@图片N】，前置注入句', () => {
		const config = { ...baseConfig, modelInjections: { 'gpt-image-2': '注入句' } };
		// editConfigView 默认 model = gpt-image-2，取该注入句
		const out = buildEditFinalPrompt(config, '把[狗]放进[猫]的场景', ['猫.png', '狗.png']);
		assert.strictEqual(out, '注入句\n\n把【@图片2】放进【@图片1】的场景');
	});
	test('无注入句时只剩替换后的正文', () => {
		const out = buildEditFinalPrompt(baseConfig, '看[猫]', ['猫.png']);
		assert.strictEqual(out, '看【@图片1】');
	});
	test('编辑区有图但正文一次都没引用 → 抛错', () => {
		assert.throws(() => buildEditFinalPrompt(baseConfig, '纯文本', ['猫.png']), /猫/);
	});
	test('含空格文件名的声明用尖括号包裹，引用按主名匹配', () => {
		const out = buildEditFinalPrompt(baseConfig, '看[狗 (1)]', ['狗 (1).png']);
		assert.strictEqual(out, '看【@图片1】');
	});
});

suite('buildEditArchivePrompt', () => {
	test('前置全部图声明 ![名](input/原名) + 命名引用正文，供右键重生成', () => {
		const names = ['猫.png', '狗.png'];
		const fileNames = dedupeArchiveNames(names);
		const out = buildEditArchivePrompt('把[狗]放进[猫]', names, fileNames);
		assert.strictEqual(out, '![猫](input/猫.png)\n![狗](input/狗.png)\n把[狗]放进[猫]');
	});
	test('含空格文件名声明用尖括号包裹', () => {
		const out = buildEditArchivePrompt('看[狗 (1)]', ['狗 (1).png'], ['狗 (1).png']);
		assert.strictEqual(out, '![狗 (1)](<input/狗 (1).png>)\n看[狗 (1)]');
	});
	test('无图时仅正文', () => {
		assert.strictEqual(buildEditArchivePrompt('纯文本', [], []), '纯文本');
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
	test('同主名异扩展拒绝（命名引用会冲突）', () => {
		const s = new EditSession();
		assert.strictEqual(s.addData('logo.png', png), null);
		const err = s.addData('logo.jpg', png);
		assert.ok(err && /logo/.test(err));
		assert.strictEqual(s.list().length, 1);
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

suite('favorites', () => {
	const now = 1750000000000;
	const u = (n: string) => `file:///d%3A/proj/.image-flow/tasks/1/${n}.png`;

	test('emptyFavorites 含默认夹且为当前', () => {
		const d = emptyFavorites(now);
		assert.strictEqual(d.version, 2);
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].id, DEFAULT_COLLECTION_ID);
		assert.deepStrictEqual(d.collections[0].items, []);
	});

	test('migrateFavorites 旧版 items 包成默认夹', () => {
		const raw = { items: [{ path: 'x', addedAt: 1 }] };
		const d = migrateFavorites(raw, now);
		assert.strictEqual(d.version, 2);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].id, DEFAULT_COLLECTION_ID);
	});

	test('migrateFavorites 已是 v2 原样保留', () => {
		const v2 = emptyFavorites(now);
		v2.collections[0].items.push({ uri: u('a'), addedAt: 1 });
		const d = migrateFavorites(v2, now);
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('migrateFavorites 空/坏输入回落空收藏', () => {
		assert.strictEqual(migrateFavorites(undefined, now).collections.length, 1);
		assert.strictEqual(migrateFavorites('garbage', now).collections.length, 1);
	});

	test('migrateFavorites v2 半坏数据：丢弃无 id 的夹、items 非数组置空、丢弃无 uri 的项', () => {
		const raw = {
			version: 2,
			activeCollectionId: DEFAULT_COLLECTION_ID,
			collections: [
				{ id: DEFAULT_COLLECTION_ID, name: '默认收藏', createdAt: 1, items: 'oops' },
				{ name: '无id', items: [] },
				{ id: 'c_x', name: 'X', items: [{ uri: u('a') }, { note: '无uri' }] },
			],
		};
		const d = migrateFavorites(raw, now);
		assert.strictEqual(d.collections.length, 2); // 无 id 的夹被丢弃
		const def = d.collections.find((c) => c.id === DEFAULT_COLLECTION_ID)!;
		assert.deepStrictEqual(def.items, []); // items 非数组 → []
		const cx = d.collections.find((c) => c.id === 'c_x')!;
		assert.strictEqual(cx.items.length, 1); // 无 uri 的项被丢弃
		assert.strictEqual(cx.items[0].addedAt, now); // addedAt 缺失补默认
	});

	test('toggleFavorite 未收藏则加入当前夹', () => {
		const d = toggleFavorite(emptyFavorites(now), u('a'), now);
		assert.ok(favoriteUriSet(d).has(u('a')));
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('toggleFavorite 已收藏则从所有夹移除', () => {
		let d = toggleFavorite(emptyFavorites(now), u('a'), now);
		d = toggleFavorite(d, u('a'), now);
		assert.ok(!favoriteUriSet(d).has(u('a')));
	});

	test('moveFavorite 从原夹移到目标夹（一图归一组）', () => {
		let d = createCollection(emptyFavorites(now), '产品图', now);
		const target = d.collections[1].id;
		d = toggleFavorite(d, u('a'), now); // 进默认夹
		d = moveFavorite(d, u('a'), target, now);
		assert.strictEqual(d.collections[0].items.length, 0);
		assert.strictEqual(d.collections[1].items.length, 1);
		// 不重复：移到同一图两次仍只在目标夹一份
		d = moveFavorite(d, u('a'), target, now);
		assert.strictEqual(d.collections[1].items.length, 1);
	});

	test('createCollection 用 c_<时间戳> id 且不设为当前', () => {
		const d = createCollection(emptyFavorites(now), '新夹', now);
		assert.strictEqual(d.collections.length, 2);
		assert.strictEqual(d.collections[1].id, `c_${now}`);
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
	});

	test('renameCollection 只改 name 不改 id', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = renameCollection(d, id, 'B');
		assert.strictEqual(d.collections[1].id, id);
		assert.strictEqual(d.collections[1].name, 'B');
	});

	test('renameFavoriteUri 改写所有夹中的旧 uri 并保留收藏信息', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = moveFavorite(d, u('old'), id, now);
		d = renameFavoriteUri(d, u('old'), u('new'));
		assert.ok(!favoriteUriSet(d).has(u('old')));
		assert.ok(favoriteUriSet(d).has(u('new')));
		assert.strictEqual(d.collections[1].items[0].addedAt, now);
	});

	test('deleteCollection 只剩一个夹时拒删', () => {
		const d = deleteCollection(emptyFavorites(now), DEFAULT_COLLECTION_ID, false);
		assert.strictEqual(d.collections.length, 1);
	});

	test('deleteCollection 仍有其它夹时可删默认夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		d = deleteCollection(d, DEFAULT_COLLECTION_ID, false);
		assert.strictEqual(d.collections.length, 1);
		assert.ok(!d.collections.some((c) => c.id === DEFAULT_COLLECTION_ID));
	});

	test('deleteCollection moveToDefault 把图并入默认夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = moveFavorite(d, u('a'), id, now);
		d = deleteCollection(d, id, true);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('deleteCollection 删默认夹时图并入剩余第一个夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		d = toggleFavorite(d, u('a'), now); // 进默认夹
		d = deleteCollection(d, DEFAULT_COLLECTION_ID, true);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].name, 'A');
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('deleteCollection 删当前夹后当前回落剩余第一个夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = setActiveCollection(d, id);
		d = deleteCollection(d, id, false);
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
	});

	test('setActiveCollection 不存在的 id 回落第一个夹', () => {
		const d = setActiveCollection(emptyFavorites(now), 'c_nope');
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
	});

	test('migrateFavorites v2 缺默认夹不强行恢复（尊重用户删除）', () => {
		const raw = {
			version: 2,
			activeCollectionId: 'c_x',
			collections: [{ id: 'c_x', name: 'X', createdAt: 1, items: [] }],
		};
		const d = migrateFavorites(raw, now);
		assert.strictEqual(d.collections.length, 1);
		assert.ok(!d.collections.some((c) => c.id === DEFAULT_COLLECTION_ID));
		assert.strictEqual(d.activeCollectionId, 'c_x');
	});

	test('dedupeName 重名追加序号', () => {
		const used = new Set(['a.png']);
		assert.strictEqual(dedupeName(used, 'a.png'), 'a-1.png');
		used.add('a-1.png');
		assert.strictEqual(dedupeName(used, 'a.png'), 'a-2.png');
		assert.strictEqual(dedupeName(used, 'b.png'), 'b.png');
	});

	test('collectionNameError 拦截空名与非法文件夹字符', () => {
		assert.strictEqual(collectionNameError('产品主图'), null);
		assert.ok(collectionNameError(''));
		assert.ok(collectionNameError('   '));
		assert.ok(collectionNameError('a/b'));
		assert.ok(collectionNameError('a:b'));
		assert.ok(collectionNameError('a*?"<>|b'));
		assert.ok(collectionNameError('..'));
	});
});
