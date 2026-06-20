import { vscode, type WebviewCollection } from './vscode';
import { Thumb, openImageClick } from './Thumb';
import { usePicker } from './usePicker';

/** 收藏标签页：顶部收藏夹栏（切换浏览 + 设为当前），下方缩略图网格 */
export function Favorites({
	hidden,
	collections,
	activeCollectionId,
	cols,
	tabCols,
	onSendToEdit,
}: {
	hidden: boolean;
	collections: WebviewCollection[];
	activeCollectionId: string;
	cols: number;
	tabCols: number;
	onSendToEdit: (uri: string) => void;
}) {
	const { current, setSelected: setViewing } = usePicker(
		collections,
		(c) => c.id,
		activeCollectionId,
	);

	// 取名 / 删除确认都交给扩展宿主弹原生对话框（webview 禁用 window.prompt/confirm）
	const createCollection = () => vscode.postMessage({ type: 'createCollection' });
	const rename = (id: string) => vscode.postMessage({ type: 'renameCollection', id });
	const remove = (id: string) => vscode.postMessage({ type: 'deleteCollection', id });

	return (
		<div
			className="page picker-page"
			data-page="favorites"
			hidden={hidden}
			style={{ ['--cols' as string]: cols, ['--tab-cols' as string]: tabCols }}
			data-compact={tabCols >= 3 ? 'true' : undefined}
		>
			<div className="picker-bar">
				{collections.map((c) => (
					<button
						key={c.id}
						className="picker-chip"
						data-active={c.id === current?.id}
						onClick={() => setViewing(c.id)}
					>
						<span className="chip-name">{c.name}</span>
						<span className="chip-sub">{c.images.length}</span>
						{c.id === activeCollectionId && <span className="chip-pin">📌</span>}
					</button>
				))}
			</div>

			{current && (
				<div className="fav-actions">
					<button className="link" onClick={createCollection}>
						+ 新建
					</button>
					<button
						className="link"
						disabled={current.id === activeCollectionId}
						onClick={() => vscode.postMessage({ type: 'setActiveCollection', collectionId: current.id })}
					>
						默认收藏到此文件夹
					</button>
					<button className="link" onClick={() => rename(current.id)}>重命名</button>
					<button
						className="link"
						disabled={collections.length <= 1}
						onClick={() => remove(current.id)}
					>
						删除
					</button>
					<button
						className="link"
						disabled={current.images.length === 0}
						onClick={() => vscode.postMessage({ type: 'exportCollection', collectionId: current.id })}
					>
						一键导出
					</button>
				</div>
			)}

			<div className="picker-body">
				{!current || current.images.length === 0 ? (
					<div className="empty">这个收藏夹还没有图。左键图片上的 ☆ 即可收藏。</div>
				) : (
					<div className="thumbs thumbs-lg">
						{current.images.map((img) => (
							<Thumb
								key={img.uri}
								src={img.src}
								title={img.name}
								uri={img.uri}
								onClick={openImageClick(img.uri)}
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
				)}
			</div>
		</div>
	);
}
