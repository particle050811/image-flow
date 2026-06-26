import type { Config, ConfigOptions, WebviewLibrary, WebviewCollection, StatusState } from './vscode';
import { Select, Stepper } from './fields';
import { Materials } from './Materials';
import { modelSizeControl } from '../modelOptions';

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
	cols,
	tabCols,
	onChange,
	onChangeMany,
	onGenerate,
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
	cols: number;
	tabCols: number;
	onChange: <K extends keyof Config>(key: K, value: Config[K]) => void;
	onChangeMany: (patch: Partial<Config>) => void;
	onGenerate: () => void;
	onPreview: () => void;
	onAddLibrary: () => void;
	onRemoveLibrary: (folder: string) => void;
	onSendToEdit: (uri: string) => void;
}) {
	// 分辨率随模型变化 + 切模型按各模型独立记忆恢复档位（工作台用 model 组）；与编辑页共用 modelSizeControl
	const { sizeOptions, changeModel } = modelSizeControl(
		config,
		options,
		{ model: 'model', size: 'imageSize', memory: 'imageSizeMemory' },
		onChangeMany
	);
	return (
		<div className="page" data-page="workbench" hidden={hidden}>
			<div className="gallery">
				<Materials
					autoLibraries={autoLibraries}
					libraries={libraries}
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
						options={options.model}
						onChange={changeModel}
					/>
					<Select
						label="分辨率"
						value={config.imageSize}
						options={sizeOptions}
						onChange={(v) => onChange('imageSize', v)}
					/>
					<Select
						label="比例"
						value={config.aspectRatio}
						options={options.aspectRatio}
						onChange={(v) => onChange('aspectRatio', v)}
					/>
					<Stepper
						label="并发数"
						value={config.concurrency}
						min={1}
						max={10}
						onChange={(v) => onChange('concurrency', v)}
					/>
				</div>

				<div className="gen-row">
					<span
						className="tip"
						data-tip="跟随当前活动的 Markdown 编辑器；切到非 Markdown 标签时保持不变"
						aria-label="跟随当前活动的 Markdown 编辑器；切到非 Markdown 标签时保持不变"
					>
						<span className="active-md">
							{activeMd ? `加载文件：${activeMd}` : '未打开 Markdown 文件'}
						</span>
					</span>
					<button className="preview-btn" onClick={onPreview}>
						预览请求
					</button>
					<button className="gen-btn" disabled={busy} onClick={onGenerate}>
						{busy ? '生成中…' : '生成'}
					</button>
				</div>

				<div className={`status${status.error ? ' error' : ''}`}>{status.text}</div>
			</div>
		</div>
	);
}
