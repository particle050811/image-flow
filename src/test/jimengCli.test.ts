// 即梦 dreamina CLI 纯逻辑层测试：stdout 解析（parseDreaminaOutput）与
// 提交参数拼装（buildSubmitArgs / classifyRefs）。样例基于 2026-07 实测 CLI 输出固化。
import * as assert from 'assert';
import { parseDreaminaOutput, buildSubmitArgs, classifyRefs } from '../backend/adapters/jimengCliLogic';
import { isJimengVideoModel } from '../backend/providers';
import type { JimengVideoCap } from '../backend/providers';
import { baseConfig } from './fixtures';
import type { ImageFlowConfig } from '../shared';

function jimengConfig(patch: Partial<ImageFlowConfig>): ImageFlowConfig {
	return {
		...baseConfig,
		providerId: 'jimeng',
		model: '5.0',
		aspectRatio: '1:1',
		imageSize: '2k',
		params: {},
		...patch,
	};
}

suite('jimengCliLogic parseDreaminaOutput', () => {
	test('解析提交成功输出（JSON 前后混杂日志行）', () => {
		const stdout = '正在提交...\n{"submit_id":"550e8400-e29b","gen_status":"querying","credit_count":4}\n完成';
		const out = parseDreaminaOutput(stdout);
		assert.strictEqual(out.kind, 'ok');
		assert.strictEqual((out as { submitId?: string }).submitId, '550e8400-e29b');
		assert.strictEqual((out as { genStatus?: string }).genStatus, 'querying');
	});

	test('解析 query_result 顶层的 credit_count（成功/失败均返回；0 或缺失时不带出）', () => {
		// 视频任务成功：credit_count 顶置返回
		const ok = parseDreaminaOutput('{"submit_id":"x","gen_status":"success","credit_count":368}');
		assert.strictEqual((ok as { creditCount?: number }).creditCount, 368);
		// 视频任务失败：同样带出消耗（远端已扣费）
		const fail = parseDreaminaOutput('{"submit_id":"x","gen_status":"fail","fail_reason":"x","credit_count":20}');
		assert.strictEqual((fail as { creditCount?: number }).creditCount, 20);
		// 图片 2k（0 消耗）：字段省略，creditCount 应为 undefined
		const zero = parseDreaminaOutput('{"submit_id":"x","gen_status":"success"}');
		assert.strictEqual((zero as { creditCount?: number }).creditCount, undefined);
		// 显式 credit_count: 0（如 2k 生图命中免费额度）：保留 0，由上层 credit>0 守卫统一跳过
		const explicitZero = parseDreaminaOutput('{"submit_id":"x","gen_status":"success","credit_count":0}');
		assert.strictEqual((explicitZero as { creditCount?: number }).creditCount, 0);
		// 非数字/字符串 credit_count 不误收
		const junk = parseDreaminaOutput('{"submit_id":"x","gen_status":"success","credit_count":"368"}');
		assert.strictEqual((junk as { creditCount?: number }).creditCount, undefined);
	});

	test('解析失败态并带出 fail_reason', () => {
		const out = parseDreaminaOutput('{"submit_id":"x","gen_status":"fail","fail_reason":"积分不足"}');
		assert.strictEqual(out.kind, 'ok');
		assert.strictEqual((out as { genStatus?: string }).genStatus, 'fail');
		assert.strictEqual((out as { failReason?: string }).failReason, '积分不足');
	});

	test('未登录输出识别为 not-logged-in（stderr 同样生效）', () => {
		assert.strictEqual(parseDreaminaOutput('未检测到有效登录态，请先运行 dreamina login').kind, 'not-logged-in');
		assert.strictEqual(parseDreaminaOutput('', 'Error: not logged in').kind, 'not-logged-in');
	});

	test('非 JSON 输出归为 unparsed 并保留原文', () => {
		const out = parseDreaminaOutput('curl: (7) Failed to connect');
		assert.strictEqual(out.kind, 'unparsed');
		assert.ok((out as { raw: string }).raw.includes('Failed to connect'));
	});

	test('花括号存在但 JSON 损坏时归为 unparsed', () => {
		assert.strictEqual(parseDreaminaOutput('{"submit_id": 截断').kind, 'unparsed');
	});

	test('多段 JSON 时取带业务字段的那段（结果 JSON 在末尾）', () => {
		const stdout = '{"level":"info","msg":"uploading"}\n{"submit_id":"abc","gen_status":"success"}';
		const out = parseDreaminaOutput(stdout);
		assert.strictEqual(out.kind, 'ok');
		assert.strictEqual((out as { submitId?: string }).submitId, 'abc');
	});

	test('日志行含花括号 / 字符串里带 } 不干扰结果 JSON 提取', () => {
		const stdout = 'progress {50%}\n{"submit_id":"xyz","gen_status":"querying","note":"含}括号\\"引号"}\ndone';
		const out = parseDreaminaOutput(stdout);
		assert.strictEqual(out.kind, 'ok');
		assert.strictEqual((out as { submitId?: string }).submitId, 'xyz');
		assert.strictEqual((out as { genStatus?: string }).genStatus, 'querying');
	});
});

suite('jimengCliLogic buildSubmitArgs 生图', () => {
	test('无参考图走 text2image，count 映射 generate_num', () => {
		const args = buildSubmitArgs(jimengConfig({}), '一只猫', [], 4);
		assert.strictEqual(args[0], 'text2image');
		assert.ok(args.includes('--prompt=一只猫'));
		assert.ok(args.includes('--model_version=5.0'));
		assert.ok(args.includes('--ratio=1:1'));
		assert.ok(args.includes('--resolution_type=2k'));
		assert.ok(args.includes('--generate_num=4'));
		assert.ok(args.includes('--poll=0'));
	});

	test('有参考图走 image2image，路径逗号拼接', () => {
		const args = buildSubmitArgs(jimengConfig({}), 'p', ['D:\\a.png', 'D:\\b.jpg'], 1);
		assert.strictEqual(args[0], 'image2image');
		assert.ok(args.includes('--images=D:\\a.png,D:\\b.jpg'));
		assert.ok(args.includes('--generate_num=1'));
	});

	test('generate_num 钳制到 1-10', () => {
		assert.ok(buildSubmitArgs(jimengConfig({}), 'p', [], 99).includes('--generate_num=10'));
		assert.ok(buildSubmitArgs(jimengConfig({}), 'p', [], 0).includes('--generate_num=1'));
	});

	test('参考图超 10 张报错；混入音视频报错', () => {
		const many = Array.from({ length: 11 }, (_, i) => `D:\\${i}.png`);
		assert.throws(() => buildSubmitArgs(jimengConfig({}), 'p', many, 1), /最多 10 张/);
		assert.throws(() => buildSubmitArgs(jimengConfig({}), 'p', ['D:\\a.mp4'], 1), /仅支持图片参考/);
	});
});

suite('jimengCliLogic buildSubmitArgs 视频（全能参考）', () => {
	const videoConfig = () =>
		jimengConfig({ model: 'seedance2.0fast', aspectRatio: '16:9', imageSize: '720p', params: { duration: '6' } });

	test('素材按类型分发 --image/--video/--audio，参数齐全', () => {
		const args = buildSubmitArgs(videoConfig(), '镜头推进', ['D:\\a.png', 'D:\\ref.mp4', 'D:\\bgm.mp3'], 1);
		assert.strictEqual(args[0], 'multimodal2video');
		assert.ok(args.includes('--image=D:\\a.png'));
		assert.ok(args.includes('--video=D:\\ref.mp4'));
		assert.ok(args.includes('--audio=D:\\bgm.mp3'));
		assert.ok(args.includes('--model_version=seedance2.0fast'));
		assert.ok(args.includes('--ratio=16:9'));
		assert.ok(args.includes('--video_resolution=720p'));
		assert.ok(args.includes('--duration=6'));
		assert.ok(args.includes('--poll=0'));
	});

	test('duration 缺省 5', () => {
		const config = jimengConfig({ model: 'seedance2.0', imageSize: '720p' });
		assert.ok(buildSubmitArgs(config, 'p', ['D:\\a.png'], 1).includes('--duration=5'));
	});

	test('无图片且无视频素材报错（音频不算）', () => {
		assert.throws(() => buildSubmitArgs(videoConfig(), 'p', [], 1), /至少一张图片或一段视频/);
		assert.throws(() => buildSubmitArgs(videoConfig(), 'p', ['D:\\bgm.mp3'], 1), /至少一张图片或一段视频/);
	});

	test('分类型上限：图>9 / 视频>3 / 音频>3 报错', () => {
		const images10 = Array.from({ length: 10 }, (_, i) => `D:\\${i}.png`);
		assert.throws(() => buildSubmitArgs(videoConfig(), 'p', images10, 1), /图片 10\/9/);
		const videos4 = ['D:\\a.png', 'D:\\1.mp4', 'D:\\2.mp4', 'D:\\3.mp4', 'D:\\4.mp4'];
		assert.throws(() => buildSubmitArgs(videoConfig(), 'p', videos4, 1), /视频 4\/3/);
	});
});

suite('jimengCliLogic buildSubmitArgs 视频（seedance2.5 放宽）', () => {
	const video25 = () =>
		jimengConfig({ model: 'seedance2.5', aspectRatio: '16:9', imageSize: '720p', params: { duration: '10' } });
	// seedance2.5 的能力片段（与 media/jimeng-models.jsonc 一致）：纯音频许可 + 放宽上限
	const caps25: JimengVideoCap = { max: { image: 30, video: 10, audio: 10 }, allowAudioOnly: true };
	// 旧 seedance 家族基线（纯音频应被拒）
	const legacyVideo = () => jimengConfig({ model: 'seedance2.0', aspectRatio: '16:9', imageSize: '720p' });

	test('seedance2.5 允许纯音频参考（其余家族拒绝）', () => {
		const args = buildSubmitArgs(video25(), 'p', ['D:\\bgm.mp3'], 1, caps25);
		assert.strictEqual(args[0], 'multimodal2video');
		assert.ok(args.includes('--audio=D:\\bgm.mp3'));
		assert.ok(args.includes('--model_version=seedance2.5'));
		// 旧模型纯音频仍报错（不传 caps 回落默认上限）
		assert.throws(() => buildSubmitArgs(legacyVideo(), 'p', ['D:\\bgm.mp3'], 1), /至少一张图片或一段视频/);
	});

	test('seedance2.5 素材上限放宽到 图30/视频10/音频10', () => {
		const images31 = Array.from({ length: 31 }, (_, i) => `D:\\${i}.png`);
		assert.throws(() => buildSubmitArgs(video25(), 'p', images31, 1, caps25), /图片 31\/30/);
		// 图 30 张不报错
		const images30 = Array.from({ length: 30 }, (_, i) => `D:\\${i}.png`);
		assert.doesNotThrow(() => buildSubmitArgs(video25(), 'p', images30, 1, caps25));
		// 视频 10 个 + 音频 10 个不报错；11 个报错
		const videos10 = Array.from({ length: 10 }, (_, i) => `D:\\${i}.mp4`);
		const audios10 = Array.from({ length: 10 }, (_, i) => `D:\\${i}.mp3`);
		assert.doesNotThrow(() => buildSubmitArgs(video25(), 'p', [...videos10, ...audios10], 1, caps25));
		const videos11 = Array.from({ length: 11 }, (_, i) => `D:\\${i}.mp4`);
		assert.throws(() => buildSubmitArgs(video25(), 'p', videos11, 1, caps25), /视频 11\/10/);
	});
});

suite('jimeng 辅助判定', () => {
	test('classifyRefs 按扩展名分桶且保持顺序', () => {
		const { images, videos, audios } = classifyRefs(['D:\\b.png', 'D:\\a.mp4', 'D:\\c.wav', 'D:\\d.jpg']);
		assert.deepStrictEqual(images, ['D:\\b.png', 'D:\\d.jpg']);
		assert.deepStrictEqual(videos, ['D:\\a.mp4']);
		assert.deepStrictEqual(audios, ['D:\\c.wav']);
	});

	test('isJimengVideoModel 按 seedance 前缀判定', () => {
		assert.ok(isJimengVideoModel('seedance2.0fast'));
		assert.ok(!isJimengVideoModel('5.0'));
	});
});
