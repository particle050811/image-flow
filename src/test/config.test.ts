import * as assert from 'assert';
import { editConfigView } from '../ui/config';
import { supportedSizes, switchModelSize, modelSizeControl } from '../modelOptions';
import { buildOptions, BUILTIN_GRSAI } from '../backend/providers';
import type { ImageFlowConfig } from '../shared';
import { baseConfig } from './fixtures';

// 内置 grsai 派生的 ConfigOptions，供 supportedSizes/switchModelSize/modelSizeControl 测试复用
const CONFIG_OPTIONS = buildOptions(BUILTIN_GRSAI);

suite('supportedSizes', () => {
	test('受限模型只列支持档位，其余回退全集', () => {
		assert.deepStrictEqual(supportedSizes(CONFIG_OPTIONS, 'gpt-image-2'), ['1K']);
		assert.deepStrictEqual(supportedSizes(CONFIG_OPTIONS, 'nano-banana-2'), ['1K', '2K', '4K']);
	});
});

suite('switchModelSize', () => {
	test('切到受限模型回退首档，旧模型分辨率记入记忆', () => {
		const r = switchModelSize(CONFIG_OPTIONS, {}, 'nano-banana-2', '4K', 'gpt-image-2');
		assert.strictEqual(r.size, '1K');
		assert.strictEqual(r.memory['nano-banana-2'], '4K');
	});
	test('切回原模型恢复其独立分辨率（4K 不丢）', () => {
		const r = switchModelSize(
			CONFIG_OPTIONS,
			{ 'nano-banana-2': '4K' },
			'gpt-image-2',
			'1K',
			'nano-banana-2'
		);
		assert.strictEqual(r.size, '4K');
		assert.strictEqual(r.memory['gpt-image-2'], '1K');
	});
	test('切到未访问且兼容的模型沿用当前分辨率', () => {
		const r = switchModelSize(CONFIG_OPTIONS, {}, 'nano-banana-2', '2K', 'nano-banana-pro');
		assert.strictEqual(r.size, '2K');
	});
});

suite('modelSizeControl', () => {
	test('工作台组：切模型一次性写回三键（单条 patch）', () => {
		const patches: Partial<ImageFlowConfig>[] = [];
		const { sizeOptions, changeModel } = modelSizeControl(
			baseConfig,
			CONFIG_OPTIONS,
			{ model: 'model', size: 'imageSize', memory: 'imageSizeMemory', params: 'params' },
			(p) => patches.push(p)
		);
		assert.deepStrictEqual(sizeOptions, ['1K', '2K', '4K']);
		changeModel('gpt-image-2');
		// 只发一条 patch（F059：原 3 次 onChange 收敛为 1 次），且四键齐全、值正确（内置 grsai 无自定义参数 → params 为空）
		assert.strictEqual(patches.length, 1);
		assert.deepStrictEqual(patches[0], {
			model: 'gpt-image-2',
			imageSize: '1K',
			imageSizeMemory: { 'nano-banana-2': '1K' },
			params: {},
		});
	});
	test('编辑组：用 editModel/editImageSize/editImageSizeMemory 三键', () => {
		const patches: Partial<ImageFlowConfig>[] = [];
		const { sizeOptions, changeModel } = modelSizeControl(
			baseConfig,
			CONFIG_OPTIONS,
			{ model: 'editModel', size: 'editImageSize', memory: 'editImageSizeMemory', params: 'editParams' },
			(p) => patches.push(p)
		);
		assert.deepStrictEqual(sizeOptions, ['1K']); // editModel=gpt-image-2 仅 1K
		changeModel('nano-banana-2');
		assert.strictEqual(patches.length, 1);
		assert.deepStrictEqual(patches[0], {
			editModel: 'nano-banana-2',
			editImageSize: '2K',
			editImageSizeMemory: { 'gpt-image-2': '2K' },
			editParams: {},
		});
	});
});

suite('editConfigView', () => {
	test('用编辑专属参数覆盖主参数，其余字段保留', () => {
		const view = editConfigView({ ...baseConfig, editParams: { quality: 'low' } });
		assert.strictEqual(view.model, 'gpt-image-2');
		assert.strictEqual(view.aspectRatio, '16:9');
		assert.strictEqual(view.imageSize, '2K');
		assert.strictEqual(view.concurrency, 3);
		assert.deepStrictEqual(view.params, { quality: 'low' });
		assert.strictEqual(view.apiKey, 'k');
		assert.strictEqual(view.baseUrl, 'https://example.com');
	});
});
