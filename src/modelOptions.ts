// 模型 → 分辨率档位的纯逻辑：前端按模型过滤可选档位、切模型时恢复各模型独立的分辨率记忆。
// 纯函数，禁止引入 vscode/node/DOM，前后端可共用（当前仅 webview 用）。
import type { ConfigOptions, ImageFlowConfig } from './shared';

/** 当前模型支持的分辨率档位；模型不在表内时回退 imageSize 全集 */
export function supportedSizes(options: ConfigOptions, model: string): readonly string[] {
	return options.imageSizesByModel[model] ?? options.imageSize;
}

/**
 * 切模型时计算新模型应生效的分辨率 + 更新后的「每模型记忆」表。
 * 先把离开的旧模型当前分辨率记入表，再为新模型取值：有记忆且新模型支持则恢复该记忆，
 * 否则沿用旧分辨率（新模型也支持时），仍不行则取新模型首个档位。
 * 这样各模型的分辨率档位互相独立——切到 gpt-image-2 被压到 1K，切回 nano-banana-2 仍是 4K。
 */
export function switchModelSize(
	options: ConfigOptions,
	memory: Record<string, string>,
	oldModel: string,
	oldSize: string,
	newModel: string
): { size: string; memory: Record<string, string> } {
	const nextMemory = { ...memory, [oldModel]: oldSize };
	const sizes = supportedSizes(options, newModel);
	const remembered = nextMemory[newModel];
	const size =
		remembered && sizes.includes(remembered)
			? remembered
			: sizes.includes(oldSize)
				? oldSize
				: sizes[0];
	return { size, memory: nextMemory };
}

/** ImageFlowConfig 中值类型恰为 V 的字段名 */
type ConfigKeyOf<V> = { [K in keyof ImageFlowConfig]: ImageFlowConfig[K] extends V ? K : never }[keyof ImageFlowConfig];

/** 模型切换涉及的四个 config 键：工作台用 model 组，编辑页用 editModel 组。
 *  按值类型收窄——model/size 必为字符串字段、memory/params 必为记录字段，传错组别即编译期报错，无需运行时强转 */
export interface ModelSizeKeys {
	model: ConfigKeyOf<string>;
	size: ConfigKeyOf<string>;
	memory: ConfigKeyOf<Record<string, string>>;
	params: ConfigKeyOf<Record<string, string>>;
}

/**
 * 工作台与编辑页共用的「模型切换」接线：算出当前模型支持的分辨率档位 +
 * 切模型处理器（记下旧档→按记忆/兜底取新档→一次性写回三个键）。
 * 纯逻辑在 supportedSizes/switchModelSize，这里只把它绑到两组不同的 config 键 + 单次批量保存，
 * 消除工作台/编辑页两处近乎逐字的重复，并把原本 3 次写回合成一条 patch。
 */
export function modelSizeControl(
	config: ImageFlowConfig,
	options: ConfigOptions,
	keys: ModelSizeKeys,
	onChangeMany: (patch: Partial<ImageFlowConfig>) => void
): { sizeOptions: readonly string[]; changeModel: (model: string) => void } {
	const sizeOptions = supportedSizes(options, config[keys.model]);
	const changeModel = (model: string) => {
		const { size, memory } = switchModelSize(
			options,
			config[keys.memory],
			config[keys.model],
			config[keys.size],
			model
		);
		// 切模型同时播种新模型可见参数的默认值（自定义参数），写进对应 params 字段，否则只显示不发
		const custom = options.customByModel[model] ?? [];
		const params = Object.fromEntries(custom.map((c) => [c.key, c.default]));
		// 计算键的对象 TS 推不出具体字段，仅此一处保留 Partial 断言（写入侧，非取值侧）
		onChangeMany({
			[keys.model]: model,
			[keys.size]: size,
			[keys.memory]: memory,
			[keys.params]: params,
		} as Partial<ImageFlowConfig>);
	};
	return { sizeOptions, changeModel };
}
