import { useState } from 'react';
import { vscode, type WebviewCollection } from './vscode';

/** 收藏星标：左键 toggle 进当前夹；右键弹菜单移动到指定夹 */
export function StarButton({
	uri,
	favorited,
	collections,
}: {
	uri: string;
	favorited?: boolean;
	collections: WebviewCollection[];
}) {
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	return (
		<>
			<button
				className="thumb-star"
				data-on={favorited ? 'true' : 'false'}
				title={favorited ? '已收藏（左键取消 · 右键移动到其它收藏夹）' : '收藏到当前收藏夹（右键选夹）'}
				onClick={(e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'toggleFavorite', uri });
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					setMenu({ x: e.clientX, y: e.clientY });
				}}
			>
				{favorited ? '★' : '☆'}
			</button>
			{menu && (
				<>
					<div className="star-menu-backdrop" onClick={() => setMenu(null)} />
					<ul className="star-menu" style={{ left: menu.x, top: menu.y }}>
						{collections.map((c) => (
							<li
								key={c.id}
								onClick={() => {
									vscode.postMessage({ type: 'moveFavoriteTo', uri, collectionId: c.id });
									setMenu(null);
								}}
							>
								{favorited ? '移动到' : '收藏到'}「{c.name}」
							</li>
						))}
					</ul>
				</>
			)}
		</>
	);
}
