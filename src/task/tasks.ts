import * as vscode from 'vscode';
import { TransientError } from '../backend/api';
import { resolveImageCall, requestTaskName } from '../backend/providerRuntime';
import { buildPrompt, dedupeArchiveNames } from '../prompt/buildPrompt';
import { createTaskFolder, saveResults, mdBaseName } from './history';
import { readConfig, editConfigView } from '../ui/config';
import { buildEditFinalPrompt, buildEditArchivePrompt } from '../prompt/edit';
import { buildInjectedPrompt } from '../prompt/inject';
import type { EditImage } from '../prompt/editSession';
import { archiveInputs, buildPromptFileContent, writePromptFile, writeTaskMeta } from './taskFiles';
import { log } from '../util/log';
import { errMsg } from '../util/errors';
import type { ImageFlowConfig, PendingTask, PendingJob, TaskMeta } from '../shared';
import type { ResultItem } from '../backend/adapters';

/** TaskManager.start 的参数：与任务来源（生成/编辑）无关的公共提交要素 */
interface StartOptions {
	kind: 'generate' | 'edit';
	/** 产出图片文件名前缀 */
	prefix: string;
	/** 来源 md（仅 generate） */
	mdUri?: string;
	/** 任务文件夹内提示词文件名（生成 = <md名>.md，编辑 = edit.md） */
	promptFileName: string;
	/** 提示词文件 frontmatter 的 source 值 */
	source: string;
	/** 本次生效的配置（编辑任务传入 editConfigView 结果） */
	config: ImageFlowConfig;
	/** 注入后的最终提示词（用于提交发送） */
	prompt: string;
	/** 归档正文：图片引用指向任务 input/，写入提示词文件，可直接右键重新生成 */
	archivePrompt: string;
	/** 参考图 data URI（按序） */
	images: string[];
	/** 参考图归档文件名（与 images 等长，保留原名、重名已去重，与 archivePrompt 引用对应） */
	names: string[];
}

/** globalState 中存放未完成任务的键 */
const PENDING_KEY = 'image-flow.pendingTasks';
/** 轮询间隔（ms）：前 10 分钟快轮询 */
const POLL_INTERVAL_FAST = 4000;
/** 轮询间隔（ms）：运行超过 10 分钟后降到 30s，减少远端压力与本地开销 */
const POLL_INTERVAL_SLOW = 30 * 1000;
/** 切到慢轮询的阈值（ms）：任务运行超过此时长即降速 */
const SLOW_AFTER = 10 * 60 * 1000;
/** 单个任务超时兜底（ms）：超过则把仍 running 的 job 标记失败，避免僵死记录永不清除 */
const TASK_TIMEOUT = 30 * 60 * 1000;

/**
 * 是否为可重试的网络瞬时错误。
 * - TransientError：adapter 轮询（grsai poll）显式标记的上游 5xx/429；
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
	/** 当前定时器的间隔（ms），用于判断是否需要在快/慢轮询间切换重建定时器 */
	private timerInterval?: number;
	private listeners = new Set<() => void>();
	/** 轮询重入锁：一轮 poll 的下载可能超过定时器间隔，禁止并发轮询，否则同任务多 job 共享 images.length 计数会下成同名图互相覆盖 */
	private polling = false;
	/** meta.json 写入串行链：pollJob（轮询锁内）写 succeeded 与 nameTask（锁外）写 title 共享此链，避免两处 writeFile 时序重叠写出半截 JSON */
	private metaWrites: Promise<void> = Promise.resolve();
	/** 点完成通知「查看」时的跳转回调，由 SidebarProvider 注入（聚焦侧栏 + 切任务栏定位） */
	private revealHandler?: (folder: string) => void;

	constructor(private readonly context: vscode.ExtensionContext) {
		// 旧版（任务建在 md 同级）持久化记录无 kind/dir 字段，目录定位已失效，直接丢弃不续拉
		this.tasks = context.globalState
			.get<PendingTask[]>(PENDING_KEY, [])
			.filter((t) => (t.kind === 'generate' || t.kind === 'edit') && typeof t.dir === 'string' && !!t.meta);
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

	/** 把 task.meta 串行写入 meta.json。写失败为非关键（readTaskMeta 有回退），吞掉不阻断主流程 */
	private writeMeta(task: PendingTask): Promise<void> {
		this.metaWrites = this.metaWrites
			.then(() => writeTaskMeta(vscode.Uri.parse(task.dir), task.meta))
			.catch(() => {});
		return this.metaWrites;
	}

	private emit(): void {
		// 监听器回调可能是 async（侧栏的 pushHistory 要扫盘）；包一层吞掉 reject，避免 unhandled rejection
		for (const fn of this.listeners) {
			void Promise.resolve()
				.then(() => fn())
				.catch(() => {});
		}
	}

	/**
	 * 有可轮询的 running job 时确保轮询定时器在跑；无则停掉（submitting 态尚无 id，不轮询）。
	 * 轮询间隔随任务运行时长动态调整：任一 running 任务运行未满 10 分钟则快轮询（4s），
	 * 全部超过 10 分钟则降到慢轮询（30s）。每轮 poll 后都会重新评估，以便在 10 分钟阈值处切换。
	 */
	private ensureTimer(): void {
		const running = this.tasks.filter((t) => t.jobs.some((j) => j.status === 'running'));
		if (!running.length) {
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
				this.timerInterval = undefined;
			}
			return;
		}
		const now = Date.now();
		const wantFast = running.some((t) => now - t.createdAt < SLOW_AFTER);
		const interval = wantFast ? POLL_INTERVAL_FAST : POLL_INTERVAL_SLOW;
		if (this.timer && this.timerInterval === interval) {
			return;
		}
		if (this.timer) {
			clearInterval(this.timer);
		}
		this.timerInterval = interval;
		this.timer = setInterval(() => void this.poll(), interval);
	}

	/**
	 * 提交一次 Markdown 生成：读文件 → 解析提示词 → 走公共提交流程。
	 */
	async submit(mdUri: vscode.Uri): Promise<void> {
		const config = await readConfig(this.context);
		const bytes = await vscode.workspace.fs.readFile(mdUri);
		const content = Buffer.from(bytes).toString('utf8').trim();
		if (!content) {
			throw new Error('Markdown 文件内容为空，无法生成。');
		}

		const { prompt: basePrompt, images, names, archivePrompt } = await buildPrompt(mdUri, content);
		const prompt = await buildInjectedPrompt(config, basePrompt);
		const prefix = mdBaseName(mdUri);
		const task = await this.start({
			kind: 'generate',
			prefix,
			mdUri: mdUri.toString(),
			promptFileName: `${prefix}.md`,
			source: vscode.workspace.asRelativePath(mdUri),
			config,
			prompt,
			archivePrompt,
			images,
			names,
		});
		// AI 命名：用 md 正文（含图片引用、不含注入句）概括，命名前先以 md 名占位、失败即回退该名。
		// 同一 md 多次生成内容可能不同，故生成任务也单独命名。
		if (config.autoName) {
			void this.nameTask(task, config, basePrompt);
		}
	}

	/**
	 * 提交一次编辑任务：用编辑专属配置，引用按编辑区顺序替换为 [imageN]。
	 * 注入仅拼模型注入句（按编辑模型取），不拼工作台预设模板——编辑场景与图册说明无关。
	 */
	async submitEdit(rawPrompt: string, refs: EditImage[]): Promise<void> {
		const base = await readConfig(this.context);
		const config = editConfigView(base);
		if (!rawPrompt.trim()) {
			throw new Error('提示词为空，无法生成。');
		}
		const names = refs.map((r) => r.name);
		const prompt = buildEditFinalPrompt(base, rawPrompt, names);
		// 归档落盘名保留原名、重名去重；发送提示词仍按编辑区原名编号 [imageN]
		const fileNames = dedupeArchiveNames(names);
		const archivePrompt = buildEditArchivePrompt(rawPrompt, names, fileNames);
		const task = await this.start({
			kind: 'edit',
			prefix: 'edit',
			promptFileName: 'edit.md',
			source: '（编辑任务）',
			config,
			prompt,
			archivePrompt,
			images: refs.map((r) => r.data),
			names: fileNames,
		});
		// AI 命名：后台非阻塞，用全局配置（namingModel/baseUrl/apiKey），失败静默回退占位名
		if (base.autoName) {
			void this.nameTask(task, base, rawPrompt);
		}
	}

	/**
	 * 后台给任务起短名（生成 / 编辑通用）：拿到非空短名就写进内存任务对象与 meta.json 并刷新侧栏。
	 * 任务可能已完成移出进行中列表，此时短名仍写盘，下次扫历史即生效。
	 */
	private async nameTask(task: PendingTask, config: ImageFlowConfig, rawPrompt: string): Promise<void> {
		const title = await requestTaskName(config, rawPrompt);
		if (!title) {
			return;
		}
		task.title = title;
		task.meta.title = title;
		await this.writeMeta(task);
		await this.persist();
		this.emit();
	}

	/**
	 * 公共提交流程：建任务文件夹 → 写提示词文件 + meta.json + 归档参考图 → 建卡入列 →
	 * 后台并发提交（不 await，调用方立即返回）。返回新建的任务对象，供调用方（如编辑命名）后续更新。
	 */
	private async start(opts: StartOptions): Promise<PendingTask> {
		const [folder, dir] = await createTaskFolder();
		await writePromptFile(dir, opts.promptFileName, buildPromptFileContent(opts.archivePrompt));
		await archiveInputs(dir, opts.names.map((name, i) => ({ name, data: opts.images[i] })));

		const count = Math.max(1, opts.config.concurrency);
		// 生成任务标题用来源 md 名；编辑任务留空，等 AI 命名回填
		const meta: TaskMeta = {
			source: opts.source,
			title: opts.kind === 'generate' ? opts.prefix : undefined,
			model: opts.config.model,
			aspectRatio: opts.config.aspectRatio,
			imageSize: opts.config.imageSize,
			requested: count,
			succeeded: 0,
			durations: [],
		};
		await writeTaskMeta(dir, meta);

		// sync adapter 的提交即整图生成（无独立 job id），据此让前端把「提交中」显示为「生成中」。
		// 解析失败（如缺密钥）留 false，submitJobs 会照常逐 job 失败处理，不影响这里。
		let sync = false;
		try {
			sync = resolveImageCall(opts.config).adapter.kind === 'sync';
		} catch {
			/* 留 false */
		}

		const task: PendingTask = {
			id: folder,
			kind: opts.kind,
			folder,
			dir: dir.toString(),
			prefix: opts.prefix,
			mdUri: opts.mdUri,
			providerId: opts.config.providerId,
			model: opts.config.model,
			sync,
			title: meta.title,
			meta,
			jobs: Array.from({ length: count }, () => ({ status: 'submitting' as const })),
			images: [],
			createdAt: Date.now(),
			startedAt: Date.now(),
		};
		this.tasks.unshift(task);
		await this.persist();
		this.emit();

		log(`提交任务 ${folder}（${opts.kind}，${count} 张，模型 ${opts.config.model}）`);
		void this.submitJobs(opts.config, task, opts.prompt, opts.images);
		return task;
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
		const { adapter, ctx } = resolveImageCall(config);
		if (adapter.kind === 'async') {
			// async（grsai）串行（错开）提交：submit 只上传 base64、秒回 job id，生成在服务端并行。
			// 并发提交时多份大图抢同一条上行带宽、各请求 120s 超时计时同瞬起跑，整体上传一旦超窗就被一起
			// abort——大图编辑任务因此全军覆没。逐个提交让每份上传独占带宽、超时窗口只覆盖自身。
			for (const job of submitting) {
				try {
					job.startedAt = Date.now();
					await this.applySubmitResult(task, job, await adapter.submit(ctx, prompt, images, 1));
				} catch (err) {
					this.failJob(task, job, err);
				}
			}
		} else {
			// sync（openai-images / gemini）并行提交：submit 阻塞到整张图生成完才返回（300s 窗口）。
			// 串行会让「并发数」退化为串行生成（墙钟 ≈ 张数 × 单图生成时长）。并行让各图同时生成；
			// 各请求自带独立的 300s 超时（gen 占大头、upload 占小头，并发上传争抢仍远在窗口内）。
			// 落盘共享 task.images.length 计数，故用串行链 chain 串起每张的落盘避免重名竞态；
			// 谁先生成完谁先落盘并 emit，使前几张不必等最慢/失败的那张就先显示在侧栏。
			// 两处易错点（破坏其一则 await Promise.all 返回时 chain 可能未排空）：handler 内
			// `chain = chain.then(...)` 与 `return chain` 必须同步相邻（其间不得插 await），且必须 return chain——
			// 这样每个 link 都被自己的成员 promise adopt，Promise.all 才会等到整条链跑完。
			let chain: Promise<void> = Promise.resolve();
			await Promise.all(
				submitting.map((job) => {
					job.startedAt = Date.now();
					return adapter.submit(ctx, prompt, images, 1).then(
						(res) => {
							chain = chain.then(async () => {
								await this.applySubmitResult(task, job, res);
								this.emit();
							});
							return chain;
						},
						(err) => {
							chain = chain.then(() => {
								this.failJob(task, job, err);
								this.emit();
							});
							return chain;
						}
					);
				})
			);
		}

		// 不变量：自上面的提交处理（含 sync 落盘串行链）结束到下面的 isTaskActive 判定之间不得有 await
		// （保持同步）。否则 4s 轮询可能观察到「已终结但仍在列表」的任务而重复 notifyFinished + 移除。
		if (!isTaskActive(task)) {
			// 提交后已无活跃 job：sync 任务全部就地出图/失败，或 async 全部提交失败。
			// 就地终结（轮询不会接管无 running job 的它），文件夹与 meta.json 保留进入历史留痕。
			this.notifyFinished(task);
			this.tasks = this.tasks.filter((t) => t !== task);
		}
		await this.persist();
		this.ensureTimer();
		this.emit();
	}

	/** 处理一次提交返回：async 拿到 job id 转 running；sync 提交即出图，就地落盘标记成功 */
	private async applySubmitResult(
		task: PendingTask,
		job: PendingJob,
		res: { jobId: string } | { results: ResultItem[] }
	): Promise<void> {
		if ('jobId' in res) {
			job.id = res.jobId;
			job.status = 'running';
		} else {
			await this.storeJobResults(task, job, res.results);
		}
	}

	/** 标记某 job 提交失败并记台账（sync 协议的提交即生成，超时/网络失败在此终结，留痕便于排障） */
	private failJob(task: PendingTask, job: PendingJob, err: unknown): void {
		job.status = 'failed';
		job.error = errMsg(err);
		log(`任务 ${task.folder} 提交失败：${job.error}`);
	}

	/** 把一个 job 的产出结果落盘并更新任务进度（async 轮询成功 / sync 提交即出图共用） */
	private async storeJobResults(task: PendingTask, job: PendingJob, results: ResultItem[]): Promise<void> {
		// 接续已有图片编号避免重名；任务串行处理（提交循环 / 轮询锁）保证 length 计数不竞态
		const saved = await saveResults(vscode.Uri.parse(task.dir), task.prefix, results, task.images.length);
		task.images.push(...saved);
		job.status = 'succeeded';
		// 成功数随落盘累加并回写 meta.json，供任务终结后历史展示成功率
		task.meta.succeeded = task.images.length;
		// 记本 job 单图生成耗时（startedAt 缺失的旧续拉任务回退到任务起算）；一张图一条，供历史展示平均
		const duration = Date.now() - (job.startedAt ?? task.startedAt);
		(task.meta.durations ??= []).push(...saved.map(() => duration));
		await this.writeMeta(task);
		log(`任务 ${task.folder} 落盘 ${saved.length} 张（job ${job.id ?? 'sync'}）`);
	}

	/** 扩展启动时调用：若有持久化的未完成任务，立即拉一次并启动定时轮询 */
	resume(): void {
		if (this.tasks.length) {
			// 超时基于「本次会话起算」而非创建时间：关机时长不计入，否则离线超 30 分钟的可恢复任务会被误判超时丢弃
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
					job.error = errMsg(err);
					log(`任务 ${task.folder} 轮询失败：${job.error}`);
					changed = true;
				}
			}
		}

		// 移除已终结的任务（无 running、也无 submitting）；含失败/违规则移除前弹通知
		const before = this.tasks.length;
		const finished = this.tasks.filter((t) => !isTaskActive(t));
		for (const task of finished) {
			this.notifyFinished(task);
		}
		// 终结任务（含无成图的失败任务）保留文件夹与 meta.json，移出进行中列表后进入历史留痕
		this.tasks = this.tasks.filter((t) => isTaskActive(t));
		if (this.tasks.length !== before) {
			changed = true;
		}

		if (changed) {
			await this.persist();
			this.emit();
		}
		// 无论本轮是否有状态变更，都重新评估定时器，以便运行满 10 分钟时从快轮询切到慢轮询
		this.ensureTimer();
	}

	/** 任务终结时弹通知：全成功报喜、部分/全失败呈现错误。通知带「查看」按钮，点击跳到任务栏看该任务 */
	private notifyFinished(task: PendingTask): void {
		const failed = task.jobs.filter((j) => j.status === 'failed' || j.status === 'violation');
		// 通知名：generate 的 title 建卡即为 md 名；edit 在 AI 命名返回前终结时 title 缺失，
		// 回退「编辑任务」而非裸时间戳文件夹名，文案更可读
		const name = task.title || (task.kind === 'edit' ? '编辑任务' : task.folder);
		const errors = [...new Set(failed.map((j) => j.error).filter((e): e is string => !!e))];
		const detail = errors.length ? `：${errors.join('；')}` : '';
		log(`任务 ${task.folder} 终结：成功 ${task.images.length}/${task.jobs.length}，失败 ${failed.length}${detail}`);
		if (!failed.length) {
			this.notify(task.folder, `✅ Image Flow：${name} 生成完成（${task.images.length} 张）`, 'info');
		} else if (task.images.length) {
			this.notify(task.folder, `Image Flow：${name} 有 ${failed.length} 张生成失败${detail}`, 'warn');
		} else {
			this.notify(task.folder, `Image Flow：${name} 生成失败${detail}`, 'error');
		}
	}

	/** 弹一条带「查看」按钮的通知；点击「查看」经 revealHandler 跳到任务栏定位该任务 */
	private notify(folder: string, message: string, kind: 'info' | 'warn' | 'error'): void {
		const shown =
			kind === 'info'
				? vscode.window.showInformationMessage(message, '查看')
				: kind === 'warn'
					? vscode.window.showWarningMessage(message, '查看')
					: vscode.window.showErrorMessage(message, '查看');
		void shown.then((picked) => {
			if (picked === '查看') {
				this.revealHandler?.(folder);
			}
		});
	}

	/** 由 SidebarProvider 注入：点通知「查看」时聚焦侧栏并切到任务栏定位该任务 */
	setRevealHandler(fn: (folder: string) => void): void {
		this.revealHandler = fn;
	}

	/** 查询并处理单个 job：成功则下载落盘。返回是否有状态变更 */
	private async pollJob(config: ImageFlowConfig, task: PendingTask, job: PendingJob): Promise<boolean> {
		// 按任务自身的 provider+model 解析协议，不受用户事后切换模型/Provider 影响。
		// baseUrl/apiKey 对内置 grsai 仍回落 config（secrets），对自定义按 model 取自 settings.json。
		const { adapter, ctx } = resolveImageCall({
			...config,
			providerId: task.providerId ?? config.providerId,
			model: task.model,
		});
		if (!adapter.poll) {
			throw new Error('当前协议不支持异步轮询');
		}
		// 仅 running job 进入这里，id 必已回填；断言收窄可选类型
		const result = await adapter.poll(ctx, job.id!);
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
		// succeeded：落盘到任务文件夹（用创建时记下的绝对 Uri，与当前窗口工作区无关）
		await this.storeJobResults(task, job, result.results);
		return true;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
			this.timerInterval = undefined;
		}
		this.listeners.clear();
	}
}
