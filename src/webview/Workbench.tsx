import { useEffect, useLayoutEffect } from 'react';
import type { Config, ConfigOptions, WebviewLibrary, WebviewCollection, PromptTemplate, StatusState } from './vscode';
import { ConcurrencySelect, ParamsSelect, ModelSelect } from './fields';
import { NativeSelect } from './primitives';
import { Materials } from './Materials';
import { modelSizeControl, findImageModel, qualifiedModel, splitQualifiedModel } from '../modelOptions';

/** 按加载文件名后缀判定提示词模式：*v.md 视频、*i.md 图片、其余不限
 *  （v.md 口径与后端 videoOnlyVmd 生成拦截一致） */
function mdMode(activeMd: string | null): 'video' | 'image' | null {
	const n = (activeMd ?? '').toLowerCase();
	if (n.endsWith('v.md')) {
		return 'video';
	}
	if (n.endsWith('i.md')) {
		return 'image';
	}
	return null;
}

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
	onPreview: () => void;
	onAddLibrary: () => void;
	onRemoveLibrary: (folder: string) => void;
	onSendToEdit: (uri: string) => void;
}) {
	// 档位/比例/并发/自定义参数随模型变化 + 切模型按各模型独立记忆恢复档位、播种参数默认值（工作台用 model 组）；与编辑页共用 modelSizeControl
	const { current, changeModel } = modelSizeControl(
		config,
		options,
		{ provider: 'providerId', model: 'model', size: 'imageSize', ratio: 'aspectRatio', concurrency: 'concurrency', memory: 'imageSizeMemory', params: 'params' },
		onChangeMany
	);

	// 升级兜底：并发夹取只发生在切模型时，旧配置若已选中视频模型且并发 >4，首载不切模就会显示越界值——
	// 检测到当前值超过当前模型上限即写回夹取值，保持 UI、持久化与实际提交数一致
	useEffect(() => {
		if (current && config.concurrency > current.maxConcurrency) {
			onChange('concurrency', current.maxConcurrency);
		}
	}, [current, config.concurrency]);

	// 提示词模式（按加载文件后缀）与当前模型的视频/图片属性
	const mode = mdMode(activeMd);
	const kind: 'video' | 'image' = current?.video ? 'video' : 'image';

	// 切模型统一入口：在参数快照切换（changeModel）之外，把目标记为该类「最近使用」；
	// 跨视频/图片类切换时，离开方的模型与预设模板存入其模式记忆，进入方的模板随之恢复
	const changeModelByMode = (qualified: string) => {
		const { provider, model } = splitQualifiedModel(qualified);
		const target = findImageModel(options, provider, model);
		if (!target) {
			return;
		}
		changeModel(qualified);
		const newKind = target.video ? 'video' : 'image';
		const patch: Partial<Config> = {
			[newKind === 'video' ? 'lastVideoModel' : 'lastImageModel']: qualifiedModel(target.provider, target.model),
		};
		if (newKind !== kind) {
			if (current) {
				patch[kind === 'video' ? 'lastVideoModel' : 'lastImageModel'] = qualifiedModel(current.provider, current.model);
			}
			patch[kind === 'video' ? 'workbenchVideoTemplate' : 'workbenchImageTemplate'] = config.workbenchTemplate;
			patch.workbenchTemplate =
				newKind === 'video' ? config.workbenchVideoTemplate : config.workbenchImageTemplate;
		}
		onChangeMany(patch);
	};

	// v.md/i.md 模式与当前模型属性不符时，自动切到该模式最近使用的模型（无记忆或记忆失效则取列表首个该类模型）。
	// useLayoutEffect：在绘制前完成切换，避免「当前模型已被滤出下拉」的一帧裸名闪烁；
	// 依赖含 options：该类模型此刻不可用（如自定义 Provider 配置刚修好）时，新 options 到达后补切
	useLayoutEffect(() => {
		if (!mode || mode === kind) {
			return;
		}
		const isMode = (m: { video?: boolean }) => (mode === 'video') === !!m.video;
		const rememberedQ = mode === 'video' ? config.lastVideoModel : config.lastImageModel;
		const remembered = rememberedQ ? splitQualifiedModel(rememberedQ) : null;
		const target =
			(remembered &&
				options.imageModels.find(
					(m) => m.provider === remembered.provider && m.model === remembered.model && isMode(m)
				)) ||
			options.imageModels.find(isMode);
		if (target) {
			changeModelByMode(qualifiedModel(target.provider, target.model));
		}
	}, [mode, kind, options]);

	// 模型下拉按模式过滤：v.md 只列视频模型、i.md 只列图片模型；该类模型一个都没有时回退全量，避免下拉为空
	const modeModels = mode
		? options.imageModels.filter((m) => (mode === 'video') === !!m.video)
		: options.imageModels;
	const shownModels = modeModels.length ? modeModels : options.imageModels;
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
					<ModelSelect
						label="模型"
						provider={current?.provider ?? config.providerId}
						model={current?.model ?? config.model}
						models={shownModels}
						onChange={changeModelByMode}
					/>
					<ParamsSelect
						label="参数"
						aspectRatio={config.aspectRatio}
						ratioOptions={current?.aspectRatios ?? []}
						imageSize={config.imageSize}
						sizeOptions={current?.imageSizes ?? []}
						customParams={current?.custom ?? []}
						paramValues={config.params}
						onChangeRatio={(v) => onChange('aspectRatio', v)}
						onChangeSize={(v) => onChange('imageSize', v)}
						onChangeParam={(key, v) => onChange('params', { ...config.params, [key]: v })}
					/>
					<ConcurrencySelect
						label="并发数"
						value={config.concurrency}
						max={current?.maxConcurrency ?? 10}
						onChange={(v) => onChange('concurrency', v)}
					/>
				</div>

				<div className="gen-row">
					<div
						className="tpl-select-wrap tip"
						data-tip="选中的预设模板会在生成/预览时插到提示词最前面"
					>
						<NativeSelect
							ariaLabel="预设模板"
							value={config.workbenchTemplate || TPL_NONE}
							options={[
								{ value: TPL_NONE, label: '不使用预设' },
								...templates.map((t) => ({ value: t.name, label: t.name })),
							]}
							onChange={(v) => onChange('workbenchTemplate', v === TPL_NONE ? '' : v)}
						/>
					</div>
					<span
						className="tip md-tip"
						data-tip="加载文件：跟随当前活动的 Markdown 编辑器；切到非 Markdown 标签时保持不变"
						aria-label="加载文件：跟随当前活动的 Markdown 编辑器；切到非 Markdown 标签时保持不变"
					>
						<span className="active-md">{activeMd ?? '未打开 Markdown 文件'}</span>
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
