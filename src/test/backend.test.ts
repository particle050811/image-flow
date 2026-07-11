import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { toVipPixels, resolveImageSize, normalizeBase } from '../backend/api';
import { buildRequestBody } from '../backend/adapters/grsaiAsync';
import { buildImagesBody } from '../backend/adapters/openaiImages';
import { buildGenerateContentBody } from '../backend/adapters/geminiGenerate';
import { mergeCustomParams } from '../backend/adapters/types';
import {
	buildOptions,
	BUILTIN_GRSAI,
	parseCustomProvider,
	paramDefaults,
	parseJsonc,
} from '../backend/providers';
import { baseConfig } from './fixtures';

suite('toVipPixels', () => {
	test('正常比例 + 分辨率', () => {
		assert.strictEqual(toVipPixels('16:9', '4K'), '3840x2160');
		assert.strictEqual(toVipPixels('1:1', '1K'), '1024x1024');
	});
	test('扩展比例（3:2 / 5:4 / 21:9 / 2:1）按表换算', () => {
		assert.strictEqual(toVipPixels('3:2', '1K'), '1536x1024');
		assert.strictEqual(toVipPixels('5:4', '2K'), '2240x1792');
		assert.strictEqual(toVipPixels('21:9', '4K'), '3840x1648');
		assert.strictEqual(toVipPixels('2:1', '2K'), '3072x1536');
	});
	test('auto 不换算，原样返回', () => {
		assert.strictEqual(toVipPixels('auto', '1K'), 'auto');
		assert.strictEqual(toVipPixels('auto', '4K'), 'auto');
	});
	test('1:3 / 3:1 无 1K 档，选 1K 并到最近可用档（2K）', () => {
		assert.strictEqual(toVipPixels('1:3', '1K'), '688x2048');
		assert.strictEqual(toVipPixels('3:1', '1K'), '2048x688');
		assert.strictEqual(toVipPixels('1:3', '4K'), '1280x3840');
	});
	test('未知比例回退 1:1，未知分辨率回退 1K', () => {
		assert.strictEqual(toVipPixels('7:5', '2K'), '2048x2048');
		assert.strictEqual(toVipPixels('1:1', '8K'), '1024x1024');
	});
});

suite('providers', () => {
	test('buildOptions：合并多渠道模型（带渠道标识），无 url/key', () => {
		const custom = parseCustomProvider({
			image: [{ model: 'gpt-image-2', label: '自定义 GPT', adapter: 'openai-images', apiKey: 'k',
				aspectRatios: ['1:1'], imageSizes: ['1K'] }],
		});
		const opts = buildOptions([BUILTIN_GRSAI, custom]);
		// 内置模型齐全，且同名模型靠 provider 区分不互相覆盖
		const grsaiGpt = opts.imageModels.find((m) => m.provider === 'grsai' && m.model === 'gpt-image-2');
		const customGpt = opts.imageModels.find((m) => m.provider === 'custom' && m.model === 'gpt-image-2');
		assert.deepStrictEqual(grsaiGpt?.imageSizes, ['1K']);
		assert.strictEqual(grsaiGpt?.label, 'GPT Image 2');
		assert.strictEqual(customGpt?.label, '自定义 GPT');
		assert.strictEqual(customGpt?.providerLabel, '自定义');
		// 不应泄漏任何 url/key 字段
		for (const m of opts.imageModels) {
			assert.ok(!('apiKey' in m) && !('baseUrl' in m));
		}
	});

	test('parseCustomProvider：解析 image/chat，跳过缺 model/adapter 的项，custom 参数齐全', () => {
		const provider = parseCustomProvider({
			image: [
				{ model: 'm1', label: 'M1', adapter: 'openai-images', baseUrl: 'u', apiKey: 'k',
				  aspectRatios: ['1:1'], imageSizes: ['1K'],
				  custom: [{ key: 'quality', label: '质量', options: ['low', 'high'], default: 'low' }] },
				{ label: '缺 model/adapter' }, // 跳过
			],
			chat: [{ model: 'c1' }],
		});
		assert.strictEqual(provider.id, 'custom');
		assert.strictEqual(provider.image.length, 1);
		assert.strictEqual(provider.image[0].apiKey, 'k');
		assert.deepStrictEqual(provider.image[0].custom[0], { key: 'quality', label: '质量', options: ['low', 'high'], default: 'low' });
		assert.strictEqual(provider.chat[0].adapter, 'openai-chat'); // adapter 缺省补 openai-chat
	});

	test('parseCustomProvider：非对象/缺字段不抛错，给空列表', () => {
		assert.deepStrictEqual(parseCustomProvider(undefined).image, []);
		assert.deepStrictEqual(parseCustomProvider('x').chat, []);
	});

	test('paramDefaults：取每个可见参数的默认值', () => {
		assert.deepStrictEqual(
			paramDefaults([{ key: 'q', label: 'Q', options: ['a', 'b'], default: 'b' }]),
			{ q: 'b' }
		);
	});

	test('parseJsonc：解析 // 与 /* */ 注释，保留字符串里的 //（URL 不被误删）', () => {
		const src = '{\n  // 行注释\n  "url": "https://a.com/v1", /* 块注释 */ "n": 1\n}';
		const parsed = parseJsonc(src) as { url: string; n: number };
		assert.strictEqual(parsed.url, 'https://a.com/v1');
		assert.strictEqual(parsed.n, 1);
	});

	test('parseJsonc：容忍 } / ] 前尾逗号，但不动字符串里的 ,}', () => {
		const src = '{\n  "arr": [1, 2, ], // 尾逗号\n  "s": "a,}b",\n}';
		const parsed = parseJsonc(src) as { arr: number[]; s: string };
		assert.deepStrictEqual(parsed.arr, [1, 2]);
		assert.strictEqual(parsed.s, 'a,}b'); // 字符串里的 ,} 原样保留
	});

	test('parseJsonc：非法 JSONC 抛错（让 reloadCustomProvider 回落内置 grsai，而非产出空自定义 Provider）', () => {
		assert.throws(() => parseJsonc('{ "image": [ '));   // 截断
		assert.throws(() => parseJsonc('this is not json')); // 垃圾
	});

	test('内置模板 media/settings.template.jsonc 能解析出模型', () => {
		const file = path.resolve(__dirname, '../../media/settings.template.jsonc');
		const provider = parseCustomProvider(parseJsonc(fs.readFileSync(file, 'utf8')));
		assert.ok(provider.image.length >= 1);
		assert.ok(provider.chat.length >= 1);
		assert.strictEqual(provider.image[0].adapter, 'grsai-async');
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

suite('normalizeBase', () => {
	test('去尾部 /v1 与尾部斜杠，避免拼出 /v1/v1', () => {
		assert.strictEqual(normalizeBase('https://yunwu.ai/v1'), 'https://yunwu.ai');
		assert.strictEqual(normalizeBase('https://yunwu.ai/v1/'), 'https://yunwu.ai');
		assert.strictEqual(normalizeBase('https://grsai.dakka.com.cn/'), 'https://grsai.dakka.com.cn');
	});
	test('根地址原样，不误伤 /v1beta', () => {
		assert.strictEqual(normalizeBase('https://grsai.dakka.com.cn'), 'https://grsai.dakka.com.cn');
		assert.strictEqual(normalizeBase('https://host/v1beta'), 'https://host/v1beta');
	});
});

suite('resolveImageSize', () => {
	test('已是像素串原样返回', () => {
		assert.strictEqual(resolveImageSize('16:9', '1536x1024'), '1536x1024');
	});
	test('档位按比例换算成像素', () => {
		assert.strictEqual(resolveImageSize('16:9', '2K'), '2048x1152');
	});
	test('auto 原样返回', () => {
		assert.strictEqual(resolveImageSize('auto', '4K'), 'auto');
	});
});

suite('mergeCustomParams', () => {
	test('并入非空值，跳过 undefined / 空串，保留 0 / false 等合法 falsy', () => {
		const body: Record<string, unknown> = { model: 'x' };
		mergeCustomParams(body, { quality: 'high', empty: '', zero: '0', flag: 'false' });
		assert.deepStrictEqual(body, { model: 'x', quality: 'high', zero: '0', flag: 'false' });
	});
});

suite('buildImagesBody（openai-images 文生图）', () => {
	test('只带 model/prompt/size + custom 参数，不带 image/response_format/moderation', () => {
		const config = { ...baseConfig, model: 'gpt-image-2', aspectRatio: '16:9', imageSize: '2K', params: { quality: 'high' } };
		const body = buildImagesBody(config, 'hi');
		assert.strictEqual(body.model, 'gpt-image-2');
		assert.strictEqual(body.prompt, 'hi');
		assert.strictEqual(body.size, '2048x1152');
		assert.strictEqual(body.quality, 'high');
		// 严格渠道会拒未知参数，故这些一律不发
		assert.ok(!('image' in body) && !('response_format' in body) && !('moderation' in body));
	});
});

suite('buildGenerateContentBody（gemini-generate）', () => {
	test('文本 + 参考图 inline_data，解析 data URI 的 mime 与裸 base64', () => {
		const body = buildGenerateContentBody(baseConfig, 'hi', ['data:image/jpeg;base64,QUJD']) as {
			contents: { parts: unknown[] }[];
		};
		assert.deepStrictEqual(body.contents[0].parts, [
			{ text: 'hi' },
			{ inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } },
		]);
	});
	test('并入 custom 参数到顶层', () => {
		const body = buildGenerateContentBody({ ...baseConfig, params: { foo: 'bar' } }, 'hi', []) as Record<string, unknown>;
		assert.strictEqual(body.foo, 'bar');
	});
});
