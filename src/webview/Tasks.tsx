import { useState } from 'react';
import { vscode, type WebviewTask, type WebviewPendingTask } from './vscode';

/** 缩略图网格：点击打开原图 */
function Thumbs({ images }: { images: { uri: string; src: string; name: string }[] }) {
	return (
		<div className="thumbs thumbs-lg">
			{images.map((img) => (
				<img
					key={img.uri}
					src={img.src}
					title={img.name}
					onClick={() => vscode.postMessage({ type: 'openImage', uri: img.uri })}
				/>
			))}
		</div>
	);
}

/** 进行中任务卡片：标题可展开/收起，展开后显示已存缩略图 + 进度/失败提示 */
function PendingCard({ task }: { task: WebviewPendingTask }) {
	const [open, setOpen] = useState(true);
	const running = task.total - task.done - task.failed;
	return (
		<div className="task pending">
			<div className="folder" onClick={() => setOpen((v) => !v)}>
				<span className="task-caret">{open ? '▾' : '▸'}</span>
				{task.folder}（{task.model}） · 生成中 {task.done}/{task.total}
				{task.failed > 0 ? ` · 失败 ${task.failed}` : ''}
			</div>
			{open && (
				<>
					{task.images.length > 0 && <Thumbs images={task.images} />}
					{running > 0 && <div className="pending-hint">还有 {running} 张正在生成…</div>}
					{task.errors.length > 0 && <div className="pending-err">{task.errors.join('；')}</div>}
				</>
			)}
		</div>
	);
}

/** 历史任务卡片：标题可展开/收起，默认收起 */
function HistoryCard({ task }: { task: WebviewTask }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="task">
			<div className="folder" onClick={() => setOpen((v) => !v)}>
				<span className="task-caret">{open ? '▾' : '▸'}</span>
				{task.folder}（{task.images.length} 张）
			</div>
			{open && <Thumbs images={task.images} />}
		</div>
	);
}

/** 任务页：顶部展示生成中任务，下方按时间倒序展示历史，点击标题展开/收起 */
export function Tasks({
	hidden,
	tasks,
	pendingTasks,
	thumbSize,
}: {
	hidden: boolean;
	tasks: WebviewTask[];
	pendingTasks: WebviewPendingTask[];
	thumbSize: number;
}) {
	const empty = tasks.length === 0 && pendingTasks.length === 0;
	return (
		<div
			className="page"
			data-page="tasks"
			hidden={hidden}
			style={{ ['--thumb-size' as string]: `${thumbSize}px` }}
		>
			{pendingTasks.map((task) => (
				<PendingCard key={task.id} task={task} />
			))}
			{empty ? (
				<div className="empty">暂无生成记录。</div>
			) : (
				tasks.map((task) => <HistoryCard key={task.folder} task={task} />)
			)}
		</div>
	);
}
