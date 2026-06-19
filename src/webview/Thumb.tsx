import type { ReactNode } from 'react';
import { vscode, type WebviewCollection } from './vscode';
import { StarButton } from './StarButton';

/** 单个缩略图项：统一 thumb-wrap + img + 可选 StarButton + 角标/动作 children。
 *  各调用方通过 props 表达差异（是否可拖拽 / 点击行为 / 右键行为 / 是否渲染星标），
 *  外层网格容器（含 --cols 样式）仍由各页自行渲染，这里只抽「单个项」这一层。 */
export function Thumb({
	src,
	title,
	uri,
	draggable,
	onClick,
	onContextMenu,
	collections,
	favorited,
	children,
}: {
	src: string;
	title: string;
	/** 收藏所需的图片 Uri；仅在渲染星标时使用 */
	uri?: string;
	draggable?: boolean;
	onClick?: () => void;
	onContextMenu?: (e: React.MouseEvent) => void;
	/** 传入 collections 即渲染 StarButton（需配套 uri）；不传则无星标（如编辑区） */
	collections?: WebviewCollection[];
	favorited?: boolean;
	/** 额外角标 / 动作按钮（✎ 送编辑、序号、× 移除等） */
	children?: ReactNode;
}) {
	return (
		<div className="thumb-wrap">
			<img
				src={src}
				title={title}
				draggable={draggable}
				onDragStart={
					draggable && uri
						? (e) => e.dataTransfer.setData('application/x-imageflow-uri', uri)
						: undefined
				}
				onClick={onClick}
				onContextMenu={onContextMenu}
			/>
			{children}
			{collections && uri && (
				<StarButton uri={uri} favorited={favorited} collections={collections} />
			)}
		</div>
	);
}

/** 把 openImage 消息封装成点击处理器，省去各页重复写 postMessage */
export function openImageClick(uri: string) {
	return () => vscode.postMessage({ type: 'openImage', uri });
}
