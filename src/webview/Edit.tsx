import { useRef, useState } from 'react';
import {
	vscode,
	type Config,
	type ConfigOptions,
	type WebviewEditImage,
	type PromptTemplate,
	type StatusState,
} from './vscode';
import { Select, Stepper, Field, RatioSelect } from './fields';
import { Thumb } from './Thumb';
import { useCooldown } from './useCooldown';
import { namedRefSnippet } from '../refs';
import { modelSizeControl } from '../modelOptions';

/** 编辑页：图片区（上传/拖入/点击插入引用）+ 模板 + 提示词 + 编辑专属参数 + 生成 */
export function Edit({
	hidden,
	config,
	options,
	images,
	templates,
	busy,
	status,
	onChange,
	onChangeMany,
	onError,
}: {
	hidden: boolean;
	config: Config;
	options: ConfigOptions;
	images: WebviewEditImage[];
	templates: PromptTemplate[];
	busy: boolean;
	status: StatusState;
	onChange: <K extends keyof Config>(key: K, value: Config[K]) => void;
	onChangeMany: (patch: Partial<Config>) => void;
	onError: (message: string) => void;
}) {
	const [prompt, setPrompt] = useState('');
	const [cooling, cool] = useCooldown(500);
	const [dragOver, setDragOver] = useState(false);
	const taRef = useRef<HTMLTextAreaElement>(null);

	// 在光标处插入文本并把光标移到插入末尾；textarea 未挂载时退化为追加
	const insertAtCursor = (text: string) => {
		const ta = taRef.current;
		if (!ta) {
			setPrompt((p) => p + text);
			return;
		}
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		setPrompt((p) => p.slice(0, start) + text + p.slice(end));
		requestAnimationFrame(() => {
			ta.focus();
			ta.selectionStart = ta.selectionEnd = start + text.length;
		});
	};

	// 拖入：侧栏内自定义类型 > uri-list（VS Code 资源管理器/系统）> File 二进制兜底（转 data URI 由扩展存内存）
	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(false);
		const custom = e.dataTransfer.getData('application/x-imageflow-uri');
		if (custom) {
			vscode.postMessage({ type: 'editAddImages', uris: [custom] });
			return;
		}
		const uriList = e.dataTransfer.getData('text/uri-list');
		let uris = uriList
			? uriList.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
			: [];
		if (!uris.length) {
			// VS Code 资源管理器需按住 Shift 拖入，workbench 此时写入 resourceurls（URI 字符串的 JSON 数组）
			try {
				const parsed: unknown = JSON.parse(e.dataTransfer.getData('resourceurls') || '[]');
				if (Array.isArray(parsed)) {
					uris = parsed.filter((s): s is string => typeof s === 'string');
				}
			} catch {
				// 非 JSON 则当作没有
			}
		}
		if (uris.length) {
			vscode.postMessage({ type: 'editAddImages', uris });
			return;
		}
		// 不按 Shift 时 VS Code 拦截资源管理器拖拽，drop 不携带任何数据——提示正确姿势
		if (!e.dataTransfer.files.length) {
			onError('未读取到图片：从 VS Code 资源管理器拖入需按住 Shift，或用「上传」按钮 / 系统文件管理器拖入。');
			return;
		}
		// 多个 FileReader 的完成顺序不定，而列表顺序决定图片区序号（即 imageN）——收齐后按拖入顺序一条消息批量发送
		const reads = Array.from(e.dataTransfer.files).map(
			(file) =>
				new Promise<{ name: string; data: string } | null>((resolve) => {
					const reader = new FileReader();
					reader.onload = () =>
						resolve(typeof reader.result === 'string' ? { name: file.name, data: reader.result } : null);
					reader.onerror = () => resolve(null);
					reader.readAsDataURL(file);
				})
		);
		void Promise.all(reads).then((items) => {
			const valid = items.filter((i): i is { name: string; data: string } => i !== null);
			const failed = items.length - valid.length;
			if (failed > 0) {
				onError(`有 ${failed} 张图片读取失败，已跳过。`);
			}
			if (valid.length) {
				vscode.postMessage({ type: 'editAddImagesData', items: valid });
			}
		});
	};

	// 分辨率随模型变化 + 切模型按各模型独立记忆恢复档位、播种参数默认值（编辑页用 editModel 组）；与工作台共用 modelSizeControl
	const { sizeOptions, changeModel } = modelSizeControl(
		config,
		options,
		{ model: 'editModel', size: 'editImageSize', memory: 'editImageSizeMemory', params: 'editParams' },
		onChangeMany
	);
	// 编辑模型可调的自定义参数（自定义 Provider 的 custom[]；内置 grsai 恒空）
	const customParams = options.customByModel[config.editModel] ?? [];

	// 选中模板：追加到提示词末尾（不覆盖已有内容）
	const applyTemplate = (name: string) => {
		const t = templates.find((x) => x.name === name);
		if (!t) {
			return;
		}
		setPrompt((p) => (p.trim() ? `${p.replace(/\s+$/, '')}\n\n${t.content.trim()}` : t.content.trim()));
	};

	// 生成：0.5s 冷却防连点
	const generate = () => {
		if (busy || cooling) {
			return;
		}
		cool();
		vscode.postMessage({ type: 'editGenerate', prompt });
	};

	// 构建并复制：与生成同享 0.5s 冷却防连点（建夹+读媒体也有耗时）
	const buildCopy = () => {
		if (busy || cooling) {
			return;
		}
		cool();
		vscode.postMessage({ type: 'editBuildAndCopy', prompt });
	};

	// 一键清空：编辑区图片（扩展侧持有）+ 提示词（本地 state）。提交后两者均保留以支持迭代编辑，需要时清空
	const clearAll = () => {
		vscode.postMessage({ type: 'editClearImages' });
		setPrompt('');
	};

	return (
		<div className="page" data-page="edit" hidden={hidden}>
			<div className="gallery">
			<div
				className={`edit-drop${dragOver ? ' over' : ''}`}
				onDragOver={(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={onDrop}
			>
				<div className="edit-images">
					{images.length === 0 ? (
						<div className="empty">拖入图片（VS Code 资源管理器需按住 Shift 拖），或点击下方「上传」。右键图片可在提示词中插入引用。</div>
					) : (
						<div className="thumbs" style={{ ['--cols' as string]: config.workbenchCols }}>
							{images.map((img, i) => (
								<Thumb
									key={img.name}
									src={img.src}
									name={img.name}
									media={img.media}
									title={`${img.name}（左键打开 · 右键插入引用）`}
									onClick={() => vscode.postMessage({ type: 'editOpenImage', name: img.name })}
									onContextMenu={(e) => {
										e.preventDefault();
										insertAtCursor(namedRefSnippet(img.name));
									}}
								>
									<span className="thumb-index">{i + 1}</span>
									<button
										className="thumb-action thumb-remove"
										title="移除"
										onClick={() => vscode.postMessage({ type: 'editRemoveImage', name: img.name })}
									>
										×
									</button>
								</Thumb>
							))}
						</div>
					)}
				</div>
				<button className="lib-add" onClick={() => vscode.postMessage({ type: 'editUpload' })}>
					+ 上传
				</button>
			</div>

			<Field label="预设模板（.image-flow/prompts/ 下的 .md 文件，点击追加到提示词）">
				{templates.length === 0 ? (
					<div className="empty">暂无模板，可在 .image-flow/prompts/ 放置 .md 文件。</div>
				) : (
					<div className="picker-bar" style={{ ['--tab-cols' as string]: config.templateCols }}>
						{templates.map((t) => (
							<button
								key={t.name}
								className="picker-chip"
								title={`追加「${t.name}」到提示词`}
								onClick={() => applyTemplate(t.name)}
							>
								<span className="chip-name">{t.name}</span>
							</button>
						))}
					</div>
				)}
			</Field>

			<Field label="提示词">
				<textarea
					ref={taRef}
					rows={8}
					value={prompt}
					placeholder="选择模板或直接输入；右键上方图片插入引用"
					onChange={(e) => setPrompt(e.target.value)}
				/>
			</Field>
			</div>

			<div className="dock">
			<div className="row">
				<Select
					label="模型"
					value={config.editModel}
					options={options.model.map((m) => ({ value: m, label: options.modelLabels[m] ?? m }))}
					onChange={changeModel}
				/>
				<RatioSelect
					label="比例"
					value={config.editAspectRatio}
					options={options.aspectRatiosByModel[config.editModel] ?? options.aspectRatio}
					onChange={(v) => onChange('editAspectRatio', v)}
				/>
				<Select
					label="分辨率"
					value={config.editImageSize}
					options={sizeOptions}
					onChange={(v) => onChange('editImageSize', v)}
				/>
				{customParams.map((p) => (
					<Select
						key={p.key}
						className="field-custom"
						label={p.label}
						value={config.editParams[p.key] ?? p.default}
						options={p.options}
						onChange={(v) => onChange('editParams', { ...config.editParams, [p.key]: v })}
					/>
				))}
				<Stepper
					label="并发数"
					value={config.editConcurrency}
					min={1}
					max={10}
					onChange={(v) => onChange('editConcurrency', v)}
				/>
			</div>

			<div className="gen-row">
				<button
					className="clear-btn"
					disabled={!images.length && !prompt.trim()}
					onClick={clearAll}
				>
					清空
				</button>
				<button
					className="preview-btn"
					onClick={() => vscode.postMessage({ type: 'editPreviewRequest', prompt })}
				>
					预览请求
				</button>
				<button className="gen-btn" disabled={busy || cooling} onClick={generate}>
					{busy ? '生成中…' : '生成'}
				</button>
				<button
					className="build-btn"
					disabled={busy || cooling}
					title="不调用 API：建好任务并把替换后的提示词复制到剪贴板，参考媒体按顺序导出到 input/，供外部网页/APP 视频后端上传"
					onClick={buildCopy}
				>
					构建并复制
				</button>
			</div>

			<div className={`status${status.error ? ' error' : ''}`}>{status.text}</div>
			</div>
		</div>
	);
}
