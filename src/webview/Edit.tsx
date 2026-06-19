import { useRef, useState } from 'react';
import {
	vscode,
	type Config,
	type ConfigOptions,
	type WebviewEditImage,
	type PromptTemplate,
	type StatusState,
} from './vscode';
import { Select, Stepper, Field } from './fields';
import { Thumb } from './Thumb';
import { useCooldown } from './useCooldown';
import { imageRefSnippet } from '../refs';

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

	return (
		<div className="page" data-page="edit" hidden={hidden}>
			<div
				className={`edit-drop${dragOver ? ' over' : ''}`}
				onDragOver={(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={onDrop}
			>
				{images.length === 0 ? (
					<div className="empty">拖入图片（VS Code 资源管理器需按住 Shift 拖），或点击下方「上传」。右键图片可在提示词中插入引用。</div>
				) : (
					<div className="thumbs" style={{ ['--cols' as string]: config.workbenchCols }}>
						{images.map((img, i) => (
							<Thumb
								key={img.name}
								src={img.src}
								title={`${img.name}（左键打开 · 右键插入引用）`}
								onClick={() => vscode.postMessage({ type: 'editOpenImage', name: img.name })}
								onContextMenu={(e) => {
									e.preventDefault();
									insertAtCursor(imageRefSnippet(img.name));
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
				<button className="lib-add" onClick={() => vscode.postMessage({ type: 'editUpload' })}>
					+ 上传
				</button>
			</div>

			<Field label="预设模板（.image-flow/prompts/ 下的 .md 文件，选中追加到提示词）">
				<select
					className="tpl-select"
					value=""
					onChange={(e) => applyTemplate(e.target.value)}
				>
					<option value="" disabled hidden>{templates.length ? '插入模板…' : '暂无模板'}</option>
					{templates.map((t) => (
						<option key={t.name} value={t.name}>
							{t.name}
						</option>
					))}
				</select>
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

			<div className="row">
				<Select
					label="模型"
					value={config.editModel}
					options={options.model}
					onChange={(v) => onChange('editModel', v)}
				/>
				<Select
					label="分辨率"
					value={config.editImageSize}
					options={options.imageSize}
					onChange={(v) => onChange('editImageSize', v)}
				/>
				<Select
					label="比例"
					value={config.editAspectRatio}
					options={options.aspectRatio}
					onChange={(v) => onChange('editAspectRatio', v)}
				/>
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
					className="preview-btn"
					onClick={() => vscode.postMessage({ type: 'editPreviewRequest', prompt })}
				>
					预览请求
				</button>
				<button className="gen-btn" disabled={busy || cooling} onClick={generate}>
					{busy ? '生成中…' : '生成'}
				</button>
			</div>

			<div className={`status${status.error ? ' error' : ''}`}>{status.text}</div>
		</div>
	);
}
