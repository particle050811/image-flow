import { useEffect, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
	vscode,
	type WebviewTask,
	type WebviewPendingTask,
	type WebviewImage,
	type WebviewCollection,
} from './vscode';
import { StarButton } from './StarButton';

/** 缩略图网格：点击打开原图；可拖拽（送编辑区）；hover 右上角 ✎ 一键送编辑；左上角 ⭐ 收藏 */
function Thumbs({
	images,
	collections,
	onSendToEdit,
}: {
	images: WebviewImage[];
	collections: WebviewCollection[];
	onSendToEdit: (uri: string) => void;
}) {
	return (
		<div className="thumbs thumbs-lg">
			{images.map((img) => (
				<div className="thumb-wrap" key={img.uri}>
					<img
						src={img.src}
						title={img.name}
						draggable
						onDragStart={(e) => e.dataTransfer.setData('application/x-imageflow-uri', img.uri)}
						onClick={() => vscode.postMessage({ type: 'openImage', uri: img.uri })}
					/>
					<button
						className="thumb-action"
						title="送入编辑"
						onClick={() => onSendToEdit(img.uri)}
					>
						✎
					</button>
					<StarButton uri={img.uri} favorited={img.favorited} collections={collections} />
				</div>
			))}
		</div>
	);
}

/** 查看本任务提交的提示词（打开任务文件夹内的 .md 文件） */
function PromptButton({ folder }: { folder: string }) {
	return (
		<div className="task-actions">
			<button
				className="link"
				onClick={() => vscode.postMessage({ type: 'openPrompt', folder })}
			>
				查看提示词
			</button>
		</div>
	);
}

/** 成功率配色类：≥75% 绿、≤25% 红、中间黄（requested 为 0 时按红处理） */
function rateClass(succeeded: number, requested: number): string {
	const rate = requested > 0 ? succeeded / requested : 0;
	if (rate >= 0.75) {
		return 'rate-good';
	}
	if (rate <= 0.25) {
		return 'rate-bad';
	}
	return 'rate-mid';
}

/** 把毫秒时长格式化为 mm:ss（超过一小时则 h:mm:ss） */
function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const pad = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 已进行时间：每秒自增，从任务首次提交时间（startedAt，真实墙钟、不随重启重置）起算 */
function useElapsed(startedAt: number): string {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return formatElapsed(now - startedAt);
}

/** 进行中任务卡片：标题可展开/收起，展开后显示进度条 + 已存缩略图 + 进度/失败提示 */
function PendingCard({
	task,
	collections,
	onSendToEdit,
}: {
	task: WebviewPendingTask;
	collections: WebviewCollection[];
	onSendToEdit: (uri: string) => void;
}) {
	const [open, setOpen] = useState(true);
	const elapsed = useElapsed(task.startedAt);
	const running = task.total - task.done - task.failed - task.submitting;
	// 提交阶段（尚无 job id）显示「提交中」，其余显示生成进度
	const headline =
		task.submitting > 0
			? `提交中 ${task.submitting}/${task.total}`
			: `生成中 ${task.done}/${task.total}`;
	return (
		<Collapsible.Root className="task pending" open={open} onOpenChange={setOpen}>
			<Collapsible.Trigger asChild>
				<div className="folder">
					<span className="task-caret" data-open={open}>
						▸
					</span>
					<span className="task-name">{task.title || task.promptName}</span>
					<span className="task-right">
						<span className="task-model">{task.model}</span>
						<span>
							{headline}
							{task.failed > 0 ? ` · 失败 ${task.failed}` : ''} · {elapsed}
						</span>
					</span>
				</div>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div className="progress-row">
					<div className="progress-bar">
						<div className="progress-fill" style={{ width: `${task.progress}%` }} />
					</div>
					<span className="progress-pct">{task.progress}%</span>
				</div>
				<PromptButton folder={task.folder} />
				{task.images.length > 0 && (
					<Thumbs images={task.images} collections={collections} onSendToEdit={onSendToEdit} />
				)}
				{task.submitting > 0 && (
					<div className="pending-hint">正在提交 {task.submitting} 个请求…</div>
				)}
				{running > 0 && <div className="pending-hint">还有 {running} 张正在生成…</div>}
				{task.errors.length > 0 && <div className="pending-err">{task.errors.join('；')}</div>}
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** 历史任务卡片：标题可展开/收起，默认收起 */
function HistoryCard({
	task,
	collections,
	onSendToEdit,
}: {
	task: WebviewTask;
	collections: WebviewCollection[];
	onSendToEdit: (uri: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const { meta } = task;
	const title = meta?.title || task.promptName;
	return (
		<Collapsible.Root className="task" open={open} onOpenChange={setOpen}>
			<Collapsible.Trigger asChild>
				<div className="folder">
					<span className="task-caret" data-open={open}>
						▸
					</span>
					<span className="task-name">{title}</span>
					{meta ? (
						<span className="task-right">
							<span className="task-model">{meta.model}</span>
							<span className={rateClass(meta.succeeded, meta.requested)}>
								{meta.succeeded}/{meta.requested}
							</span>
						</span>
					) : (
						<span className="task-right">{task.images.length} 张</span>
					)}
				</div>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<PromptButton folder={task.folder} />
				<Thumbs images={task.images} collections={collections} onSendToEdit={onSendToEdit} />
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** 任务页：进行中与历史合并为一条按时间倒序的列表，点击标题展开/收起 */
export function Tasks({
	hidden,
	tasks,
	pendingTasks,
	collections,
	cols,
	onSendToEdit,
}: {
	hidden: boolean;
	tasks: WebviewTask[];
	pendingTasks: WebviewPendingTask[];
	collections: WebviewCollection[];
	cols: number;
	onSendToEdit: (uri: string) => void;
}) {
	const empty = tasks.length === 0 && pendingTasks.length === 0;
	// 进行中与历史按文件夹名（毫秒时间戳）倒序合并，新任务在前
	const items = [
		...pendingTasks.map((t) => ({ folder: t.folder, kind: 'pending' as const, task: t })),
		...tasks.map((t) => ({ folder: t.folder, kind: 'history' as const, task: t })),
	].sort((a, b) => (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0));
	return (
		<div
			className="page"
			data-page="tasks"
			hidden={hidden}
			style={{ ['--cols' as string]: cols }}
		>
			{empty ? (
				<div className="empty">暂无生成记录。</div>
			) : (
				items.map((item) =>
					item.kind === 'pending' ? (
						<PendingCard
							key={item.task.id}
							task={item.task}
							collections={collections}
							onSendToEdit={onSendToEdit}
						/>
					) : (
						<HistoryCard
							key={item.task.folder}
							task={item.task}
							collections={collections}
							onSendToEdit={onSendToEdit}
						/>
					)
				)
			)}
		</div>
	);
}
