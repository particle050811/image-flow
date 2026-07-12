import * as assert from 'assert';
import * as vscode from 'vscode';
import { editConfigView, readConfig, writeConfig } from '../ui/config';
import { switchModelParams, modelSizeControl, qualifiedModel, splitQualifiedModel, findImageModel } from '../modelOptions';
import { buildOptions, BUILTIN_GRSAI, BUILTIN_JIMENG } from '../backend/providers';
import type { ImageFlowConfig } from '../shared';
import { baseConfig } from './fixtures';

// 内置 grsai 派生的 ConfigOptions，供 modelOptions 各函数测试复用
const CONFIG_OPTIONS = buildOptions([BUILTIN_GRSAI]);

suite('qualifiedModel', () => {
	test('拼接与拆分互逆；非法值当作 grsai 裸模型名', () => {
		const q = qualifiedModel('custom', 'gpt-image-2');
		assert.deepStrictEqual(splitQualifiedModel(q), { provider: 'custom', model: 'gpt-image-2' });
		assert.deepStrictEqual(splitQualifiedModel('nano-banana-2'), { provider: 'grsai', model: 'nano-banana-2' });
	});
});

suite('findImageModel', () => {
	test('按 (渠道, 模型) 精确命中；找不到先回落同渠道首个，渠道不可用再回落全局首个', () => {
		assert.strictEqual(findImageModel(CONFIG_OPTIONS, 'grsai', 'gpt-image-2')?.label, 'GPT Image 2');
		// 同渠道回落：模型被删仍留在 grsai 内（与后端 resolveImageCall 一致）
		assert.strictEqual(findImageModel(CONFIG_OPTIONS, 'grsai', '已删除的模型')?.model, 'nano-banana-2');
		// 渠道整个不可用（无 custom 项）→ 回落全局首个
		assert.strictEqual(findImageModel(CONFIG_OPTIONS, 'custom', '不存在')?.model, 'nano-banana-2');
	});
});

suite('switchModelParams', () => {
	const NANO = qualifiedModel('grsai', 'nano-banana-2');
	const GPT = qualifiedModel('grsai', 'gpt-image-2');
	const nanoModel = findImageModel(CONFIG_OPTIONS, 'grsai', 'nano-banana-2')!;
	const gptModel = findImageModel(CONFIG_OPTIONS, 'grsai', 'gpt-image-2')!;
	const snap = (aspectRatio: string, imageSize: string, params: Record<string, string> = {}) =>
		({ aspectRatio, imageSize, params });
	test('切到受限模型回退首档，旧模型整套参数记入记忆', () => {
		const r = switchModelParams(gptModel, {}, NANO, snap('3:4', '4K'), GPT);
		assert.strictEqual(r.snapshot.imageSize, '1K');
		assert.strictEqual(r.snapshot.aspectRatio, '3:4'); // gpt-image-2 支持 3:4 → 保留
		assert.deepStrictEqual(r.memory[NANO], snap('3:4', '4K'));
	});
	test('切回原模型恢复其独立参数（4K 与比例都不丢）', () => {
		const r = switchModelParams(nanoModel, { [NANO]: snap('16:9', '4K') }, GPT, snap('3:4', '1K'), NANO);
		assert.strictEqual(r.snapshot.imageSize, '4K');
		assert.strictEqual(r.snapshot.aspectRatio, '16:9');
		assert.deepStrictEqual(r.memory[GPT], snap('3:4', '1K'));
	});
	test('切到未访问且兼容的模型沿用当前参数', () => {
		const r = switchModelParams(nanoModel, {}, GPT, snap('1:1', '2K'), NANO);
		assert.strictEqual(r.snapshot.imageSize, '2K');
		assert.strictEqual(r.snapshot.aspectRatio, '1:1');
	});
	test('旧配置的裸字符串记忆值当作无记忆，不抛错', () => {
		const legacy = { [NANO]: '4K' as unknown as import('../shared').ModelParamSnapshot };
		const r = switchModelParams(nanoModel, legacy, GPT, snap('3:4', '1K'), NANO);
		assert.strictEqual(r.snapshot.imageSize, '1K'); // 沿用当前值而非崩溃
	});
	test('自定义参数逐键校验：记忆值失效用默认值', () => {
		const custom = { ...gptModel, custom: [{ key: 'q', label: 'Q', options: ['low', 'high'], default: 'low' }] };
		const r = switchModelParams(custom, { [GPT]: snap('3:4', '1K', { q: '已下线档位' }) }, NANO, snap('3:4', '4K'), GPT);
		assert.deepStrictEqual(r.snapshot.params, { q: 'low' });
		const r2 = switchModelParams(custom, { [GPT]: snap('3:4', '1K', { q: 'high' }) }, NANO, snap('3:4', '4K'), GPT);
		assert.deepStrictEqual(r2.snapshot.params, { q: 'high' });
	});
	test('并发随模型联动：无记忆兜底 4（不沿用当前值），有记忆恢复记忆', () => {
		// 无记忆且模型无自带默认 → 兜底 4，不沿用当前 6——否则视频模型的并发 1 会泄漏给图片模型
		const r = switchModelParams(gptModel, {}, NANO, { ...snap('3:4', '4K'), concurrency: 6 }, GPT);
		assert.strictEqual(r.snapshot.concurrency, 4);
		// 有记忆：恢复记忆值
		const mem = { [GPT]: { ...snap('3:4', '1K'), concurrency: 2 } };
		const r2 = switchModelParams(gptModel, mem, NANO, { ...snap('3:4', '4K'), concurrency: 6 }, GPT);
		assert.strictEqual(r2.snapshot.concurrency, 2);
	});
});

suite('switchModelParams：即梦视频模型默认参数', () => {
	const OPTS = buildOptions([BUILTIN_GRSAI, BUILTIN_JIMENG]);
	const NANO = qualifiedModel('grsai', 'nano-banana-2');
	const SEED_VIP = qualifiedModel('jimeng', 'seedance2.0_vip');
	const videoVip = findImageModel(OPTS, 'jimeng', 'seedance2.0_vip')!;
	test('无记忆切入用模型默认 16:9/720p/并发1（默认值优先于沿用当前值）', () => {
		// 当前 1:1 与 4k 都在 VIP 支持列表内，但模型默认应胜出
		const r = switchModelParams(
			videoVip, {}, NANO,
			{ aspectRatio: '1:1', imageSize: '4k', concurrency: 8, params: {} },
			SEED_VIP
		);
		assert.strictEqual(r.snapshot.aspectRatio, '16:9');
		assert.strictEqual(r.snapshot.imageSize, '720p');
		assert.strictEqual(r.snapshot.concurrency, 1);
		assert.deepStrictEqual(r.snapshot.params, { duration: '5' }); // 时长播种默认值
	});
	test('有记忆恢复记忆，并发夹进视频上限 4', () => {
		const mem = { [SEED_VIP]: { aspectRatio: '9:16', imageSize: '1080p', concurrency: 8, params: { duration: '6' } } };
		const r = switchModelParams(
			videoVip, mem, NANO,
			{ aspectRatio: '1:1', imageSize: '2k', concurrency: 2, params: {} },
			SEED_VIP
		);
		assert.strictEqual(r.snapshot.aspectRatio, '9:16');
		assert.strictEqual(r.snapshot.imageSize, '1080p');
		assert.strictEqual(r.snapshot.concurrency, 4); // 记忆 8 超上限 → 夹到 4
		assert.deepStrictEqual(r.snapshot.params, { duration: '6' });
	});
	test('即梦生图只保留 5.0；视频模型带 video 标记且并发上限 4', () => {
		const jimengImages = OPTS.imageModels.filter((m) => m.provider === 'jimeng' && !m.video);
		assert.deepStrictEqual(jimengImages.map((m) => m.model), ['5.0']);
		const videos = OPTS.imageModels.filter((m) => m.video);
		assert.ok(videos.length >= 5);
		assert.ok(videos.every((m) => m.maxConcurrency === 4));
	});
});

suite('modelSizeControl', () => {
	test('工作台组：切模型一次性写回七键（单条 patch），比例越界回退首项', () => {
		const patches: Partial<ImageFlowConfig>[] = [];
		const { current, changeModel } = modelSizeControl(
			baseConfig,
			CONFIG_OPTIONS,
			{ provider: 'providerId', model: 'model', size: 'imageSize', ratio: 'aspectRatio', concurrency: 'concurrency', memory: 'imageSizeMemory', params: 'params' },
			(p) => patches.push(p)
		);
		assert.deepStrictEqual(current?.imageSizes, ['1K', '2K', '4K']);
		changeModel(qualifiedModel('grsai', 'gpt-image-2'));
		// 只发一条 patch，七键齐全、值正确（内置 grsai 无自定义参数 → params 为空；3:4 受支持 → 比例保留；
		// 新模型无记忆无自带默认 → 并发兜底 4，不沿用切换前的 1）
		assert.strictEqual(patches.length, 1);
		assert.deepStrictEqual(patches[0], {
			providerId: 'grsai',
			model: 'gpt-image-2',
			imageSize: '1K',
			aspectRatio: '3:4',
			concurrency: 4,
			imageSizeMemory: {
				[qualifiedModel('grsai', 'nano-banana-2')]: { aspectRatio: '3:4', imageSize: '1K', concurrency: 1, params: {} },
			},
			params: {},
		});
	});
	test('编辑组：用 editProviderId/editModel/editImageSize/editAspectRatio/editConcurrency/editImageSizeMemory 键', () => {
		const patches: Partial<ImageFlowConfig>[] = [];
		const { current, changeModel } = modelSizeControl(
			baseConfig,
			CONFIG_OPTIONS,
			{ provider: 'editProviderId', model: 'editModel', size: 'editImageSize', ratio: 'editAspectRatio', concurrency: 'editConcurrency', memory: 'editImageSizeMemory', params: 'editParams' },
			(p) => patches.push(p)
		);
		assert.deepStrictEqual(current?.imageSizes, ['1K']); // editModel=gpt-image-2 仅 1K
		changeModel(qualifiedModel('grsai', 'nano-banana-2'));
		assert.strictEqual(patches.length, 1);
		assert.deepStrictEqual(patches[0], {
			editProviderId: 'grsai',
			editModel: 'nano-banana-2',
			editImageSize: '2K',
			editAspectRatio: '16:9',
			// 新模型无记忆无自带默认 → 并发兜底 4（旧模型的 3 只进记忆，不带给新模型）
			editConcurrency: 4,
			editImageSizeMemory: {
				[qualifiedModel('grsai', 'gpt-image-2')]: { aspectRatio: '16:9', imageSize: '2K', concurrency: 3, params: {} },
			},
			editParams: {},
		});
	});
});

suite('editConfigView', () => {
	test('用编辑专属参数覆盖主参数，其余字段保留', () => {
		const view = editConfigView({ ...baseConfig, editParams: { quality: 'low' }, editProviderId: 'custom' });
		assert.strictEqual(view.model, 'gpt-image-2');
		assert.strictEqual(view.providerId, 'custom');
		assert.strictEqual(view.aspectRatio, '16:9');
		assert.strictEqual(view.imageSize, '2K');
		assert.strictEqual(view.concurrency, 3);
		assert.deepStrictEqual(view.params, { quality: 'low' });
		assert.strictEqual(view.apiKey, 'k');
		assert.strictEqual(view.baseUrl, 'https://example.com');
	});
});
suite('readConfig 渠道字段迁移', () => {
	const makeContext = (initial: Record<string, unknown>) => {
		let stored = initial;
		return {
			context: {
				globalState: {
					get: () => stored,
					update: async (_key: string, value: Record<string, unknown>) => {
						stored = value;
					},
				},
				secrets: { get: async () => 'k', store: async () => {} },
			} as unknown as vscode.ExtensionContext,
			getStored: () => stored,
		};
	};
	test('旧配置首读把 providerId 带给编辑页/命名并落盘，之后工作台切渠道不再影响两者', async () => {
		const { context, getStored } = makeContext({ providerId: 'custom' });
		const first = await readConfig(context);
		assert.strictEqual(first.editProviderId, 'custom');
		assert.strictEqual(first.namingProviderId, 'custom');
		// 迁移已落盘（只发生一次）
		assert.strictEqual(getStored().editProviderId, 'custom');
		// 模拟工作台切回 grsai 模型
		await writeConfig(context, { providerId: 'grsai' });
		const second = await readConfig(context);
		assert.strictEqual(second.providerId, 'grsai');
		assert.strictEqual(second.editProviderId, 'custom'); // 不被工作台操作改写
		assert.strictEqual(second.namingProviderId, 'custom');
	});
	test('已迁移过的配置不再改写', async () => {
		const { context } = makeContext({ providerId: 'custom', editProviderId: 'grsai', namingProviderId: 'grsai' });
		const cfg = await readConfig(context);
		assert.strictEqual(cfg.editProviderId, 'grsai');
	});
});
