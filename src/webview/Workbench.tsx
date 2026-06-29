import type { Config, ConfigOptions, WebviewLibrary, WebviewCollection, PromptTemplate, StatusState } from './vscode';
import { Select, Stepper, RatioSelect } from './fields';
import { NativeSelect } from './primitives';
import { Materials } from './Materials';
import { modelSizeControl } from '../modelOptions';

/** Radix Select 不允许空串 Item 值，用哨兵代表「不使用预设」（落盘仍存空串）。
 *  取 NUL 字符——模板名来自 .md 文件名，不可能含 NUL，故绝不会与真实模板撞值 */
const TPL_NONE = "\u0000";

export function Workbench({
	hidden,
	config,
	options,
	activeMd,
	busy,
	status,
	libraries,
	autoLibraries,
	collections,
	templates,
	cols,
	tabCols,
	onChange,
	onChangeMany,
	onGenerate,
	onBuildCopy,
	onPreview,
	onAddLibrary,
	onRemoveLibrary,
	onSendToEdit,
}: {
	hidden: boolean;
	config: Config;
	options: ConfigOptions;
	activeMd: string | null;
	busy: boolean;
	status: StatusState;
	libraries: WebviewLibrary[];
	autoLibraries: WebviewLibrary[];
	collections: WebviewCollection[];
	templates: PromptTemplate[];
	cols: number;
	tabCols: number;
	onChange: <K extends keyof Config>(key: K, value: Config[K]) => void;
	onChangeMany: (patch: Partial<Config>) => void;
	onGenerate: () => void;
	onBuildCopy: () => void;
	onPreview: () => void;
	onAddLibrary: () => void;
	onRemoveLibrary: (folder: string) => void;
	onSendToEdit: (uri: string) => void;
}) {
	// 分辨率随模型变化 + 切模型按各模型独立记忆恢复档位、播种参数默认值（工作台用 model 组）；与编辑页共用 modelSizeControl
	const { sizeOptions, changeModel } = modelSizeControl(
		config,
		options,
		{ model: 'model', size: 'imageSize', memory: 'imageSizeMemory', params: 'params' },
		onChangeMany
	);
	// 当前模型可调的自定义参数（自定义 Provider 的 custom[]；内置 grsai 恒空）
	const customParams = options.customByModel[config.model] ?? [];
	// 关闭「显示音频/视频」时，从素材库里滤掉非图片项（角标计数与网格都随之只剩图片）
	const onlyImages = (lib: WebviewLibrary): WebviewLibrary =>
		config.showAudioVideo
			? lib
			: { ...lib, images: lib.images.filter((i) => !i.media || i.media === 'image') };
	return (
		<div className="page" data-page="workbench" hidden={hidden}>
			<div className="gallery">
				<Materials
					autoLibraries={autoLibraries.map(onlyImages)}
					libraries={libraries.map(onlyImages)}
					collections={collections}
					cols={cols}
					tabCols={tabCols}
					onAdd={onAddLibrary}
					onRemove={onRemoveLibrary}
					onSendToEdit={onSendToEdit}
				/>
			</div>

			<div className="dock">
				<div className="row">
					<Select
						label="模型"
						value={config.model}
						options={options.model.map((m) => ({ value: m, label: options.modelLabels[m] ?? m }))}
						onChange={changeModel}
					/>
					<RatioSelect
						label="比例"
						value={config.aspectRatio}
						options={options.aspectRatiosByModel[config.model] ?? options.aspectRatio}
						onChange={(v) => onChange('aspectRatio', v)}
					/>
					<Select
						label="分辨率"
						value={config.imageSize}
						options={sizeOptions}
						onChange={(v) => onChange('imageSize', v)}
					/>
					{customParams.map((p) => (
						<Select
							key={p.key}
							className="field-custom"
							label={p.label}
							value={config.params[p.key] ?? p.default}
							options={p.options}
							onChange={(v) => onChange('params', { ...config.params, [p.key]: v })}
						/>
					))}
					<Stepper
						label="并发数"
						value={config.concurrency}
						min={1}
						max={10}
						onChange={(v) => onChange('concurrency', v)}
					/>
				</div>

				<div className="tpl-row">
					<label className="tpl-label">预设模板</label>
					<div className="tpl-select-wrap">
						<NativeSelect
							ariaLabel="预设模板"
							title="选中的预设模板会在生成/预览时插到提示词最前面"
							value={config.workbenchTemplate || TPL_NONE}
							options={[
								{ value: TPL_NONE, label: '不使用预设' },
								...templates.map((t) => ({ value: t.name, label: t.name })),
							]}
							onChange={(v) => onChange('workbenchTemplate', v === TPL_NONE ? '' : v)}
						/>
					</div>
					<span
						className="tip"
						data-tip="跟随当前活动的 Markdown 编辑器；切到非 Markdown 标签时保持不变"
						aria-label="跟随当前活动的 Markdown 编辑器；切到非 Markdown 标签时保持不变"
					>
						<span className="active-md">
							{activeMd ? `加载文件：${activeMd}` : '未打开 Markdown 文件'}
						</span>
					</span>
				</div>

				<div className="gen-row">
					<button className="preview-btn" onClick={onPreview}>
						预览请求
					</button>
					<button className="gen-btn" disabled={busy} onClick={onGenerate}>
						{busy ? '生成中…' : '生成'}
					</button>
					<button
						className="build-btn"
						disabled={busy}
						title="不调用 API：建好任务并把替换后的提示词复制到剪贴板，参考媒体按顺序导出到 input/，供外部网页/APP 视频后端上传"
						onClick={onBuildCopy}
					>
						构建并复制
					</button>
				</div>

				<div className={`status${status.error ? ' error' : ''}`}>{status.text}</div>
			</div>
		</div>
	);
}
