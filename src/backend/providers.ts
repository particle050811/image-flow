// Provider 数据模型（纯逻辑，禁止引入 vscode/node/fs/DOM——前后端可共用）：
// 内置 grsai Provider、settings.json → 自定义 Provider 的解析、发往 webview 的 ConfigOptions 构建、
// 自定义参数默认值播种、切 Provider/模型时的模型对齐、缺文件时的脚手架内容。
// 真正的文件 IO（读/写 settings.json）在 providerRuntime.ts（node 侧）。

import { parse as jsoncParse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type { ConfigOptions, CustomParam } from '../shared';

export const GRSAI_PROVIDER_ID = 'grsai';
export const JIMENG_PROVIDER_ID = 'jimeng';
export const CUSTOM_PROVIDER_ID = 'custom';
const GRSAI_LABEL = 'Grsai';
const JIMENG_LABEL = '即梦';
const CUSTOM_LABEL = '自定义';

/** 运行时图片模型（含 baseUrl/apiKey，仅后端持有，绝不下发 webview） */
export interface RuntimeImageModel {
	model: string;
	label: string;
	adapter: string;
	/** 该模型的 api 地址；内置 grsai 缺省 → 调用方回落 config.baseUrl */
	baseUrl?: string;
	/** 该模型的密钥；内置 grsai 缺省 → 调用方回落 config.apiKey（secrets） */
	apiKey?: string;
	aspectRatios: string[];
	imageSizes: string[];
	/** 并发上限（并发选择器渲染 1..max）；视频模型 4、其余 10 */
	maxConcurrency: number;
	/** 是否视频模型：编辑页不可用，且默认仅允许 *v.md 文件生成 */
	video?: boolean;
	/** 首次切到该模型（无参数记忆）时的默认参数；缺省沿用切换前的当前值 */
	defaults?: { aspectRatio?: string; imageSize?: string; concurrency?: number };
	custom: CustomParam[];
}

/** 运行时对话模型（AI 命名用） */
export interface RuntimeChatModel {
	model: string;
	label: string;
	adapter: string;
	baseUrl?: string;
	apiKey?: string;
}

/** 运行时 Provider：一批图片模型 + 一批对话模型 */
export interface RuntimeProvider {
	id: string;
	label: string;
	image: RuntimeImageModel[];
	chat: RuntimeChatModel[];
}

/** 非视频模型的并发上限（沿用原并发步进器的 1~10） */
const DEFAULT_MAX_CONCURRENCY = 10;

// —— 内置 grsai —— //
const GRSAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const GRSAI_SIZES_FULL = ['1K', '2K', '4K'];
/** AI 命名可选的对话模型（内置 grsai） */
const GRSAI_CHAT_MODELS = [
	'gemini-3.5-flash',
	'gemini-3.1-flash-lite',
	'gemini-3-flash',
	'gemini-2.5-flash',
	'gemini-3.1-pro',
	'gemini-3-pro',
	'gemini-2.5-pro',
	'gpt-5.5',
	'gpt-5.4',
];

function grsaiImage(model: string, label: string, imageSizes: string[]): RuntimeImageModel {
	return {
		model,
		label,
		adapter: 'grsai-async',
		aspectRatios: GRSAI_ASPECT_RATIOS,
		imageSizes,
		maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		custom: [],
	};
}

/** 内置 grsai Provider：模型固定、baseUrl/apiKey 走 config/secrets（此处不带） */
export const BUILTIN_GRSAI: RuntimeProvider = {
	id: GRSAI_PROVIDER_ID,
	label: GRSAI_LABEL,
	image: [
		// gpt-image-2（非 vip）仅 1K；其余支持全集
		grsaiImage('nano-banana-2', 'Nano Banana 2', GRSAI_SIZES_FULL),
		grsaiImage('nano-banana-pro', 'Nano Banana Pro', GRSAI_SIZES_FULL),
		grsaiImage('gpt-image-2', 'GPT Image 2', ['1K']),
		grsaiImage('gpt-image-2-vip', 'GPT Image 2 VIP', GRSAI_SIZES_FULL),
	],
	chat: GRSAI_CHAT_MODELS.map((m) => ({ model: m, label: m, adapter: 'openai-chat' })),
};

// —— 内置即梦（官方 dreamina CLI，鉴权在 CLI 侧，无 baseUrl/apiKey）—— //
// 模型能力表来自 media/jimeng-models.jsonc（providerRuntime 启动读入缓存，见 builtinJimeng）。
// 档位为 `dreamina <cmd> -h` 实测值。只在前端渲染档位，后端不收敛（memory backend-no-capability-clamp）。

/** 判断即梦模型是否为视频模型（seedance 家族走全能参考 multimodal2video） */
export function isJimengVideoModel(model: string): boolean {
	return model.startsWith('seedance');
}

/** 即梦生图模型能力（jimeng-models.jsonc 的 imageModels 项） */
export interface JimengImageSpec {
	model: string;
	label: string;
}

/** 即梦视频模型能力片段：全能参考分类型素材上限 + 是否允许纯音频参考（供 CLI 适配器提交前校验） */
export interface JimengVideoCap {
	max: { image: number; video: number; audio: number };
	allowAudioOnly: boolean;
}

/** 即梦视频模型能力（jimeng-models.jsonc 的 videoModels 项） */
export interface JimengVideoSpec {
	model: string;
	label: string;
	/** video_resolution 档位 */
	sizes: string[];
	/** 时长区间（秒，闭区间） */
	duration: [number, number];
	/** 全能参考分类型素材上限 */
	max: { image: number; video: number; audio: number };
	/** 是否允许纯音频参考（seedance2.5 专属） */
	allowAudioOnly: boolean;
}

/** 即梦模型能力表（media/jimeng-models.jsonc 全量） */
export interface JimengModelData {
	imageRatios: string[];
	imageSizes: string[];
	imageModels: JimengImageSpec[];
	videoRatios: string[];
	videoModels: JimengVideoSpec[];
}

/** 按模型查视频能力片段；非视频模型/未知模型返回 undefined（适配器回落通用值） */
export function jimengVideoCaps(data: JimengModelData, model: string): JimengVideoCap | undefined {
	const v = data.videoModels.find((x) => x.model === model);
	return v ? { max: v.max, allowAudioOnly: v.allowAudioOnly } : undefined;
}

/** 时长区间 → 秒档位列表 */
function durationOptions([min, max]: [number, number]): string[] {
	return Array.from({ length: max - min + 1 }, (_, i) => String(min + i));
}

/**
 * 即梦视频模型的系列键：剥掉 seedance 前缀与 _vip 后缀，同系列的 VIP 与非 VIP 归到一组。
 * 例：seedance2.0_vip → 2.0、seedance2.0fast_vip → 2.0fast、seedance2.0mini → 2.0mini。
 */
export function jimengVideoSeries(model: string): string {
	return model.replace(/^seedance/i, '').replace(/_vip$/, '');
}

/** 系列展示序：mini → fast → 原版 → 2.5（2.5 无 mini/fast 后缀，单列末尾）。
 *  先查通用变体（mini/fast）再查版本特例（2.5），未来若出 seedance2.5mini 之类
 *  变体也会归入对应 mini/fast 系列而非误判成 2.5 原版。 */
function seriesRank(series: string): number {
	if (series.includes('mini')) {
		return 0;
	}
	if (series.includes('fast')) {
		return 1;
	}
	if (series.startsWith('2.5')) {
		return 3;
	}
	return 2;
}

/** 即梦视频模型排序：系列序 mini→fast→原版→2.5，组内 VIP（_vip 后缀）在前 */
export function compareJimengVideo(a: string, b: string): number {
	const d = seriesRank(jimengVideoSeries(a)) - seriesRank(jimengVideoSeries(b));
	if (d !== 0) {
		return d;
	}
	return (a.endsWith('_vip') ? 0 : 1) - (b.endsWith('_vip') ? 0 : 1);
}

/** 从能力表数据构建即梦 Provider（纯函数，可直测） */
export function buildJimengProvider(data: JimengModelData): RuntimeProvider {
	const image: RuntimeImageModel[] = data.imageModels.map((m) => ({
		model: m.model,
		label: m.label,
		adapter: 'jimeng-cli',
		aspectRatios: data.imageRatios,
		imageSizes: data.imageSizes,
		maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		custom: [],
	}));
	// 视频模型按系列排序（VIP 组内在前）：前端弹层按此顺序渲染，便于选择
	const sortedVideos = [...data.videoModels].sort((a, b) => compareJimengVideo(a.model, b.model));
	for (const v of sortedVideos) {
		const duration: CustomParam = {
			key: 'duration',
			label: '时长（秒）',
			options: durationOptions(v.duration),
			default: '5',
		};
		image.push({
			model: v.model,
			label: v.label,
			adapter: 'jimeng-cli',
			aspectRatios: data.videoRatios,
			// 复用分辨率档位下拉渲染 video_resolution
			imageSizes: v.sizes,
			// 视频生成昂贵：并发限 1~4，默认 720p / 16:9 / 并发 1
			maxConcurrency: 4,
			video: true,
			defaults: { aspectRatio: '16:9', imageSize: '720p', concurrency: 1 },
			custom: [duration],
		});
	}
	return { id: JIMENG_PROVIDER_ID, label: JIMENG_LABEL, image, chat: [] };
}

/** 能力表损坏/缺失时的回落数据：仅生图 5.0，渠道保持可用 */
export const JIMENG_MINIMAL_MODEL_DATA: JimengModelData = {
	imageRatios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
	imageSizes: ['2k', '4k'],
	imageModels: [{ model: '5.0', label: '即梦生图 5.0' }],
	videoRatios: [],
	videoModels: [],
};

/** 校验能力表形状：数组字段、每个视频模型的 duration 区间合法（min≤max）、上限全为正数 */
export function isValidJimengData(raw: unknown): raw is JimengModelData {
	if (!raw || typeof raw !== 'object') {
		return false;
	}
	const o = raw as Record<string, unknown>;
	const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
	if (!isStrArray(o.imageRatios) || !isStrArray(o.imageSizes) || !isStrArray(o.videoRatios)) {
		return false;
	}
	const isModel = (v: unknown): boolean => {
		if (!v || typeof v !== 'object') {
			return false;
		}
		const m = v as Record<string, unknown>;
		if (typeof m.model !== 'string' || !m.model || typeof m.label !== 'string' || !m.label) {
			return false;
		}
		return true;
	};
	if (!Array.isArray(o.imageModels) || !o.imageModels.every(isModel)) {
		return false;
	}
	if (!Array.isArray(o.videoModels) || !o.videoModels.every((v) => {
		if (!isModel(v)) {
			return false;
		}
		const vm = v as Record<string, unknown>;
		if (!isStrArray(vm.sizes) || vm.sizes.length === 0) {
			return false;
		}
		const dur = vm.duration;
		if (!Array.isArray(dur) || dur.length !== 2 || typeof dur[0] !== 'number' || typeof dur[1] !== 'number' || dur[0] > dur[1]) {
			return false;
		}
		const max = vm.max as Record<string, unknown> | undefined;
		if (!max || typeof max.image !== 'number' || typeof max.video !== 'number' || typeof max.audio !== 'number' ||
			max.image < 0 || max.video < 0 || max.audio < 0) {
			return false;
		}
		if (typeof vm.allowAudioOnly !== 'boolean') {
			return false;
		}
		return true;
	})) {
		return false;
	}
	return true;
}

// —— settings.json 解析 —— //

/** 取字符串字段，非字符串返回兜底 */
function str(obj: Record<string, unknown>, key: string, fallback = ''): string {
	const v = obj[key];
	return typeof v === 'string' ? v : fallback;
}

/** 取字符串数组字段（过滤非字符串项），缺省空数组 */
function strArray(obj: Record<string, unknown>, key: string): string[] {
	const v = obj[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 解析一个 custom 参数项；缺 key/default 则视为无效返回 null */
function parseCustomParam(raw: unknown): CustomParam | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const obj = raw as Record<string, unknown>;
	const key = str(obj, 'key');
	if (!key) {
		return null;
	}
	const options = strArray(obj, 'options');
	return {
		key,
		label: str(obj, 'label', key),
		options,
		default: str(obj, 'default', options[0] ?? ''),
	};
}

/** 解析图片模型数组；跳过缺 model/adapter 的无效项 */
function parseImageModels(raw: unknown): RuntimeImageModel[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const models: RuntimeImageModel[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const obj = item as Record<string, unknown>;
		const model = str(obj, 'model');
		const adapter = str(obj, 'adapter');
		if (!model || !adapter) {
			continue;
		}
		const custom = Array.isArray(obj.custom)
			? obj.custom.map(parseCustomParam).filter((c): c is CustomParam => c !== null)
			: [];
		models.push({
			model,
			label: str(obj, 'label', model),
			adapter,
			baseUrl: str(obj, 'baseUrl') || undefined,
			apiKey: str(obj, 'apiKey') || undefined,
			aspectRatios: strArray(obj, 'aspectRatios'),
			imageSizes: strArray(obj, 'imageSizes'),
			maxConcurrency: DEFAULT_MAX_CONCURRENCY,
			custom,
		});
	}
	return models;
}

/** 解析对话模型数组；跳过缺 model 的无效项（adapter 缺省即 openai-chat） */
function parseChatModels(raw: unknown): RuntimeChatModel[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const models: RuntimeChatModel[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const obj = item as Record<string, unknown>;
		const model = str(obj, 'model');
		if (!model) {
			continue;
		}
		models.push({
			model,
			label: str(obj, 'label', model),
			adapter: str(obj, 'adapter', 'openai-chat'),
			baseUrl: str(obj, 'baseUrl') || undefined,
			apiKey: str(obj, 'apiKey') || undefined,
		});
	}
	return models;
}

/**
 * 从自定义 chat 列表挑 AI 命名用模型：只考虑 apiKey 与 baseUrl 齐全的项（不完整项跳过，
 * 绝不与内置渠道凭据混用），namingModel 命中则精确用，否则取首个可用项；无可用项返回 undefined。
 */
export function pickNamingChat(
	chat: readonly RuntimeChatModel[],
	namingModel: string
): RuntimeChatModel | undefined {
	const usable = chat.filter((x) => x.apiKey && x.baseUrl);
	return usable.find((x) => x.model === namingModel) ?? usable[0];
}

/** 把 settings.json 顶层对象解析为自定义 Provider（容错：非对象/缺字段不抛错，给空列表） */
export function parseCustomProvider(raw: unknown): RuntimeProvider {
	const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return {
		id: CUSTOM_PROVIDER_ID,
		label: CUSTOM_LABEL,
		image: parseImageModels(obj.image),
		chat: parseChatModels(obj.chat),
	};
}

// —— 发往 webview 的 ConfigOptions（剥掉 baseUrl/apiKey） —— //

/** 合并全部可用渠道的图片模型，构建 ConfigOptions（只含展示/下拉所需，绝不含 url/key） */
export function buildOptions(providers: readonly RuntimeProvider[]): ConfigOptions {
	return {
		imageModels: providers.flatMap((p) =>
			p.image.map((m) => ({
				provider: p.id,
				providerLabel: p.label,
				model: m.model,
				label: m.label,
				aspectRatios: m.aspectRatios,
				imageSizes: m.imageSizes,
				maxConcurrency: m.maxConcurrency,
				video: m.video,
				defaults: m.defaults,
				custom: m.custom,
			}))
		),
	};
}

/** 某模型的可见参数默认值（切模型时播种进 config.params） */
export function paramDefaults(custom: readonly CustomParam[]): Record<string, string> {
	return Object.fromEntries(custom.map((c) => [c.key, c.default]));
}

/**
 * 解析 JSONC（可含 // 与 /* *​/ 注释、尾逗号）的 settings.json。
 * 用 VS Code 同款的 jsonc-parser，与宿主对 settings.json 的解析行为一致。
 * jsonc-parser 自身遇错不抛、尽量恢复；这里收集错误并显式抛出，
 * 让调用方（reloadCustomProvider 的 catch）在配置写坏时回落内置 grsai，而非产出空的自定义 Provider。
 */
export function parseJsonc(text: string): unknown {
	const errors: ParseError[] = [];
	const result = jsoncParse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		// 首个错误的行:列与错误码拼进消息，让台账日志真正可定位（只报位置，不带文件内容，避免泄露 apiKey）
		const first = errors[0];
		const before = text.slice(0, first.offset);
		const line = before.split('\n').length;
		const col = first.offset - before.lastIndexOf('\n');
		throw new Error(`settings.json 不是合法的 JSONC（第 ${line} 行第 ${col} 列，${printParseErrorCode(first.error)}）`);
	}
	return result;
}
