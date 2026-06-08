import * as assert from 'assert';
import { toVipPixels, buildRequestBody, TransientError } from '../api';
import { formatStamp, parseImageRefs } from '../command';
import { isImageExt, mimeOf } from '../images';
import { isTransientNetworkError } from '../tasks';
import type { ImageFlowConfig } from '../shared';

const baseConfig: ImageFlowConfig = {
	apiKey: 'k',
	baseUrl: 'https://example.com',
	model: 'nano-banana-2',
	aspectRatio: '3:4',
	imageSize: '1K',
	concurrency: 1,
	workbenchThumbSize: 72,
	tasksThumbSize: 140,
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
	test('补零到 yyMMddHHmmSS', () => {
		assert.strictEqual(formatStamp(new Date(2026, 0, 2, 3, 4, 5)), '260102030405');
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
