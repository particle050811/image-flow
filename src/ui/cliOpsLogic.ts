// CLI 桥新命令（submit/query_result/list_task）的纯逻辑：参数解析、目标模型定位、
// 按次覆盖参数的取值与校验、任务终态判定。禁止引入 vscode/node IO——供直测。
// 桥侧 IO 编排在 cliBridge.ts（与 cliBridgeLogic.ts 的分工方式一致）。

import type { ConfigOptions, ImageFlowConfig, WebviewImageModel } from '../shared';
import { qualifiedModel, switchModelParams } from '../modelOptions';

/** CLI submit 的按次覆盖参数（壳侧 --flag 解析结果，全部可缺省） */
export interface CliSubmitArgs {
	/** 裸模型名或 "provider:model" 限定名 */
	model?: string;
	ratio?: string;
	resolution?: string;
	generate_num?: number;
	/** 模型自定义参数覆盖（如视频 duration），按模型声明的可选项校验 */
	params?: Record<string, string>;
}

/** CLI edit 的参数：提示词 + 参考图路径（顺序即编号）+ 与 submit 同款的按次覆盖参数 */
export interface CliEditArgs extends CliSubmitArgs {
	prompt: string;
	/** 参考图绝对路径（壳侧已按 cwd 解析），顺序即上传编号；可为空（纯文生图） */
	images: string[];
}

/** submit 计划所需的配置切片（readConfig 结果的子集，纯逻辑不吃完整 config） */
export type CliSubmitConfig = Pick<
	ImageFlowConfig,
	'providerId' | 'model' | 'aspectRatio' | 'imageSize' | 'concurrency' | 'params' | 'imageSizeMemory'
>;

/**
 * 编辑页参数切片：CLI edit 的基线取编辑页那套配置（不是工作台的），
 * 连参数记忆也用 editImageSizeMemory——`edit --model=X` 因此等价「编辑页切到 X 点生成」。
 */
export function editSubmitConfig(config: ImageFlowConfig): CliSubmitConfig {
	return {
		providerId: config.editProviderId,
		model: config.editModel,
		aspectRatio: config.editAspectRatio,
		imageSize: config.editImageSize,
		concurrency: config.editConcurrency,
		params: config.editParams,
		imageSizeMemory: config.editImageSizeMemory,
	};
}

/** 喂给 TaskManager.submit 的按次覆盖集：浅覆盖 readConfig 结果，不落盘、不影响工作台配置 */
export type SubmitOverrides = Pick<
	ImageFlowConfig,
	'providerId' | 'model' | 'aspectRatio' | 'imageSize' | 'concurrency' | 'params'
>;

/** submit 参数解析结果：覆盖集 + 回显所需的模型信息 */
export interface CliSubmitPlan {
	overrides: SubmitOverrides;
	/** 目标是否视频模型（回显 + videoOnlyVmd 防误触判定） */
	video: boolean;
}

/**
 * 把外部进程送来的原始 args 收窄为 CliSubmitArgs：字段类型非法直接抛错（由调用方转 gen_status:fail）。
 * 请求来自本机任意进程，逐项校验而非裸信任。
 */
export function parseSubmitArgs(raw: unknown): CliSubmitArgs {
	const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const args: CliSubmitArgs = {};
	for (const key of ['model', 'ratio', 'resolution'] as const) {
		const v = obj[key];
		if (v !== undefined) {
			if (typeof v !== 'string' || !v) {
				throw new Error(`参数 ${key} 须为非空字符串`);
			}
			args[key] = v;
		}
	}
	if (obj.generate_num !== undefined) {
		if (typeof obj.generate_num !== 'number' || !Number.isFinite(obj.generate_num)) {
			throw new Error('参数 generate_num 须为数字');
		}
		args.generate_num = obj.generate_num;
	}
	if (obj.params !== undefined) {
		if (!obj.params || typeof obj.params !== 'object' || Array.isArray(obj.params)) {
			throw new Error('参数 params 须为对象（{key: value}）');
		}
		const params: Record<string, string> = {};
		for (const [k, v] of Object.entries(obj.params)) {
			if (typeof v !== 'string') {
				throw new Error(`自定义参数「${k}」的值须为字符串`);
			}
			params[k] = v;
		}
		args.params = params;
	}
	return args;
}

/**
 * 把 edit 的原始 args 收窄为 CliEditArgs：复用 parseSubmitArgs 校验覆盖参数，
 * 另校验 prompt（必填非空）与 images（字符串数组，可空——无图即纯文生图）。
 */
export function parseEditArgs(raw: unknown): CliEditArgs {
	const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const prompt = obj.prompt;
	if (typeof prompt !== 'string' || !prompt.trim()) {
		throw new Error('参数 prompt 缺失或为空（编辑模式的提示词正文）');
	}
	let images: string[] = [];
	if (obj.images !== undefined) {
		if (!Array.isArray(obj.images)) {
			throw new Error('参数 images 须为数组（参考图路径，按顺序编号）');
		}
		images = obj.images.map((p) => {
			if (typeof p !== 'string' || !p) {
				throw new Error('参数 images 的每一项须为非空字符串（参考图路径）');
			}
			return p;
		});
	}
	return { ...parseSubmitArgs(obj), prompt, images };
}

/** 全部可用模型的限定名列表（报错提示用） */
function allQualified(options: ConfigOptions): string {
	return options.imageModels.map((m) => `${m.provider}:${m.model}`).join('、');
}

/**
 * 定位目标模型：无 --model 用基线当前 (渠道, 模型)，失效即报错（不学 resolveImageCall
 * 静默回落首模型——CLI 场景「没要求却用了意外模型」必须暴露）；有 --model 先按裸名全渠道精确匹配，
 * 唯一命中即用，跨渠道重名要求 "provider:model" 限定名。
 * originLabel 是基线来源（submit=工作台 / edit=编辑页），只用于报错文案指对地方。
 */
function findTargetModel(
	options: ConfigOptions,
	config: CliSubmitConfig,
	rawModel: string | undefined,
	originLabel: string
): WebviewImageModel {
	if (rawModel === undefined) {
		const current = options.imageModels.find(
			(m) => m.provider === config.providerId && m.model === config.model
		);
		if (!current) {
			throw new Error(
				`${originLabel}当前模型「${config.providerId}:${config.model}」不可用（可能已被删除或改名），` +
					'请在侧栏重选模型，或用 --model 显式指定。'
			);
		}
		return current;
	}
	const bare = options.imageModels.filter((m) => m.model === rawModel);
	if (bare.length === 1) {
		return bare[0];
	}
	if (bare.length > 1) {
		throw new Error(
			`模型「${rawModel}」在多个渠道存在，请用限定名指定：${bare.map((m) => `${m.provider}:${m.model}`).join(' / ')}`
		);
	}
	const colon = rawModel.indexOf(':');
	if (colon > 0) {
		const qualified = options.imageModels.find(
			(m) => m.provider === rawModel.slice(0, colon) && m.model === rawModel.slice(colon + 1)
		);
		if (qualified) {
			return qualified;
		}
	}
	throw new Error(`未找到模型「${rawModel}」。可用模型：${allQualified(options)}`);
}

/**
 * 解析 submit 的按次覆盖参数为完整覆盖集。
 * 基线复用侧栏切模型逻辑（switchModelParams + 真实 imageSizeMemory，只读不写）：
 * --model=X 等价于「侧栏切到 X 点生成」——X 有参数快照恢复快照，无快照按模型默认 → 当前值（受支持）→ 档位首项。
 * 显式 flag 最优先且严格校验档位：非法直接抛错（转 gen_status:fail），绝不静默回落——
 * 让调用方立刻发现误用，而不是拿到一张参数悄悄被换掉的图。
 */
export function resolveSubmitPlan(
	options: ConfigOptions,
	config: CliSubmitConfig,
	args: CliSubmitArgs,
	originLabel = '工作台'
): CliSubmitPlan {
	const target = findTargetModel(options, config, args.model, originLabel);
	const { snapshot } = switchModelParams(
		target,
		config.imageSizeMemory,
		qualifiedModel(config.providerId, config.model),
		{
			aspectRatio: config.aspectRatio,
			imageSize: config.imageSize,
			concurrency: config.concurrency,
			params: config.params,
		},
		qualifiedModel(target.provider, target.model)
	);

	let aspectRatio = snapshot.aspectRatio;
	if (args.ratio !== undefined) {
		// 自定义模型可不声明档位（空列表 = 后端不裁剪能力），此时显式值直接放行
		if (target.aspectRatios.length && !target.aspectRatios.includes(args.ratio)) {
			throw new Error(
				`模型「${target.model}」不支持比例「${args.ratio}」，可选：${target.aspectRatios.join('、')}`
			);
		}
		aspectRatio = args.ratio;
	}

	let imageSize = snapshot.imageSize;
	if (args.resolution !== undefined) {
		if (target.imageSizes.length && !target.imageSizes.includes(args.resolution)) {
			throw new Error(
				`模型「${target.model}」不支持分辨率「${args.resolution}」，可选：${target.imageSizes.join('、')}`
			);
		}
		imageSize = args.resolution;
	}

	// switchModelParams 恒有 concurrency，?? 仅为收窄快照类型上的可选字段（旧配置快照可缺省）
	let concurrency = snapshot.concurrency ?? Math.max(1, Math.min(target.maxConcurrency, config.concurrency));
	if (args.generate_num !== undefined) {
		if (
			!Number.isInteger(args.generate_num) ||
			args.generate_num < 1 ||
			args.generate_num > target.maxConcurrency
		) {
			throw new Error(`generate_num 须为 1~${target.maxConcurrency} 的整数（模型「${target.model}」）`);
		}
		concurrency = args.generate_num;
	}

	const params = { ...snapshot.params };
	for (const [k, v] of Object.entries(args.params ?? {})) {
		const decl = target.custom.find((c) => c.key === k);
		if (!decl) {
			const hint = target.custom.length
				? `，可选参数：${target.custom.map((c) => c.key).join('、')}`
				: '（该模型无可调自定义参数）';
			throw new Error(`模型「${target.model}」没有自定义参数「${k}」${hint}`);
		}
		if (decl.options.length && !decl.options.includes(v)) {
			throw new Error(`参数「${k}」的值「${v}」不在可选项内：${decl.options.join('、')}`);
		}
		params[k] = v;
	}

	return {
		overrides: {
			providerId: target.provider,
			model: target.model,
			aspectRatio,
			imageSize,
			concurrency,
			params,
		},
		video: !!target.video,
	};
}

/** 校验并归一化 submit_id（"yyMMdd/HHmmssSSS"，容忍反斜杠写法）；非法返回 null */
export function normalizeSubmitId(raw: unknown): string | null {
	if (typeof raw !== 'string') {
		return null;
	}
	const id = raw.trim().replace(/\\/g, '/');
	return /^\d{6}\/\d{9}$/.test(id) ? id : null;
}

/** 已终结任务的成败判定：以盘上产物数为准（比 meta.succeeded 更硬），部分失败按 fail 报但产物照给 */
export function taskGenStatus(
	requested: number,
	produced: number
): { gen_status: 'success' | 'fail'; fail_reason?: string } {
	if (produced === 0) {
		return { gen_status: 'fail', fail_reason: '任务已终结但无产物（生成失败）' };
	}
	if (produced < requested) {
		return { gen_status: 'fail', fail_reason: `部分失败：成功 ${produced}/${requested}` };
	}
	return { gen_status: 'success' };
}
