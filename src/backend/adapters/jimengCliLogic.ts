// 即梦 dreamina CLI 的纯逻辑层：stdout 解析与命令行参数拼装。
// 不做任何 IO / 子进程调用（那些在 jimengCli.ts），便于单测锁定行为。

import * as path from 'path';
import { mediaTypeOf } from '../../util/images';
import type { ImageFlowConfig } from '../../shared';
import { isJimengVideoModel } from '../providers';

/** 解析结果：ok = 拿到结构化 JSON；not-logged-in = 明确未登录；unparsed = 找不到合法 JSON */
export type DreaminaOutput =
	| { kind: 'ok'; submitId?: string; genStatus?: string; failReason?: string }
	| { kind: 'not-logged-in' }
	| { kind: 'unparsed'; raw: string };

/** 未登录的输出特征（CLI 中文提示 / 可能的英文变体） */
const NOT_LOGGED_IN_RE = /未检测到有效登录态|请先登录|not logged in/i;

/**
 * 从混杂文本中提取所有顶层平衡的 `{...}` 片段（忽略字符串字面量内的花括号）。
 * CLI 输出可能是「日志行 + JSON + 日志行」，日志自身也可能带花括号或出现多段 JSON。
 */
function extractJsonCandidates(text: string): string[] {
	const found: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (c === '\\') {
				escaped = true;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}
		if (c === '"' && depth > 0) {
			inString = true;
		} else if (c === '{') {
			if (depth === 0) {
				start = i;
			}
			depth++;
		} else if (c === '}' && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				found.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return found;
}

/**
 * 解析 dreamina 命令输出：提取全部平衡 JSON 片段，从后往前找第一个能解析且带
 * submit_id / gen_status 业务字段的对象（CLI 的结果 JSON 通常在输出末尾）；
 * 没有业务字段时退而取任一可解析对象。判成败必须看 JSON 的 gen_status，
 * 不能只看退出码（官方口径）。
 */
export function parseDreaminaOutput(stdout: string, stderr = ''): DreaminaOutput {
	const raw = `${stdout}\n${stderr}`;
	if (NOT_LOGGED_IN_RE.test(raw)) {
		return { kind: 'not-logged-in' };
	}
	let fallback: DreaminaOutput | undefined;
	const candidates = extractJsonCandidates(stdout);
	for (let i = candidates.length - 1; i >= 0; i--) {
		let obj: Record<string, unknown>;
		try {
			const parsed = JSON.parse(candidates[i]) as unknown;
			if (!parsed || typeof parsed !== 'object') {
				continue;
			}
			obj = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		const out: DreaminaOutput = {
			kind: 'ok',
			submitId: typeof obj.submit_id === 'string' ? obj.submit_id : undefined,
			genStatus: typeof obj.gen_status === 'string' ? obj.gen_status : undefined,
			failReason: typeof obj.fail_reason === 'string' ? obj.fail_reason : undefined,
		};
		if (out.submitId !== undefined || out.genStatus !== undefined) {
			return out;
		}
		fallback ??= out;
	}
	return fallback ?? { kind: 'unparsed', raw: raw.trim() };
}

/** 全能参考的分类型上限（2026-07-12 `multimodal2video -h` 实测） */
const MM_LIMITS = { image: 9, video: 3, audio: 3 } as const;
/** 生图参考图上限（image2image 实测） */
const I2I_MAX_IMAGES = 10;
/** generate_num 上限 */
const GENERATE_NUM_MAX = 10;

/** 按扩展名把参考素材路径分到图片/视频/音频三桶（保持正文出现顺序） */
export function classifyRefs(refPaths: string[]): { images: string[]; videos: string[]; audios: string[] } {
	const images: string[] = [];
	const videos: string[] = [];
	const audios: string[] = [];
	for (const p of refPaths) {
		const type = mediaTypeOf(path.extname(p));
		(type === 'video' ? videos : type === 'audio' ? audios : images).push(p);
	}
	return { images, videos, audios };
}

/**
 * 拼一次即梦提交的 CLI 参数。生图：无参考图走 text2image、有参考图走 image2image，
 * count 映射 generate_num（1-10）；视频（seedance 家族）：全能参考 multimodal2video，
 * 素材按类型分发 --image/--video/--audio。素材数量/类型不匹配时抛错（提交前校验，不扣积分）。
 */
export function buildSubmitArgs(
	config: ImageFlowConfig,
	prompt: string,
	refPaths: string[],
	count: number
): string[] {
	if (isJimengVideoModel(config.model)) {
		return buildVideoArgs(config, prompt, refPaths);
	}
	return buildImageArgs(config, prompt, refPaths, count);
}

function buildImageArgs(
	config: ImageFlowConfig,
	prompt: string,
	refPaths: string[],
	count: number
): string[] {
	const nonImage = refPaths.filter((p) => mediaTypeOf(path.extname(p)) !== 'image');
	if (nonImage.length) {
		throw new Error(`即梦生图仅支持图片参考，请移除音/视频引用或改选视频模型：${nonImage.map((p) => path.basename(p)).join('、')}`);
	}
	if (refPaths.length > I2I_MAX_IMAGES) {
		throw new Error(`即梦生图参考图最多 ${I2I_MAX_IMAGES} 张，当前 ${refPaths.length} 张`);
	}
	const num = Math.min(GENERATE_NUM_MAX, Math.max(1, count));
	const args = refPaths.length
		? ['image2image', `--images=${refPaths.join(',')}`]
		: ['text2image'];
	args.push(
		`--prompt=${prompt}`,
		`--model_version=${config.model}`,
		`--ratio=${config.aspectRatio}`,
		`--resolution_type=${config.imageSize}`,
		`--generate_num=${num}`,
		'--poll=0'
	);
	return args;
}

function buildVideoArgs(config: ImageFlowConfig, prompt: string, refPaths: string[]): string[] {
	const { images, videos, audios } = classifyRefs(refPaths);
	if (!images.length && !videos.length) {
		throw new Error('全能参考需要至少一张图片或一段视频作为参考素材（正文用 ![名](路径) 声明）');
	}
	const over: string[] = [];
	if (images.length > MM_LIMITS.image) {
		over.push(`图片 ${images.length}/${MM_LIMITS.image}`);
	}
	if (videos.length > MM_LIMITS.video) {
		over.push(`视频 ${videos.length}/${MM_LIMITS.video}`);
	}
	if (audios.length > MM_LIMITS.audio) {
		over.push(`音频 ${audios.length}/${MM_LIMITS.audio}`);
	}
	if (over.length) {
		throw new Error(`全能参考素材超出上限（${over.join('，')}），请精简正文引用`);
	}
	const args = ['multimodal2video'];
	for (const p of images) {
		args.push(`--image=${p}`);
	}
	for (const p of videos) {
		args.push(`--video=${p}`);
	}
	for (const p of audios) {
		args.push(`--audio=${p}`);
	}
	// duration 来自模型自定义参数（providers.ts 的 JIMENG_DURATION），缺省 5
	const duration = config.params.duration || '5';
	args.push(
		`--prompt=${prompt}`,
		`--model_version=${config.model}`,
		`--ratio=${config.aspectRatio}`,
		`--video_resolution=${config.imageSize}`,
		`--duration=${duration}`,
		'--poll=0'
	);
	return args;
}
