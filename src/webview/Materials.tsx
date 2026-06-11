import { useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import type { WebviewLibrary } from './vscode';
import { vscode } from './vscode';

/** 单个素材库行：点击标题展开/收起，展开后按真实比例显示缩略图 */
function LibRow({
	lib,
	open,
	onToggle,
	onRemove,
}: {
	lib: WebviewLibrary;
	open: boolean;
	onToggle: () => void;
	onRemove?: () => void;
}) {
	return (
		<Collapsible.Root className="lib" open={open} onOpenChange={onToggle}>
			<Collapsible.Trigger asChild>
				<div className="lib-head">
					<span className="lib-caret" data-open={open}>
						▸
					</span>
					<span className="lib-name">{lib.name}</span>
					<span className="lib-count">{lib.images.length}</span>
					{onRemove && (
						<button
							className="lib-remove"
							title="移除素材库"
							onClick={(e) => {
								e.stopPropagation();
								onRemove();
							}}
						>
							×
						</button>
					)}
				</div>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div className="thumbs">
					{lib.images.map((img) => (
						<img
							key={img.uri}
							src={img.src}
							title={`${img.name}（左键打开 · 右键插入引用 · 可拖入编辑区）`}
							draggable
							onDragStart={(e) =>
								e.dataTransfer.setData('application/x-imageflow-uri', img.uri)
							}
							onClick={() => vscode.postMessage({ type: 'openImage', uri: img.uri })}
							onContextMenu={(e) => {
								e.preventDefault();
								vscode.postMessage({ type: 'insertImage', uri: img.uri });
							}}
						/>
					))}
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** 素材库区：上段为随当前 Markdown 路径自动生成的库，下段为手动添加的库 */
export function Materials({
	autoLibraries,
	libraries,
	cols,
	onAdd,
	onRemove,
}: {
	autoLibraries: WebviewLibrary[];
	libraries: WebviewLibrary[];
	cols: number;
	onAdd: () => void;
	onRemove: (folder: string) => void;
}) {
	// 已展开的库（folder 集合），默认全部收起
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const toggle = (folder: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			next.has(folder) ? next.delete(folder) : next.add(folder);
			return next;
		});

	return (
		<div className="materials" style={{ ['--cols' as string]: cols }}>
			<div className="materials-head">
				<span className="materials-title">当前路径</span>
			</div>
			{autoLibraries.length === 0 ? (
				<div className="empty">打开 Markdown 后自动加载所在路径各层目录的图片。</div>
			) : (
				autoLibraries.map((lib) => (
					<LibRow
						key={lib.folder}
						lib={lib}
						open={expanded.has(`auto:${lib.folder}`)}
						onToggle={() => toggle(`auto:${lib.folder}`)}
					/>
				))
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
				libraries.map((lib) => (
					<LibRow
						key={lib.folder}
						lib={lib}
						open={expanded.has(`manual:${lib.folder}`)}
						onToggle={() => toggle(`manual:${lib.folder}`)}
						onRemove={() => onRemove(lib.folder)}
					/>
				))
			)}
		</div>
	);
}
