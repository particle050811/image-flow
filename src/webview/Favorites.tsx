import { useState } from 'react';
import { vscode, type WebviewCollection } from './vscode';
import { StarButton } from './StarButton';

/** 收藏标签页：顶部收藏夹栏（切换浏览 + 设为当前），下方缩略图网格 */
export function Favorites({
	hidden,
	collections,
	activeCollectionId,
	cols,
}: {
	hidden: boolean;
	collections: WebviewCollection[];
	activeCollectionId: string;
	cols: number;
}) {
	const [viewing, setViewing] = useState<string>(activeCollectionId);
	const current = collections.find((c) => c.id === viewing) ?? collections[0];

	const createCollection = () => {
		const name = window.prompt('新收藏夹名称');
		if (name) {
			vscode.postMessage({ type: 'createCollection', name });
		}
	};
	const rename = (id: string, old: string) => {
		const name = window.prompt('重命名收藏夹', old);
		if (name && name !== old) {
			vscode.postMessage({ type: 'renameCollection', id, name });
		}
	};
	const remove = (c: WebviewCollection) => {
		if (c.id === 'c_default') {
			return;
		}
		const moveToDefault = c.images.length > 0
			? window.confirm(`「${c.name}」内有 ${c.images.length} 张图。\n确定 = 把图移到默认收藏后删除；取消 = 不删除。`)
			: true;
		if (c.images.length === 0 || moveToDefault) {
			vscode.postMessage({ type: 'deleteCollection', id: c.id, moveToDefault });
		}
	};

	return (
		<div className="page" data-page="favorites" hidden={hidden} style={{ ['--cols' as string]: cols }}>
			<div className="fav-bar">
				{collections.map((c) => (
					<button
						key={c.id}
						className="fav-tab"
						data-viewing={c.id === current?.id}
						data-current={c.id === activeCollectionId}
						onClick={() => setViewing(c.id)}
					>
						{c.id === activeCollectionId ? '📌 ' : ''}{c.name}（{c.images.length}）
					</button>
				))}
				<button className="lib-add" onClick={createCollection}>+ 新建</button>
			</div>

			{current && (
				<div className="fav-actions">
					<button
						className="link"
						disabled={current.id === activeCollectionId}
						onClick={() => vscode.postMessage({ type: 'setActiveCollection', collectionId: current.id })}
					>
						设为当前
					</button>
					<button className="link" onClick={() => rename(current.id, current.name)}>重命名</button>
					{current.id !== 'c_default' && (
						<button className="link" onClick={() => remove(current)}>删除</button>
					)}
					<button
						className="link"
						disabled={current.images.length === 0}
						onClick={() => vscode.postMessage({ type: 'exportCollection', collectionId: current.id })}
					>
						一键导出
					</button>
				</div>
			)}

			{!current || current.images.length === 0 ? (
				<div className="empty">这个收藏夹还没有图。左键图片上的 ☆ 即可收藏。</div>
			) : (
				<div className="thumbs thumbs-lg">
					{current.images.map((img) => (
						<div className="thumb-wrap" key={img.uri}>
							<img
								src={img.src}
								title={img.name}
								onClick={() => vscode.postMessage({ type: 'openImage', uri: img.uri })}
							/>
							<StarButton uri={img.uri} favorited={img.favorited} collections={collections} />
						</div>
					))}
				</div>
			)}
		</div>
	);
}
