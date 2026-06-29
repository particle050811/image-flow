import type { ReactNode } from 'react';
import { vscode, type WebviewCollection, type MediaType } from './vscode';
import { StarButton } from './StarButton';

/** 单个缩略图项：统一 thumb-wrap + img + 可选 StarButton + 角标/动作 children。
 *  各调用方通过 props 表达差异（是否可拖拽 / 点击行为 / 右键行为 / 是否渲染星标），
 *  外层网格容器（含 --cols 样式）仍由各页自行渲染，这里只抽「单个项」这一层。 */
export function Thumb({
	src,
	title,
	uri,
	name,
	media,
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
	/** 文件名；音/视频瓦片显示出来以与图片区分（图片不显示，沿用 title 悬浮提示） */
	name?: string;
	/** 媒体大类，缺省按图片渲染 <img>；音/视频改用原生 <audio>/<video> */
	media?: MediaType;
	draggable?: boolean;
	onClick?: () => void;
	onContextMenu?: (e: React.MouseEvent) => void;
	/** 传入 collections 即渲染 StarButton（需配套 uri）；不传则无星标（如编辑区） */
	collections?: WebviewCollection[];
	favorited?: boolean;
	/** 额外角标 / 动作按钮（✎ 送编辑、序号、× 移除等） */
	children?: ReactNode;
}) {
	const isMedia = media === 'audio' || media === 'video';
	// 左键打开 / 右键 / 拖拽（送编辑取 uri）三套句柄，图片与音视频瓦片共用——
	// 音视频不挂内联控件，行为与图片缩略图一致：左键在编辑器里打开（含原生播放器）
	const onDragStart =
		draggable && uri
			? (e: React.DragEvent) => e.dataTransfer.setData('application/x-imageflow-uri', uri)
			: undefined;
	const handlers = { title, draggable, onDragStart, onClick, onContextMenu };
	return (
		<div className="thumb-wrap" data-media={media ?? 'image'}>
			{media === 'video' ? (
				// 视频自带首帧作缩略；preload=metadata 只拉首帧不下整片，muted 防意外出声
				<video className="thumb-media" src={src} preload="metadata" muted {...handlers} />
			) : media === 'audio' ? (
				// 音频无画面，用占位块 + 下方文件名表示；点开同样进编辑器原生播放器
				<div className="thumb-media thumb-audio" {...handlers}>
					<span className="thumb-audio-icon">♪</span>
				</div>
			) : (
				<img src={src} {...handlers} />
			)}
			{isMedia && name && (
				<div className="thumb-name" title={name}>
					{name}
				</div>
			)}
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
