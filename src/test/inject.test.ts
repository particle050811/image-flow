import * as assert from 'assert';
import * as vscode from 'vscode';
import { joinPrompt, modelInjection } from '../prompt/inject';
import { seedModelInjections } from '../ui/config';
import type { ImageFlowConfig } from '../shared';

const baseConfig = { modelInjections: {} } as ImageFlowConfig;

/** 极简 ExtensionContext 替身：只实现 seedModelInjections 用到的 globalState.get/update */
function fakeContext(stored: Record<string, unknown>): {
	ctx: vscode.ExtensionContext;
	read: () => Record<string, unknown>;
} {
	let state = stored;
	const ctx = {
		globalState: {
			get: () => state,
			update: async (_k: string, v: Record<string, unknown>) => {
				state = v;
			},
		},
	} as unknown as vscode.ExtensionContext;
	return { ctx, read: () => state };
}

suite('inject', () => {
	test('joinPrompt 用空行连接非空段', () => {
		assert.strictEqual(joinPrompt(['a', 'b']), 'a\n\nb');
	});
	test('joinPrompt 省略空段', () => {
		assert.strictEqual(joinPrompt(['', 'b', '']), 'b');
	});
	test('joinPrompt 全空返回空串', () => {
		assert.strictEqual(joinPrompt(['', '  ', '']), '');
	});
	test('modelInjection 读取配置中的注入句', () => {
		const cfg = { modelInjections: { 'gpt-image-2': '自定义' } } as unknown as ImageFlowConfig;
		assert.strictEqual(modelInjection(cfg, 'gpt-image-2'), '自定义');
	});
	test('modelInjection 配置无该模型返回空串', () => {
		assert.strictEqual(modelInjection(baseConfig, 'gpt-image-2'), '');
	});
	test('seedModelInjections 写入缺失的内置种子', async () => {
		const { ctx, read } = fakeContext({});
		await seedModelInjections(ctx);
		const seeded = read().modelInjections as Record<string, string>;
		assert.ok(seeded['gpt-image-2'].includes('微小细节'));
	});
	test('seedModelInjections 不覆盖已存在的值（含空串）', async () => {
		const { ctx, read } = fakeContext({ modelInjections: { 'gpt-image-2': '' } });
		await seedModelInjections(ctx);
		const after = read().modelInjections as Record<string, string>;
		assert.strictEqual(after['gpt-image-2'], '');
	});
});
