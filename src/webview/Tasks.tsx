import { useEffect, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
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

/** 把毫秒时长格式化为 mm:ss（超过一小时则 h:mm:ss） */
function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const pad = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 已进行时间：每秒自增，从任务 createdAt 起算 */
function useElapsed(createdAt: number): string {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return formatElapsed(now - createdAt);
}

/** 进行中任务卡片：标题可展开/收起，展开后显示进度条 + 已存缩略图 + 进度/失败提示 */
function PendingCard({ task }: { task: WebviewPendingTask }) {
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
					{task.folder}（{task.model}） · {headline}
					{task.failed > 0 ? ` · 失败 ${task.failed}` : ''} · {elapsed}
				</div>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div className="progress-row">
					<div className="progress-bar">
						<div className="progress-fill" style={{ width: `${task.progress}%` }} />
					</div>
					<span className="progress-pct">{task.progress}%</span>
				</div>
				{task.images.length > 0 && <Thumbs images={task.images} />}
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
function HistoryCard({ task }: { task: WebviewTask }) {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible.Root className="task" open={open} onOpenChange={setOpen}>
			<Collapsible.Trigger asChild>
				<div className="folder">
					<span className="task-caret" data-open={open}>
						▸
					</span>
					{task.folder}（{task.images.length} 张）
				</div>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<Thumbs images={task.images} />
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** 任务页：进行中与历史合并为一条按时间倒序的列表（不分图层），点击标题展开/收起 */
export function Tasks({
	hidden,
	tasks,
	pendingTasks,
	cols,
}: {
	hidden: boolean;
	tasks: WebviewTask[];
	pendingTasks: WebviewPendingTask[];
	cols: number;
}) {
	const empty = tasks.length === 0 && pendingTasks.length === 0;
	// 进行中与历史按文件夹名（含时间戳 task-yyMMddHHmmSS-seq）倒序合并，新任务在前
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
						<PendingCard key={item.task.id} task={item.task} />
					) : (
						<HistoryCard key={item.task.folder} task={item.task} />
					)
				)
			)}
		</div>
	);
}
