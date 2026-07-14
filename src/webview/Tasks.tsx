import { useEffect, useState } from 'react';
import {
	vscode,
	type WebviewTask,
	type WebviewPendingTask,
	type WebviewImage,
	type WebviewCollection,
} from './vscode';
import { Thumb, openImageClick } from './Thumb';
import { usePicker } from './usePicker';

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
				<Thumb
					key={img.uri}
					src={img.src}
					title={img.name}
					uri={img.uri}
					name={img.name}
					media={img.media}
					draggable
					onClick={openImageClick(img.uri)}
					collections={collections}
					favorited={img.favorited}
				>
					<button
						className="thumb-action"
						title="送入编辑"
						onClick={() => onSendToEdit(img.uri)}
					>
						✎
					</button>
					<button
						className="thumb-rename"
						title="重命名文件"
						onClick={(e) => {
							e.stopPropagation();
							vscode.postMessage({ type: 'renameImage', uri: img.uri });
						}}
					>
						R
					</button>
				</Thumb>
			))}
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

/**
 * 任务创建时间：解析文件夹标识 yyMMdd/HHmmssSSS（createTaskFolder 的两级格式）为本地时间。
 * 同年省略年份、跨年带年（例：6月27日 19:15 / 2025年12月27日 19:15）。
 * 旧项目等非该格式的文件夹解析不出有效时间，返回 null —— 上层据此不显示。
 */
function formatCreated(folder: string): string | null {
	if (!/^\d{6}\/\d{9}$/.test(folder)) {
		return null;
	}
	const digits = folder.replace('/', '');
	const num = (a: number, b: number) => Number(digits.slice(a, b));
	const year = 2000 + num(0, 2);
	const month = num(2, 4);
	const day = num(4, 6);
	const d = new Date(year, month - 1, day, num(6, 8), num(8, 10));
	// 回环校验：拒绝月/日越界（如 13 月）的伪时间戳
	if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
		return null;
	}
	const pad = (n: number) => String(n).padStart(2, '0');
	const md = `${month}月${day}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return year === new Date().getFullYear() ? md : `${year}年${md}`;
}

/** 平均单图生成时间：对成功图片的 durations 求均（只统计成功的）；无数据返回 null —— 上层据此不显示 */
function averageDuration(durations?: number[]): string | null {
	if (!durations || durations.length === 0) {
		return null;
	}
	const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length;
	return formatElapsed(avg);
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

/** 进行中任务详情：进度条 + 已存缩略图 + 进度/失败提示 */
function PendingDetail({
	task,
	collections,
	onSendToEdit,
}: {
	task: WebviewPendingTask;
	collections: WebviewCollection[];
	onSendToEdit: (uri: string) => void;
}) {
	const elapsed = useElapsed(task.startedAt);
	// 阶段：创建中（解析提示词/归档参考图，视频参考大文件耗时明显）→ 提交中 → 生成中。
	// 还有 job 没拿到 id 即「提交中」，进度条按已提交占比走；全部提交完转「生成中」用聚合进度。
	// sync adapter 的提交就是整图生成（无独立 job id、无远端进度），故这一阶段直接叫「生成中」。
	const submitted = task.total - task.submitting;
	const inSubmit = task.submitting > 0;
	const barPct = inSubmit ? Math.round((submitted / task.total) * 100) : task.progress;
	const submitLabel = task.creating ? '创建中' : task.sync ? '生成中' : '提交中';
	return (
		<div className="task-detail">
			{/* 头部与历史详情一致：提示词链接 + 模型 + 分辨率 + 比例 + 进度（已存/总数） */}
			<div className="task-detail-head">
				{/* 创建阶段提示词文件尚未写盘，禁点避免打开失败报错 */}
				<button
					className="link"
					title="打开提示词文件"
					disabled={task.creating}
					onClick={() => vscode.postMessage({ type: 'openPrompt', folder: task.folder })}
				>
					{`${task.promptName}.md`}
				</button>
				<span className="task-model">{task.model}</span>
				<span>{task.imageSize}</span>
				<span>{task.aspectRatio}</span>
				{/* 进行中 done/total 是进度而非成功率，加粗 + 链接色以醒目（已完成/提交或生成中的总数） */}
				<span className="task-progress-count">
					{task.done}/{task.total}
				</span>
				<span className="task-elapsed">{elapsed}</span>
			</div>
			<div className="progress-row">
				<div className="progress-bar">
					{/* 两段式进度条：提交阶段按「已提交/总数」涨满，全部提交后切回生成聚合进度从头演示 */}
					<div className="progress-fill" style={{ width: `${barPct}%` }} />
				</div>
				<span className="progress-pct">
					{inSubmit ? `${submitLabel} ${submitted}/${task.total}` : `生成中 ${task.progress}%`}
				</span>
			</div>
			{task.images.length > 0 && (
				<Thumbs images={task.images} collections={collections} onSendToEdit={onSendToEdit} />
			)}
			{task.errors.length > 0 && <div className="pending-err">{task.errors.join('；')}</div>}
		</div>
	);
}

/** 历史任务详情：成功率 + 缩略图 */
function HistoryDetail({
	task,
	collections,
	onSendToEdit,
}: {
	task: WebviewTask;
	collections: WebviewCollection[];
	onSendToEdit: (uri: string) => void;
}) {
	const { meta } = task;
	const avg = averageDuration(meta?.durations);
	const created = formatCreated(task.folder);
	return (
		<div className="task-detail">
			<div className="task-detail-head">
				<button
					className="link"
					title="打开提示词文件"
					onClick={() => vscode.postMessage({ type: 'openPrompt', folder: task.folder })}
				>
					{task.promptName ? `${task.promptName}.md` : '提示词'}
				</button>
				{meta ? (
					<>
						<span className="task-model">{meta.model}</span>
						{/* 构建并复制任务的分辨率/比例在外部设定、此处为空，空值不渲染避免 flex 间隙 */}
						{meta.imageSize && <span>{meta.imageSize}</span>}
						{meta.aspectRatio && <span>{meta.aspectRatio}</span>}
						<span className={rateClass(meta.succeeded, meta.requested)}>
							{meta.succeeded}/{meta.requested}
						</span>
					</>
				) : (
					<span>{task.images.length} 张</span>
				)}
				{/* 平均耗时与创建时间成组靠右、创建时间最右；任一为空则各自不显示 */}
				{(avg || created) && (
					<span className="task-times">
						{avg && (
							<span className="task-avg" title="平均单图生成时间（只统计成功的）">
								平均耗时 {avg}
							</span>
						)}
						{created && (
							<span className="task-created" title="任务创建时间">
								{created}
							</span>
						)}
					</span>
				)}
			</div>
			<Thumbs images={task.images} collections={collections} onSendToEdit={onSendToEdit} />
		</div>
	);
}

/** 任务页：进行中与历史合并成一条按时间倒序的选择栏，点条目在下方固定区看详情 */
export function Tasks({
	hidden,
	tasks,
	pendingTasks,
	collections,
	cols,
	tabCols,
	unreadTasks,
	onViewed,
	onSendToEdit,
	reveal,
}: {
	hidden: boolean;
	tasks: WebviewTask[];
	pendingTasks: WebviewPendingTask[];
	collections: WebviewCollection[];
	cols: number;
	tabCols: number;
	/** 未读任务的文件夹标识集合：在其中的历史任务亮未读特效 */
	unreadTasks: Set<string>;
	/** 点开完成任务卡片时回调，消掉未读 */
	onViewed: (folder: string) => void;
	onSendToEdit: (uri: string) => void;
	/** 完成通知点「查看」要定位的任务：folder + nonce（同任务可重复触发） */
	reveal?: { folder: string; nonce: number } | null;
}) {
	// 进行中与历史按文件夹标识（天/时刻）倒序合并，新任务在前
	const items = [
		...pendingTasks.map((t) => ({ key: `p:${t.id}`, folder: t.folder, kind: 'pending' as const, task: t })),
		...tasks.map((t) => ({ key: `h:${t.folder}`, folder: t.folder, kind: 'history' as const, task: t })),
	].sort((a, b) => (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0));

	// 选中失效（任务完成转历史 / 列表刷新）回落到第一个
	const { current, setSelected } = usePicker(items, (i) => i.key);

	// 收到 reveal（点完成通知「查看」）：按 folder 选中对应条目。
	// 通知先于完成刷新弹出，点得快时该任务可能仍是进行中：其转历史时 key 从 p: 变 h:、
	// kind 变化让本效果补跑一次重新选中（每个 reveal 至多补跑一次，不随列表刷新反复抢占手动选择）。
	const revealTarget = reveal ? items.find((i) => i.folder === reveal.folder) : undefined;
	useEffect(() => {
		if (revealTarget) {
			setSelected(revealTarget.key);
		}
	}, [reveal?.nonce, revealTarget?.kind]);

	// 详情已展示即已读：任务页可见且选中的是历史任务时消其未读（点击卡片、reveal 定位、
	// 盯着进行中卡片看它完成——所有让详情呈现在眼前的路径都统一走这里）
	useEffect(() => {
		if (!hidden && current?.kind === 'history' && unreadTasks.has(current.folder)) {
			onViewed(current.folder);
		}
	});

	return (
		<div
			className="page picker-page"
			data-page="tasks"
			hidden={hidden}
			style={{ ['--cols' as string]: cols, ['--tab-cols' as string]: tabCols }}
			data-compact={tabCols >= 3 ? 'true' : undefined}
		>
			{items.length === 0 ? (
				<div className="empty">暂无生成记录。</div>
			) : (
				<>
					<div className="picker-bar">
						{items.map((item) => {
							const title =
								item.kind === 'pending'
									? item.task.title || item.task.promptName
									: item.task.meta?.title || item.task.promptName;
							const model =
								item.kind === 'pending' ? item.task.model : item.task.meta?.model;
							// 成功率优先展示：进行中用 已存/总数，历史用 成功/申请
							const rate =
								item.kind === 'pending'
									? `${item.task.done}/${item.task.total}`
									: item.task.meta
										? `${item.task.meta.succeeded}/${item.task.meta.requested}`
										: undefined;
							// 与详情行一致的成功率配色
							const rateCls =
								item.kind === 'pending'
									? rateClass(item.task.done, item.task.total)
									: item.task.meta
										? rateClass(item.task.meta.succeeded, item.task.meta.requested)
										: '';
							// 已完成但未点开看过的任务亮未读特效（进行中任务恒亮 data-pending）。
							// 未读集合只在任务创建时登记，「构建并复制」（requested=0）等旧任务不会在其中。
							const unseen = item.kind === 'history' && unreadTasks.has(item.folder);
							return (
								<button
									key={item.key}
									className="picker-chip"
									data-active={current?.key === item.key}
									data-pending={item.kind === 'pending' || undefined}
									data-unseen={unseen || undefined}
									// 消未读不在此处理：选中后由「详情已展示即已读」效果统一消除
									onClick={() => setSelected(item.key)}
								>
									<span className="chip-name">{title}</span>
									{tabCols <= 1 && model && <span className="chip-sub">{model}</span>}
									{tabCols <= 3 && rate && (
										<span className={`chip-rate ${rateCls}`}>{rate}</span>
									)}
								</button>
							);
						})}
					</div>
					<div className="picker-body">
						{current &&
							(current.kind === 'pending' ? (
								<PendingDetail
									task={current.task}
									collections={collections}
									onSendToEdit={onSendToEdit}
								/>
							) : (
								<HistoryDetail
									task={current.task}
									collections={collections}
									onSendToEdit={onSendToEdit}
								/>
							))}
					</div>
				</>
			)}
		</div>
	);
}
