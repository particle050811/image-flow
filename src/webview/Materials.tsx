import type { WebviewLibrary, WebviewCollection } from './vscode';
import { vscode } from './vscode';
import { Thumb, openImageClick } from './Thumb';
import { usePicker } from './usePicker';

/** 选中素材库的缩略图网格：左键打开 / 右键插入引用 / 可拖入编辑区 */
function LibThumbs({
	lib,
	collections,
	onSendToEdit,
}: {
	lib: WebviewLibrary;
	collections: WebviewCollection[];
	onSendToEdit: (uri: string) => void;
}) {
	if (lib.images.length === 0) {
		return <div className="empty">这个素材库没有图片。</div>;
	}
	return (
		<div className="thumbs">
			{lib.images.map((img) => (
				<Thumb
					key={img.uri}
					src={img.src}
					name={img.name}
					media={img.media}
					title={`${img.name}（左键打开 · 右键插入引用 · 可拖入编辑区）`}
					uri={img.uri}
					draggable
					onClick={openImageClick(img.uri)}
					onContextMenu={(e) => {
						e.preventDefault();
						vscode.postMessage({ type: 'insertImage', uri: img.uri });
					}}
					collections={collections}
					favorited={img.favorited}
				>
					<button
						className="thumb-action"
						title="送入编辑"
						onClick={(e) => {
							e.stopPropagation();
							onSendToEdit(img.uri);
						}}
					>
						✎
					</button>
				</Thumb>
			))}
		</div>
	);
}

/** 素材库区：上段为随当前 Markdown 路径自动生成的库，下段为手动添加的库。
 *  选择栏式——点库名切换，下方固定区显示该库缩略图（替代逐库手风琴展开）。 */
export function Materials({
	autoLibraries,
	libraries,
	collections,
	cols,
	tabCols,
	onAdd,
	onRemove,
	onSendToEdit,
}: {
	autoLibraries: WebviewLibrary[];
	libraries: WebviewLibrary[];
	collections: WebviewCollection[];
	cols: number;
	tabCols: number;
	onAdd: () => void;
	onRemove: (folder: string) => void;
	onSendToEdit: (uri: string) => void;
}) {
	// 选中库的 key：auto:<folder> / manual:<folder>，跨两组唯一
	const items = [
		...autoLibraries.map((lib) => ({ key: `auto:${lib.folder}`, lib })),
		...libraries.map((lib) => ({ key: `manual:${lib.folder}`, lib })),
	];
	// 选中失效（切换 MD、移除库）回落到第一个库
	const { current, setSelected } = usePicker(items, (i) => i.key);

	return (
		<div
			className="materials"
			style={{ ['--cols' as string]: cols, ['--tab-cols' as string]: tabCols }}
		>
			<div className="materials-head">
				<span className="materials-title">当前路径</span>
			</div>
			{autoLibraries.length === 0 ? (
				<div className="empty">打开 Markdown 后自动加载所在路径各层目录的图片。</div>
			) : (
				<div className="picker-bar">
					{autoLibraries.map((lib) => (
						<button
							key={lib.folder}
							className="picker-chip"
							data-active={current?.key === `auto:${lib.folder}`}
							onClick={() => setSelected(`auto:${lib.folder}`)}
						>
							<span className="chip-name">{lib.name}</span>
							<span className="chip-sub">{lib.images.length}</span>
						</button>
					))}
				</div>
			)}

			<div className="materials-head">
				<span className="materials-title">素材库</span>
				<button className="lib-add" onClick={onAdd}>
					+ 添加
				</button>
			</div>
			{libraries.length === 0 ? (
				<div className="empty">还没有素材库，点击「添加」选择文件夹。</div>
			) : (
				<div className="picker-bar">
					{libraries.map((lib) => (
						<button
							key={lib.folder}
							className="picker-chip"
							data-active={current?.key === `manual:${lib.folder}`}
							onClick={() => setSelected(`manual:${lib.folder}`)}
						>
							<span className="chip-name">{lib.name}</span>
							<span className="chip-sub">{lib.images.length}</span>
							<span
								className="chip-remove"
								title="移除素材库"
								onClick={(e) => {
									e.stopPropagation();
									onRemove(lib.folder);
								}}
							>
								×
							</span>
						</button>
					))}
				</div>
			)}

			{current && (
				<LibThumbs lib={current.lib} collections={collections} onSendToEdit={onSendToEdit} />
			)}
		</div>
	);
}
