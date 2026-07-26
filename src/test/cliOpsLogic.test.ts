import * as assert from 'assert';
import {
	parseSubmitArgs,
	parseEditArgs,
	resolveSubmitPlan,
	editSubmitConfig,
	normalizeSubmitId,
	taskGenStatus,
	type CliSubmitConfig,
} from '../ui/cliOpsLogic';
import { qualifiedModel } from '../modelOptions';
import { buildOptions, type RuntimeProvider } from '../backend/providers';
import { baseConfig } from './fixtures';
import type { ConfigOptions, ImageFlowConfig } from '../shared';

/** 造一份跨渠道模型表：含重名模型（grsai/custom 各有 gpt-image-2）与视频模型（带 defaults/custom 参数） */
const OPTIONS: ConfigOptions = {
	imageModels: [
		{
			provider: 'grsai',
			providerLabel: 'Grsai',
			model: 'nano-banana-2',
			label: 'Nano Banana 2',
			aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
			imageSizes: ['1K', '2K', '4K'],
			maxConcurrency: 10,
			custom: [],
		},
		{
			provider: 'grsai',
			providerLabel: 'Grsai',
			model: 'gpt-image-2',
			label: 'GPT Image 2',
			aspectRatios: ['1:1', '3:4'],
			imageSizes: ['1K'],
			maxConcurrency: 10,
			custom: [],
		},
		{
			provider: 'custom',
			providerLabel: '自定义',
			model: 'gpt-image-2',
			label: '自定义 GPT Image 2',
			// 自定义模型可不声明档位（后端不裁剪能力）
			aspectRatios: [],
			imageSizes: [],
			maxConcurrency: 10,
			custom: [],
		},
		{
			provider: 'jimeng',
			providerLabel: '即梦',
			model: 'seedance2.0',
			label: 'Seedance 2.0',
			aspectRatios: ['1:1', '3:4', '16:9'],
			imageSizes: ['720p'],
			maxConcurrency: 4,
			video: true,
			defaults: { aspectRatio: '16:9', imageSize: '720p', concurrency: 1 },
			custom: [{ key: 'duration', label: '时长（秒）', options: ['4', '5', '6', '8'], default: '5' }],
		},
	],
};

/** 工作台基线配置：grsai / nano-banana-2 / 3:4 / 4K / 并发 4、无参数记忆 */
function config(patch: Partial<CliSubmitConfig> = {}): CliSubmitConfig {
	return {
		providerId: 'grsai',
		model: 'nano-banana-2',
		aspectRatio: '3:4',
		imageSize: '4K',
		concurrency: 4,
		params: {},
		imageSizeMemory: {},
		...patch,
	};
}

suite('parseSubmitArgs', () => {
	test('缺省与空对象均得空 args', () => {
		assert.deepStrictEqual(parseSubmitArgs(undefined), {});
		assert.deepStrictEqual(parseSubmitArgs({}), {});
		assert.deepStrictEqual(parseSubmitArgs(null), {});
	});

	test('合法字段原样通过', () => {
		const args = parseSubmitArgs({
			model: 'seedance2.0',
			ratio: '16:9',
			resolution: '720p',
			generate_num: 2,
			params: { duration: '8' },
		});
		assert.deepStrictEqual(args, {
			model: 'seedance2.0',
			ratio: '16:9',
			resolution: '720p',
			generate_num: 2,
			params: { duration: '8' },
		});
	});

	test('字段类型非法即抛错', () => {
		assert.throws(() => parseSubmitArgs({ model: 42 }), /model 须为非空字符串/);
		assert.throws(() => parseSubmitArgs({ ratio: '' }), /ratio 须为非空字符串/);
		assert.throws(() => parseSubmitArgs({ generate_num: '4' }), /generate_num 须为数字/);
		assert.throws(() => parseSubmitArgs({ params: ['a'] }), /params 须为对象/);
		assert.throws(() => parseSubmitArgs({ params: { duration: 8 } }), /值须为字符串/);
	});
});

suite('resolveSubmitPlan', () => {
	test('无覆盖且模型不变：沿用工作台当前参数', () => {
		const plan = resolveSubmitPlan(OPTIONS, config(), {});
		assert.deepStrictEqual(plan.overrides, {
			providerId: 'grsai',
			model: 'nano-banana-2',
			aspectRatio: '3:4',
			imageSize: '4K',
			concurrency: 4,
			params: {},
		});
		assert.strictEqual(plan.video, false);
	});

	test('--model 切视频模型且无快照：取模型默认 16:9/720p/1 条并播种 duration', () => {
		const plan = resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0' });
		assert.deepStrictEqual(plan.overrides, {
			providerId: 'jimeng',
			model: 'seedance2.0',
			aspectRatio: '16:9',
			imageSize: '720p',
			concurrency: 1,
			params: { duration: '5' },
		});
		assert.strictEqual(plan.video, true);
	});

	test('--model 切模型且有快照：恢复该模型上次参数（等价侧栏切模型）', () => {
		const cfg = config({
			imageSizeMemory: {
				[qualifiedModel('jimeng', 'seedance2.0')]: {
					aspectRatio: '3:4',
					imageSize: '720p',
					concurrency: 2,
					params: { duration: '8' },
				},
			},
		});
		const plan = resolveSubmitPlan(OPTIONS, cfg, { model: 'seedance2.0' });
		assert.deepStrictEqual(plan.overrides, {
			providerId: 'jimeng',
			model: 'seedance2.0',
			aspectRatio: '3:4',
			imageSize: '720p',
			concurrency: 2,
			params: { duration: '8' },
		});
	});

	test('显式 flag 最优先且严格校验档位', () => {
		const plan = resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0', ratio: '3:4' });
		assert.strictEqual(plan.overrides.aspectRatio, '3:4');
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0', ratio: '21:9' }),
			/不支持比例「21:9」/
		);
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0', resolution: '4k' }),
			/不支持分辨率「4k」/
		);
	});

	test('generate_num 按模型并发上限校验', () => {
		const plan = resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0', generate_num: 3 });
		assert.strictEqual(plan.overrides.concurrency, 3);
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0', generate_num: 5 }),
			/1~4 的整数/
		);
		assert.throws(() => resolveSubmitPlan(OPTIONS, config(), { generate_num: 0 }), /1~10 的整数/);
	});

	test('--param 按模型声明校验：未知键与非法值都抛错', () => {
		const plan = resolveSubmitPlan(OPTIONS, config(), {
			model: 'seedance2.0',
			params: { duration: '8' },
		});
		assert.deepStrictEqual(plan.overrides.params, { duration: '8' });
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0', params: { speed: '2' } }),
			/没有自定义参数「speed」/
		);
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, config(), { model: 'seedance2.0', params: { duration: '99' } }),
			/不在可选项内/
		);
		assert.throws(() => resolveSubmitPlan(OPTIONS, config(), { params: { duration: '5' } }), /没有自定义参数/);
	});

	test('跨渠道重名裸名报错并列出限定名，限定名可精确指定', () => {
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, config(), { model: 'gpt-image-2' }),
			/多个渠道存在.*grsai:gpt-image-2.*custom:gpt-image-2/
		);
		const plan = resolveSubmitPlan(OPTIONS, config(), { model: 'custom:gpt-image-2' });
		assert.strictEqual(plan.overrides.providerId, 'custom');
		assert.strictEqual(plan.overrides.model, 'gpt-image-2');
	});

	test('自定义模型未声明档位时显式值放行（后端不裁剪能力）', () => {
		const plan = resolveSubmitPlan(OPTIONS, config(), {
			model: 'custom:gpt-image-2',
			ratio: '7:5',
			resolution: '8K',
		});
		assert.strictEqual(plan.overrides.aspectRatio, '7:5');
		assert.strictEqual(plan.overrides.imageSize, '8K');
	});

	test('未知模型名报错并列出可用模型', () => {
		assert.throws(() => resolveSubmitPlan(OPTIONS, config(), { model: 'ghost' }), /未找到模型「ghost」/);
	});

	test('工作台当前模型失效且无 --model：报错而非静默回落首模型', () => {
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, config({ model: 'deleted-model' }), {}),
			/工作台当前模型「grsai:deleted-model」不可用/
		);
	});
});

suite('parseEditArgs', () => {
	test('prompt 必填非空，images 缺省为空数组（纯文生图）', () => {
		assert.deepStrictEqual(parseEditArgs({ prompt: '把 [a] 改成照片' }), {
			prompt: '把 [a] 改成照片',
			images: [],
		});
		assert.throws(() => parseEditArgs({}), /prompt 缺失或为空/);
		assert.throws(() => parseEditArgs({ prompt: '   ' }), /prompt 缺失或为空/);
		assert.throws(() => parseEditArgs({ prompt: 42 }), /prompt 缺失或为空/);
	});

	test('images 保序透传，非数组/含空项即抛错', () => {
		const args = parseEditArgs({ prompt: 'p', images: ['D:\\a.png', 'D:\\b.png'] });
		assert.deepStrictEqual(args.images, ['D:\\a.png', 'D:\\b.png']);
		assert.throws(() => parseEditArgs({ prompt: 'p', images: 'D:\\a.png' }), /images 须为数组/);
		assert.throws(() => parseEditArgs({ prompt: 'p', images: ['a', ''] }), /每一项须为非空字符串/);
	});

	test('复用 submit 的覆盖参数校验', () => {
		const args = parseEditArgs({ prompt: 'p', model: 'nano-banana-2', generate_num: 4 });
		assert.strictEqual(args.model, 'nano-banana-2');
		assert.strictEqual(args.generate_num, 4);
		assert.throws(() => parseEditArgs({ prompt: 'p', ratio: '' }), /ratio 须为非空字符串/);
	});
});

suite('editSubmitConfig', () => {
	/** 工作台与编辑页七个字段值两两不同的配置：误取任一工作台字段都会让断言挂掉 */
	const divergent: ImageFlowConfig = {
		...baseConfig,
		// 工作台：即梦视频模型 + 自己的参数与记忆
		providerId: 'jimeng',
		model: 'seedance2.0',
		aspectRatio: '16:9',
		imageSize: '720p',
		concurrency: 1,
		params: { duration: '8' },
		imageSizeMemory: {
			[qualifiedModel('grsai', 'nano-banana-2')]: {
				aspectRatio: '4:3',
				imageSize: '1K',
				concurrency: 2,
				params: {},
			},
		},
		// 编辑页：自定义渠道的 gpt-image-2 + 另一套参数与记忆
		editProviderId: 'custom',
		editModel: 'gpt-image-2',
		editAspectRatio: '3:4',
		editImageSize: '2K',
		editConcurrency: 6,
		editParams: { style: 'photo' },
		editImageSizeMemory: {
			[qualifiedModel('grsai', 'nano-banana-2')]: {
				aspectRatio: '9:16',
				imageSize: '4K',
				concurrency: 7,
				params: {},
			},
		},
	};

	test('七个字段全取编辑页的，一个都不串到工作台', () => {
		assert.deepStrictEqual(editSubmitConfig(divergent), {
			providerId: 'custom',
			model: 'gpt-image-2',
			aspectRatio: '3:4',
			imageSize: '2K',
			concurrency: 6,
			params: { style: 'photo' },
			imageSizeMemory: divergent.editImageSizeMemory,
		});
	});

	test('喂给 resolveSubmitPlan：无 --model 时用编辑页当前值（工作台那套一个都不串）', () => {
		const plan = resolveSubmitPlan(OPTIONS, editSubmitConfig(divergent), {}, '编辑页');
		// 同模型时 switchModelParams 先把当前值记入表再取，故当前编辑页值优先于旧快照；
		// 若误取工作台字段会得到 jimeng:seedance2.0 / 16:9 / 720p / 1 / {duration:'8'}
		assert.deepStrictEqual(plan.overrides, {
			providerId: 'custom',
			model: 'gpt-image-2',
			aspectRatio: '3:4',
			imageSize: '2K',
			concurrency: 6,
			params: {},
		});
		assert.strictEqual(plan.video, false);
	});

	test('--model 切模型时恢复的是编辑页记忆快照，不是工作台记忆', () => {
		const plan = resolveSubmitPlan(
			OPTIONS,
			editSubmitConfig(divergent),
			{ model: 'nano-banana-2' },
			'编辑页'
		);
		// 两本记忆都有 grsai:nano-banana-2 的快照且值不同：取到 9:16/4K/7 才证明读的是 editImageSizeMemory
		//（误用 imageSizeMemory 会得到 4:3 / 1K / 2）
		assert.deepStrictEqual(plan.overrides, {
			providerId: 'grsai',
			model: 'nano-banana-2',
			aspectRatio: '9:16',
			imageSize: '4K',
			concurrency: 7,
			params: {},
		});
	});

	test('越界档位收敛到该模型支持值（与侧栏切模型同一套取值）', () => {
		const plan = resolveSubmitPlan(OPTIONS, editSubmitConfig(baseConfig), {}, '编辑页');
		assert.deepStrictEqual(plan.overrides, {
			providerId: 'grsai',
			model: 'gpt-image-2',
			// 编辑页存的 16:9 / 2K 不在该模型档位内，回落首项
			aspectRatio: '1:1',
			imageSize: '1K',
			concurrency: 3,
			params: {},
		});
	});

	test('编辑页模型失效时报错文案指向编辑页', () => {
		const cfg = { ...baseConfig, editModel: 'deleted-model' };
		assert.throws(
			() => resolveSubmitPlan(OPTIONS, editSubmitConfig(cfg), {}, '编辑页'),
			/编辑页当前模型「grsai:deleted-model」不可用/
		);
	});
});

suite('normalizeSubmitId', () => {
	test('合法 id 原样返回，反斜杠写法归一化', () => {
		assert.strictEqual(normalizeSubmitId('260721/123456789'), '260721/123456789');
		assert.strictEqual(normalizeSubmitId('260721\\123456789'), '260721/123456789');
		assert.strictEqual(normalizeSubmitId(' 260721/123456789 '), '260721/123456789');
	});

	test('非法形状与非字符串返回 null', () => {
		assert.strictEqual(normalizeSubmitId('260721/12345'), null);
		assert.strictEqual(normalizeSubmitId('../etc/passwd'), null);
		assert.strictEqual(normalizeSubmitId(42), null);
		assert.strictEqual(normalizeSubmitId(undefined), null);
	});
});

suite('taskGenStatus', () => {
	test('产物齐全为 success；旧口径 requested=0 有产物也算 success', () => {
		assert.deepStrictEqual(taskGenStatus(4, 4), { gen_status: 'success' });
		assert.deepStrictEqual(taskGenStatus(0, 3), { gen_status: 'success' });
	});

	test('无产物与部分失败都报 fail 并带原因', () => {
		assert.strictEqual(taskGenStatus(4, 0).gen_status, 'fail');
		const partial = taskGenStatus(4, 2);
		assert.strictEqual(partial.gen_status, 'fail');
		assert.match(partial.fail_reason ?? '', /成功 2\/4/);
	});
});

suite('list_model 输出不泄密', () => {
	test('buildOptions 结果 JSON 化后不含 baseUrl/apiKey', () => {
		const provider: RuntimeProvider = {
			id: 'custom',
			label: '自定义',
			image: [
				{
					model: 'm1',
					label: 'M1',
					adapter: 'openai-images',
					baseUrl: 'https://secret.example.com',
					apiKey: 'sk-secret-123',
					aspectRatios: ['1:1'],
					imageSizes: ['1K'],
					maxConcurrency: 10,
					custom: [],
				},
			],
			chat: [],
		};
		const json = JSON.stringify(buildOptions([provider]));
		assert.ok(!json.includes('baseUrl'));
		assert.ok(!json.includes('apiKey'));
		assert.ok(!json.includes('sk-secret-123'));
		assert.ok(!json.includes('secret.example.com'));
	});
});
