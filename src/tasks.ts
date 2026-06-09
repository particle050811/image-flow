import * as vscode from 'vscode';
import { submitGeneration, queryResult, TransientError } from './api';
import { buildPrompt, createTaskFolder, downloadImages, formatStamp } from './command';
import { readConfig } from './config';
import { buildInjectedPrompt } from './inject';
import type { ImageFlowConfig, PendingTask, PendingJob } from './shared';

/** globalState 中存放未完成任务的键 */
const PENDING_KEY = 'image-flow.pendingTasks';
/** 轮询间隔（ms） */
const POLL_INTERVAL = 4000;
/** 单个任务超时兜底（ms）：超过则把仍 running 的 job 标记失败，避免僵死记录永不清除 */
const TASK_TIMEOUT = 10 * 60 * 1000;

/**
 * 是否为可重试的网络瞬时错误。
 * - TransientError：queryResult 显式标记的上游 5xx/429；
 * - 超时经 AbortController 抛 AbortError；
 * - fetch 网络层失败抛 TypeError('fetch failed')，按 message 收窄，避免把真正的编程 TypeError 也当瞬时错误吞掉拖到超时。
 * 其余（响应格式校验失败、写盘失败等）不在此列，应直接标记失败。
 */
export function isTransientNetworkError(err: unknown): boolean {
	if (err instanceof TransientError) {
		return true;
	}
	if (!(err instanceof Error)) {
		return false;
	}
	if (err.name === 'AbortError') {
		return true;
	}
	return err.name === 'TypeError' && /fetch failed/i.test(err.message);
}

/** 任务是否仍活跃：有 job 处于 submitting（提交中）或 running（轮询中）即未终结 */
export function isTaskActive(task: PendingTask): boolean {
	return task.jobs.some((j) => j.status === 'submitting' || j.status === 'running');
}

/**
 * 整任务聚合进度 0~100：每个 job 占 1/total，终结(成功/失败/违规)的 job 记满分，
 * running 取远端进度(缺省按 0)，submitting 记 0，再均摊到百分比。
 */
export function aggregateProgress(jobs: PendingJob[]): number {
	if (!jobs.length) {
		return 0;
	}
	const jobScore = (j: PendingJob): number =>
		j.status === 'running'
			? Math.min(100, Math.max(0, j.progress ?? 0))
			: j.status === 'submitting'
				? 0
				: 100;
	return Math.round(jobs.reduce((sum, j) => sum + jobScore(j), 0) / jobs.length);
}

/**
 * 异步生成任务管理器：负责提交（replyType:async）、持久化、定时轮询拉结果、
 * 完成下载与重启续拉。所有进行中任务共用一个定时器。
 * 任务状态变更（提交/进度/完成）通过 onChange 通知侧栏刷新。
 */
export class TaskManager {
	private tasks: PendingTask[] = [];
	private timer?: ReturnType<typeof setInterval>;
	private listeners = new Set<() => void>();
	/** 轮询重入锁：一轮 poll 的下载可能超过定时器间隔，禁止并发轮询，否则同任务多 job 共享 images.length 计数会下成同名图互相覆盖 */
	private polling = false;
	/** 任务本地 id 的去重序号；重启归零，靠文件夹时间戳保唯一 */
	private seq = 0;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.tasks = context.globalState.get<PendingTask[]>(PENDING_KEY, []);
	}

	/** 订阅任务变更，返回取消订阅函数 */
	onChange(fn: () => void): vscode.Disposable {
		this.listeners.add(fn);
		return new vscode.Disposable(() => this.listeners.delete(fn));
	}

	/** 当前所有进行中任务（含完成中、未清除的） */
	list(): PendingTask[] {
		return this.tasks;
	}

	/** 进行中任务的文件夹名集合，供 listHistory 排除，避免与待办卡片重复 */
	activeFolders(): Set<string> {
		return new Set(this.tasks.map((t) => t.folder));
	}

	private async persist(): Promise<void> {
		await this.context.globalState.update(PENDING_KEY, this.tasks);
	}

	/** 删除任务的空文件夹：submit 时已建夹，若任务无任何成图就移除，避免磁盘累积空 task-* 目录 */
	private async cleanupEmptyFolder(task: PendingTask): Promise<void> {
		if (task.images.length) {
			return;
		}
		try {
			const dir = vscode.Uri.joinPath(vscode.Uri.parse(task.mdUri), '..', task.folder);
			await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
		} catch {
			// 目录不存在或删除失败不影响主流程
		}
	}

	private emit(): void {
		// 监听器回调可能是 async（侧栏的 pushHistory 要扫盘）；包一层吞掉 reject，避免 unhandled rejection
		for (const fn of this.listeners) {
			void Promise.resolve()
				.then(() => fn())
				.catch(() => {});
		}
	}

	/** 有可轮询的 running job 时确保轮询定时器在跑；无则停掉（submitting 态尚无 id，不轮询） */
	private ensureTimer(): void {
		const hasRunning = this.tasks.some((t) => t.jobs.some((j) => j.status === 'running'));
		if (hasRunning && !this.timer) {
			this.timer = setInterval(() => void this.poll(), POLL_INTERVAL);
		} else if (!hasRunning && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * 提交一次生成：本地准备（读文件 → 解析提示词 → 建文件夹）后立即建卡入列返回，
	 * 不干等网络往返。N 个 generate 请求在后台并发发出，拿到 job id 再把 job 由
	 * submitting 转 running 并启动轮询。这样「生成中…」按钮几乎不阻塞。
	 */
	async submit(mdUri: vscode.Uri): Promise<void> {
		const config = await readConfig(this.context);
		const bytes = await vscode.workspace.fs.readFile(mdUri);
		const content = Buffer.from(bytes).toString('utf8').trim();
		if (!content) {
			throw new Error('Markdown 文件内容为空，无法生成。');
		}

		const { prompt: basePrompt, images } = await buildPrompt(mdUri, content);
		const prompt = await buildInjectedPrompt(config, basePrompt);
		const count = Math.max(1, config.concurrency);

		const seq = this.seq++;
		const [folder] = await createTaskFolder(mdUri, seq);
		const task: PendingTask = {
			id: `${formatStamp(new Date())}-${seq}`,
			folder,
			mdUri: mdUri.toString(),
			model: config.model,
			jobs: Array.from({ length: count }, () => ({ status: 'submitting' as const })),
			images: [],
			createdAt: Date.now(),
			startedAt: Date.now(),
		};
		this.tasks.unshift(task);
		await this.persist();
		this.emit();

		// 后台并发提交，拿到 id 即转 running；不 await，调用方立即返回。
		void this.submitJobs(config, task, prompt, images);
	}

	/**
	 * 后台并发发出 N 个 generate 请求，逐个回填 job id（submitting → running）。
	 * 全部失败则整任务作废并提示；否则启动轮询拉结果。
	 */
	private async submitJobs(
		config: ImageFlowConfig,
		task: PendingTask,
		prompt: string,
		images: string[]
	): Promise<void> {
		const submitting = task.jobs.filter((j) => j.status === 'submitting');
		await Promise.all(
			submitting.map(async (job) => {
				try {
					job.id = await submitGeneration(config, prompt, images);
					job.status = 'running';
				} catch (err) {
					job.status = 'failed';
					job.error = err instanceof Error ? err.message : String(err);
				}
			})
		);

		// 不变量：自 Promise.all 解析起到下面的 filter 之间不得有 await。
		// 否则 4s 轮询定时器可能插进来，观察到「全 failed 但仍在列表」的任务，
		// 既 notifyFinished 又移除它，与此处的弹窗 + 移除重复（双弹窗/双移除）。
		if (task.jobs.every((j) => j.status === 'failed')) {
			// 全部提交失败：无产出，直接从列表移除（无 running job，轮询不会接管它）并弹错误
			const errors = [...new Set(task.jobs.map((j) => j.error).filter((e): e is string => !!e))];
			this.tasks = this.tasks.filter((t) => t !== task);
			void this.cleanupEmptyFolder(task);
			void vscode.window.showErrorMessage(
				`Image Flow：${task.folder} 全部 ${task.jobs.length} 次提交失败：${errors.join('；')}`
			);
		}
		await this.persist();
		this.ensureTimer();
		this.emit();
	}

	/** 扩展启动时调用：若有持久化的未完成任务，立即拉一次并启动定时轮询 */
	resume(): void {
		if (this.tasks.length) {
			// 超时基于「本次会话起算」而非创建时间：关机时长不计入，否则离线超 10 分钟的可恢复任务会被误判超时丢弃
			const now = Date.now();
			for (const task of this.tasks) {
				// 旧版持久化记录无 startedAt：用其原 createdAt（重置前的真实提交时间）兜底回填
				task.startedAt ??= task.createdAt;
				task.createdAt = now;
				// 提交途中扩展被关闭：submitting job 没有 id 无从轮询，重启即判失败，避免永久卡住
				for (const job of task.jobs) {
					if (job.status === 'submitting') {
						job.status = 'failed';
						job.error = '提交未完成（扩展重启）';
					}
				}
			}
			void this.persist();
			this.ensureTimer();
			this.emit();
			void this.poll();
		}
	}

	/**
	 * 轮询一轮：对所有 running 的 job 查结果。成功则下载图片到任务文件夹；
	 * 失败/违规记错误。瞬时网络错误不改状态，下轮重试。任务全部 job 终结后从持久化移除。
	 * 重入锁串行化整轮：单轮内 job 串行下载共享 task.images.length 接续编号，禁止两轮并发避免同名覆盖。
	 */
	private async poll(): Promise<void> {
		if (this.polling) {
			return;
		}
		this.polling = true;
		try {
			await this.pollOnce();
		} finally {
			this.polling = false;
		}
	}

	private async pollOnce(): Promise<void> {
		const config = await readConfig(this.context);
		let changed = false;

		for (const task of this.tasks) {
			// 超时兜底：仍 running 的 job 标记失败，防止远端异常导致记录永不清除
			if (Date.now() - task.createdAt > TASK_TIMEOUT) {
				for (const job of task.jobs) {
					if (job.status === 'running') {
						job.status = 'failed';
						job.error = '生成超时';
						changed = true;
					}
				}
			}
			for (const job of task.jobs) {
				if (job.status !== 'running') {
					continue;
				}
				try {
					changed = (await this.pollJob(config, task, job)) || changed;
				} catch (err) {
					if (isTransientNetworkError(err)) {
						// 网络瞬时错误（超时/连接失败）：保持 running，下一轮再试
						continue;
					}
					// 其他错误（响应格式异常、写盘失败等）非瞬时，标记失败并记录原因，避免无限重试到超时
					job.status = 'failed';
					job.error = err instanceof Error ? err.message : String(err);
					changed = true;
				}
			}
		}

		// 移除已终结的任务（无 running、也无 submitting）；含失败/违规则移除前弹通知
		const before = this.tasks.length;
		const finished = this.tasks.filter((t) => !isTaskActive(t));
		for (const task of finished) {
			this.notifyFinished(task);
			// 全失败、无成图的任务留下空文件夹，移除前一并清理
			void this.cleanupEmptyFolder(task);
		}
		this.tasks = this.tasks.filter((t) => isTaskActive(t));
		if (this.tasks.length !== before) {
			changed = true;
		}

		if (changed) {
			await this.persist();
			this.ensureTimer();
			this.emit();
		}
	}

	/** 任务终结时：若有图成功则不打扰；若全失败/部分失败，弹通知呈现错误 */
	private notifyFinished(task: PendingTask): void {
		const failed = task.jobs.filter((j) => j.status === 'failed' || j.status === 'violation');
		if (!failed.length) {
			return;
		}
		const errors = [...new Set(failed.map((j) => j.error).filter((e): e is string => !!e))];
		const detail = errors.length ? `：${errors.join('；')}` : '';
		if (task.images.length) {
			void vscode.window.showWarningMessage(
				`Image Flow：${task.folder} 有 ${failed.length} 张生成失败${detail}`
			);
		} else {
			void vscode.window.showErrorMessage(`Image Flow：${task.folder} 生成失败${detail}`);
		}
	}

	/** 查询并处理单个 job：成功则下载落盘。返回是否有状态变更 */
	private async pollJob(config: ImageFlowConfig, task: PendingTask, job: PendingJob): Promise<boolean> {
		// 仅 running job 进入这里，id 必已回填；断言收窄可选类型
		const result = await queryResult(config, job.id!);
		if (result.status === 'running') {
			// 进度有变化才算「变更」，驱动侧栏刷新；无变化则不触发整轮 emit，避免空刷
			if (typeof result.progress === 'number' && result.progress !== job.progress) {
				job.progress = result.progress;
				return true;
			}
			return false;
		}
		if (result.status === 'failed' || result.status === 'violation') {
			job.status = result.status;
			job.error = result.error;
			return true;
		}
		// succeeded：下载到任务文件夹，接续已有图片编号避免重名
		const mdUri = vscode.Uri.parse(task.mdUri);
		const saved = await downloadImages(mdUri, task.folder, result.urls, task.images.length);
		task.images.push(...saved);
		job.status = 'succeeded';
		return true;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.listeners.clear();
	}
}
