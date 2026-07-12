// 跨渠道模型选择的纯逻辑：模型下拉的限定值编码、按 (渠道, 模型) 查表、
// 切模型时恢复各模型独立的分辨率记忆并对齐比例/播种参数默认值。
// 纯函数，禁止引入 vscode/node/DOM，前后端可共用（当前仅 webview 用）。
import type { ConfigOptions, ImageFlowConfig, ModelParamSnapshot, WebviewImageModel } from './shared';

// 模型下拉的 value 需要全局唯一，而不同渠道可能有同名模型（如都叫 gpt-image-2）。
// 用 NUL 拼接渠道 id 与模型名——两者都不可能含 NUL，绝不与真实名字撞值。
const SEP = '\u0000';

/** (渠道, 模型) → 模型下拉的唯一 value */
export function qualifiedModel(provider: string, model: string): string {
	return `${provider}${SEP}${model}`;
}

/** 模型下拉 value → (渠道, 模型)；非法值当作内置 grsai 的裸模型名兜底 */
export function splitQualifiedModel(value: string): { provider: string; model: string } {
	const i = value.indexOf(SEP);
	return i < 0
		? { provider: 'grsai', model: value }
		: { provider: value.slice(0, i), model: value.slice(i + 1) };
}

/** 按 (渠道, 模型) 精确查表；找不到先回落同渠道首个（与后端 resolveImageCall 的渠道内回落一致，
 *  避免 UI 显示与实际调用的模型不一致），渠道整个不可用才回落列表首个（保持 UI 可用） */
export function findImageModel(
	options: ConfigOptions,
	provider: string,
	model: string
): WebviewImageModel | undefined {
	return (
		options.imageModels.find((m) => m.provider === provider && m.model === model) ??
		options.imageModels.find((m) => m.provider === provider) ??
		options.imageModels[0]
	);
}

/** ImageFlowConfig 中值类型恰为 V 的字段名 */
type ConfigKeyOf<V> = { [K in keyof ImageFlowConfig]: ImageFlowConfig[K] extends V ? K : never }[keyof ImageFlowConfig];

/** 模型切换涉及的七个 config 键：工作台用 model 组，编辑页用 editModel 组。
 *  按值类型收窄——provider/model/size/ratio 必为字符串字段、concurrency 必为数字字段、
 *  memory/params 必为记录字段，传错组别即编译期报错 */
export interface ModelSizeKeys {
	provider: ConfigKeyOf<string>;
	model: ConfigKeyOf<string>;
	size: ConfigKeyOf<string>;
	ratio: ConfigKeyOf<string>;
	concurrency: ConfigKeyOf<number>;
	memory: ConfigKeyOf<Record<string, ModelParamSnapshot>>;
	params: ConfigKeyOf<Record<string, string>>;
}

/** 记忆值在支持列表内则恢复，否则依次取：模型默认值（受支持时）→ 当前值（受支持时）→ 首项 */
function pickRemembered(
	remembered: string | undefined,
	supported: readonly string[],
	current: string,
	preferred?: string
): string {
	if (remembered && supported.includes(remembered)) {
		return remembered;
	}
	if (preferred && supported.includes(preferred)) {
		return preferred;
	}
	return supported.includes(current) ? current : supported[0] ?? current;
}

/** 无记忆、模型也没自带默认时的并发兜底（图片模型默认 4 并发；视频模型自带 defaults.concurrency=1） */
const DEFAULT_CONCURRENCY = 4;

/**
 * 切模型时计算新模型应生效的整套参数 + 更新后的「每模型参数快照」表（键为渠道限定名）。
 * 先把离开的旧模型当前参数整体记入表，再为新模型取值：比例/分辨率有记忆且新模型支持则恢复，
 * 否则先取模型自带默认值（如视频模型 16:9/720p），再沿用当前值（新模型也支持时），仍不行取首项；
 * 并发取「记忆 → 模型默认 → 兜底 4」且夹进 [1, maxConcurrency]；
 * 自定义参数逐键校验记忆值仍在可选项内，否则用默认值。
 * 这样每个 (渠道, 模型) 的参数互相独立——切到 gpt-image-2 被压到 1K，切回 nano-banana-2 仍是 4K。
 */
export function switchModelParams(
	target: WebviewImageModel,
	memory: Record<string, ModelParamSnapshot>,
	oldKey: string,
	oldSnapshot: ModelParamSnapshot,
	newKey: string
): { snapshot: ModelParamSnapshot; memory: Record<string, ModelParamSnapshot> } {
	const nextMemory = { ...memory, [oldKey]: oldSnapshot };
	// 旧配置里该键可能还是裸分辨率字符串（升级前的形状），非对象一律当作无记忆
	const raw = nextMemory[newKey];
	const remembered = raw && typeof raw === 'object' ? raw : undefined;
	// 记忆 → 模型默认 → 兜底 4。并发与比例/分辨率不同，不沿用切换前的值：
	// 否则视频模型的默认并发 1 会被带给图片模型并记进快照（视频模型自带 defaults.concurrency，不吃兜底）
	const concurrency = remembered?.concurrency ?? target.defaults?.concurrency ?? DEFAULT_CONCURRENCY;
	return {
		snapshot: {
			imageSize: pickRemembered(
				remembered?.imageSize, target.imageSizes, oldSnapshot.imageSize, target.defaults?.imageSize
			),
			aspectRatio: pickRemembered(
				remembered?.aspectRatio, target.aspectRatios, oldSnapshot.aspectRatio, target.defaults?.aspectRatio
			),
			concurrency: Math.max(1, Math.min(target.maxConcurrency, concurrency)),
			params: Object.fromEntries(
				target.custom.map((c) => {
					const v = remembered?.params?.[c.key];
					return [c.key, v && c.options.includes(v) ? v : c.default];
				})
			),
		},
		memory: nextMemory,
	};
}

/**
 * 工作台与编辑页共用的「模型切换」接线：取出当前 (渠道, 模型) 对应的模型项（含档位/比例/并发/自定义参数），
 * 并给出切模型处理器（记下旧档→按记忆/模型默认/兜底取新档→比例越界回退首项→播种参数默认值→一次性批量写回）。
 * 消除工作台/编辑页两处近乎逐字的重复，并把多次写回合成一条 patch。
 */
export function modelSizeControl(
	config: ImageFlowConfig,
	options: ConfigOptions,
	keys: ModelSizeKeys,
	onChangeMany: (patch: Partial<ImageFlowConfig>) => void
): { current: WebviewImageModel | undefined; changeModel: (qualified: string) => void } {
	const current = findImageModel(options, config[keys.provider], config[keys.model]);
	const changeModel = (qualified: string) => {
		const { provider, model } = splitQualifiedModel(qualified);
		const target = findImageModel(options, provider, model);
		if (!target) {
			return;
		}
		const { snapshot, memory } = switchModelParams(
			target,
			config[keys.memory],
			qualifiedModel(config[keys.provider], config[keys.model]),
			{
				aspectRatio: config[keys.ratio],
				imageSize: config[keys.size],
				concurrency: config[keys.concurrency],
				params: config[keys.params],
			},
			qualifiedModel(target.provider, target.model)
		);
		// 计算键的对象 TS 推不出具体字段，仅此一处保留 Partial 断言（写入侧，非取值侧）
		onChangeMany({
			[keys.provider]: target.provider,
			[keys.model]: target.model,
			[keys.size]: snapshot.imageSize,
			[keys.ratio]: snapshot.aspectRatio,
			[keys.concurrency]: snapshot.concurrency,
			[keys.memory]: memory,
			[keys.params]: snapshot.params,
		} as Partial<ImageFlowConfig>);
	};
	return { current, changeModel };
}
