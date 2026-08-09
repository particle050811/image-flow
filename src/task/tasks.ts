import * as vscode from 'vscode';
import { TransientError } from '../backend/api';
import { resolveImageCall, requestTaskName } from '../backend/providerRuntime';
import type { ImageCall } from '../backend/providerRuntime';
import { isJimengVideoModel, JIMENG_PROVIDER_ID } from '../backend/providers';
import { ensureJimengReady } from '../backend/jimengGuide';
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
import type { SubmitOverrides } from '../ui/cliOpsLogic';

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
	/** AI 命名用配置（编辑任务命名走全局配置而非编辑视图），缺省取 config */
	namingConfig?: ImageFlowConfig;
	/** 创建阶段（后台）执行：解析提示词与参考图。视频参考素材可达数十 MB（读文件 + base64），
	 *  放在点击路径上会让「生成」按钮长时间卡在忙碌态，故建卡后再在后台执行 */
	build: () => Promise<BuiltPrompt>;
}

/** build 回调的产物：提交与归档所需的全部提示词/素材 */
interface BuiltPrompt {
	/** 注入后的最终提示词（用于提交发送） */
	prompt: string;
	/** 归档正文：图片引用指向任务 input/，写入提示词文件，可直接右键重新生成 */
	archivePrompt: string;
	/** 参考图 data URI（按序） */
	images: string[];
	/** 参考图归档文件名（与 images 等长，保留原名、重名已去重，与 archivePrompt 引用对应） */
	names: string[];
	/** AI 命名的概括对象（生成 = md 正文含图片引用、不含注入句；编辑 = 原始提示词） */
	namingPrompt: string;
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
/** 即梦视频单任务条数上限：视频耗积分大，防止误用生图并发档位一次提交太多条 */
const JIMENG_VIDEO_MAX_COUNT = 4;
/** 即梦生图单任务张数上限：CLI generate_num 上限 10，提交前钳制让台账（requested）与远端一致 */
const JIMENG_IMAGE_MAX_COUNT = 10;

/** 本次配置是否为即梦视频（全能参考）调用 */
function isJimengVideoCall(config: ImageFlowConfig): boolean {
	return config.providerId === JIMENG_PROVIDER_ID && isJimengVideoModel(config.model);
}

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

/** TaskManager 的可注入依赖（测试 seam）：默认取真实实现，测试替换 Provider 解析与任务文件夹创建 */
export interface TaskManagerDeps {
	resolveImageCall: typeof resolveImageCall;
	createTaskFolder: typeof createTaskFolder;
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

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly deps: TaskManagerDeps = { resolveImageCall, createTaskFolder }
	) {
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
		// 创建中的任务不持久化：尚无已提交的远端 job，重启后无从续拉，resume 直接不出现
		await this.context.globalState.update(
			PENDING_KEY,
			this.tasks.filter((t) => !t.creating)
		);
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
	 * 提交一次 Markdown 生成：读文件校验非空 → 走公共提交流程（提示词解析在后台创建阶段执行）。
	 * overrides 为 CLI 按次覆盖参数（模型/比例/分辨率/张数/自定义参数）：浅覆盖 readConfig 结果，
	 * 不落盘、不影响工作台配置；UI 路径不传。
	 * 返回创建的任务（folder 即 submit_id）与创建阶段结果 creation（resolve 为 null=成功 /
	 * 错误文案=失败已撤卡删夹；恒不 reject）：CLI 等它拿同步失败原因，UI 路径可忽略（错误已弹通知）。
	 */
	async submit(
		mdUri: vscode.Uri,
		overrides?: SubmitOverrides
	): Promise<{ task: PendingTask; creation: Promise<string | null> }> {
		const config = { ...(await readConfig(this.context)), ...overrides };
		const bytes = await vscode.workspace.fs.readFile(mdUri);
		const content = Buffer.from(bytes).toString('utf8').trim();
		if (!content) {
			throw new Error('Markdown 文件内容为空，无法生成。');
		}
		const prefix = mdBaseName(mdUri);
		return this.start({
			kind: 'generate',
			prefix,
			mdUri: mdUri.toString(),
			promptFileName: `${prefix}.md`,
			source: vscode.workspace.asRelativePath(mdUri),
			config,
			build: async () => {
				// 即梦视频（全能参考）可直接吃音/视频参考素材，放开非图片限制；其余后端维持仅图片
				const { prompt: basePrompt, images, names, archivePrompt } = await buildPrompt(
					mdUri,
					content,
					isJimengVideoCall(config)
				);
				// AI 命名用 md 正文（含图片引用、不含注入句）概括；同一 md 多次生成内容可能不同，故单独命名
				return {
					prompt: await buildInjectedPrompt(config, basePrompt),
					archivePrompt,
					images,
					names,
					namingPrompt: basePrompt,
				};
			},
		});
	}

	/**
	 * 提交一次编辑任务：用编辑专属配置，引用按编辑区顺序替换为 [imageN]。
	 * 注入仅拼模型注入句（按编辑模型取），不拼工作台预设模板——编辑场景与图册说明无关。
	 * overrides 为 CLI 按次覆盖参数：浅覆盖编辑视图，不落盘、不影响编辑页配置；UI 路径不传。
	 * 返回值与 submit 同形（folder 即 submit_id、creation 为创建阶段结果），UI 路径可忽略。
	 */
	async submitEdit(
		rawPrompt: string,
		refs: EditImage[],
		overrides?: SubmitOverrides
	): Promise<{ task: PendingTask; creation: Promise<string | null> }> {
		const base = await readConfig(this.context);
		const config = { ...editConfigView(base), ...overrides };
		if (!rawPrompt.trim()) {
			throw new Error('提示词为空，无法生成。');
		}
		const names = refs.map((r) => r.name);
		const prompt = buildEditFinalPrompt(config, rawPrompt, names);
		// 归档落盘名保留原名、重名去重；发送提示词仍按编辑区原名编号 [imageN]
		const fileNames = dedupeArchiveNames(names);
		const archivePrompt = buildEditArchivePrompt(rawPrompt, names, fileNames);
		return this.start({
			kind: 'edit',
			prefix: 'edit',
			promptFileName: 'edit.md',
			source: '（编辑任务）',
			config,
			// AI 命名用全局配置（namingModel/baseUrl/apiKey）而非编辑视图，失败静默回退占位名
			namingConfig: base,
			build: async () => ({
				prompt,
				archivePrompt,
				images: refs.map((r) => r.data),
				names: fileNames,
				namingPrompt: rawPrompt,
			}),
		});
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
	 * 公共提交流程（快路径）：建任务文件夹 → 「创建中」卡片入列 → 立即返回让调用方解除 busy。
	 * 耗时的创建工作（即梦前置检查、提示词/参考图解析、归档落盘）转 createAndSubmit 后台执行，
	 * 完成后转入提交；失败则撤卡删夹。creation 即该后台创建的结果（见 submit 注释），恒不 reject。
	 */
	private async start(opts: StartOptions): Promise<{ task: PendingTask; creation: Promise<string | null> }> {
		const video = isJimengVideoCall(opts.config);
		// 即梦条数钳制：视频耗积分大收紧到 4；生图对齐 generate_num 上限 10（台账与远端实际张数一致）
		const cap = video
			? JIMENG_VIDEO_MAX_COUNT
			: opts.config.providerId === JIMENG_PROVIDER_ID
				? JIMENG_IMAGE_MAX_COUNT
				: Infinity;
		const count = Math.min(cap, Math.max(1, opts.config.concurrency));
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

		// sync adapter 的提交即整图生成（无独立 job id），据此让前端把「提交中」显示为「生成中」。
		// batch：async 且支持批量（即梦生图 generate_num）时单 job 一次提交 count 张；
		// 视频无批量参数，仍按 count 拆成多 job 串行提交。
		// 解析失败（如缺密钥）都留 false，submitJobs 会照常逐 job 失败处理，不影响这里。
		let sync = false;
		let batch = false;
		try {
			const adapter = this.deps.resolveImageCall(opts.config).adapter;
			sync = adapter.kind === 'sync';
			batch = adapter.kind === 'async' && adapter.supportsBatch && !video;
		} catch {
			/* 留 false */
		}
		const jobCount = batch ? 1 : count;

		const [folder, dir] = await this.deps.createTaskFolder();
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
			creating: true,
			jobs: Array.from({ length: jobCount }, () => ({ status: 'submitting' as const })),
			images: [],
			createdAt: Date.now(),
			startedAt: Date.now(),
		};
		// 建卡即入列并刷新侧栏（创建中的任务不持久化，persist 由创建完成后统一做）
		this.tasks.unshift(task);
		this.emit();

		log(`创建任务 ${folder}（${opts.kind}，${count} 张，模型 ${opts.config.model}）`);
		const creation = this.createAndSubmit(opts, task, dir, batch ? count : 1);
		return { task, creation };
	}

	/**
	 * 后台创建阶段：即梦前置检查（CLI 安装 / 登录态，未就绪弹引导）→ 解析提示词与参考图（build）→
	 * 写提示词文件 + meta.json + 归档参考图 → 转入提交。任一步失败即撤卡、删除尚无远端订单的
	 * 任务夹（不留痕不扣积分）并弹错——此时「生成」按钮早已释放，错误只能经通知呈现。
	 * 返回 null=创建成功已转提交；错误文案=创建失败（恒不 reject，CLI 桥据此同步回 fail_reason）。
	 */
	private async createAndSubmit(
		opts: StartOptions,
		task: PendingTask,
		dir: vscode.Uri,
		perJobCount: number
	): Promise<string | null> {
		let built: BuiltPrompt;
		try {
			await ensureJimengReady(opts.config);
			built = await opts.build();
			await writePromptFile(dir, opts.promptFileName, buildPromptFileContent(built.archivePrompt));
			await archiveInputs(dir, built.names.map((name, i) => ({ name, data: built.images[i] })));
			await writeTaskMeta(dir, task.meta);
		} catch (err) {
			this.tasks = this.tasks.filter((t) => t !== task);
			void vscode.workspace.fs
				.delete(dir, { recursive: true, useTrash: false })
				.then(undefined, () => undefined);
			this.emit();
			log(`任务 ${task.folder} 创建失败：${errMsg(err)}`);
			void vscode.window.showErrorMessage(`Image Flow：任务创建失败：${errMsg(err)}`);
			return errMsg(err);
		}
		// 与 images/names 一一对应的 input/ 归档素材绝对路径，供 CLI 型 adapter（吃文件路径）使用
		const refPaths = built.names.map((name) => vscode.Uri.joinPath(dir, 'input', name).fsPath);
		task.creating = false;
		try {
			await this.persist();
		} catch (err) {
			// 持久化失败不打断状态机（本函数经 void 调用，reject 会被吞掉导致任务不提交）
			log(`任务 ${task.folder} 持久化失败（忽略）：${errMsg(err)}`);
		}
		this.emit();

		log(`提交任务 ${task.folder}（${opts.kind}，${task.meta.requested} 张，模型 ${opts.config.model}）`);
		void this.submitJobs(opts.config, task, built.prompt, built.images, refPaths, perJobCount);
		// AI 命名：后台非阻塞，失败静默回退占位名（生成 = md 名；编辑 = 「编辑任务」文案）
		const namingCfg = opts.namingConfig ?? opts.config;
		if (namingCfg.autoName) {
			void this.nameTask(task, namingCfg, built.namingPrompt);
		}
		return null;
	}

	/**
	 * 后台并发发出 N 个 generate 请求，逐个回填 job id（submitting → running）。
	 * 全部失败则整任务作废并提示；否则启动轮询拉结果。
	 */
	private async submitJobs(
		config: ImageFlowConfig,
		task: PendingTask,
		prompt: string,
		images: string[],
		refPaths: string[],
		perJobCount: number
	): Promise<void> {
		const submitting = task.jobs.filter((j) => j.status === 'submitting');
		// Provider 解析包 try/catch（F079）：解析失败（缺密钥/渠道不可用等）即批量判失败、
		// 走下方公共终结路径。此前抛错会让 submitJobs 整个 reject（调用方 void 不接收），
		// 任务永远卡在 submitting 不终结、不报错。
		let call: ImageCall | undefined;
		try {
			call = this.deps.resolveImageCall(config);
		} catch (err) {
			for (const job of submitting) {
				this.failJob(task, job, err);
			}
		}
		if (call && call.adapter.kind === 'async') {
			const adapter = call.adapter;
			// 提交上下文附带 input/ 归档素材路径（CLI 型 adapter 用；HTTP 型忽略）
			const ctx = { ...call.ctx, refPaths };
			// async（grsai）串行（错开）提交：submit 只上传 base64、秒回 job id，生成在服务端并行。
			// 并发提交时多份大图抢同一条上行带宽、各请求 120s 超时计时同瞬起跑，整体上传一旦超窗就被一起
			// abort——大图编辑任务因此全军覆没。逐个提交让每份上传独占带宽、超时窗口只覆盖自身。
			for (const job of submitting) {
				try {
					job.startedAt = Date.now();
					await this.applySubmitResult(task, job, await adapter.submit(ctx, prompt, images, perJobCount));
				} catch (err) {
					this.failJob(task, job, err);
				}
				// 每处理完一个 job 立即持久化并评估轮询（F096）：远端一接单本地就记账，
				// 后续 job 还在上传时重载/崩溃也不丢已提交（可能已扣费）的 job id；
				// 首个 id 到手即开始轮询，不必等整批提交完。
				// 仅任务仍活跃时才做中途持久化：最后一个 job 若把任务收尾成终态，交给下方
				// 公共终结路径同步判定——否则这里的 await 会给已在跑的轮询留下「观察到
				// 已终结任务并抢先通知/移除」的窗口，造成双重终结。
				if (isTaskActive(task)) {
					try {
						await this.persist();
					} catch (err) {
						// 持久化失败不打断状态机：job id 仍在内存、轮询照常，下次写入补全
						log(`任务 ${task.folder} 中途持久化失败（忽略）：${errMsg(err)}`);
					}
					this.ensureTimer();
					this.emit();
				}
			}
		} else if (call) {
			const { adapter, ctx } = call;
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
		// 兜底再查列表成员资格：最后一个 job 转 running 后轮询可能在本函数收尾前就完成并终结了
		// 该任务（通知 + 移除都在轮询的同步块内），此时这里跳过，不重复通知。
		if (!isTaskActive(task) && this.tasks.includes(task)) {
			// 提交后已无活跃 job：sync 任务全部就地出图/失败，或 async 全部提交失败。
			// 就地终结（轮询不会接管无 running job 的它），文件夹与 meta.json 保留进入历史留痕。
			this.notifyFinished(task);
			this.tasks = this.tasks.filter((t) => t !== task);
		}
		try {
			await this.persist();
		} catch (err) {
			// 持久化失败不打断状态机（本函数经 void 调用，reject 会被吞掉导致定时器不启动）
			log(`任务 ${task.folder} 持久化失败（忽略）：${errMsg(err)}`);
		}
		this.ensureTimer();
		// 与 pollOnce 同口径：emit 前等积分 meta 落盘完成，避免历史扫描读到无 credit 的 meta 且不再刷新
		// （混合内联终结：前 job 已轮询终结带积分、后 job 提交失败，积分写入在此排队）
		await this.metaWrites;
		this.emit();
	}

	/** 处理一次提交返回：async 拿到 job id 转 running；sync 提交即出图，就地落盘标记成功 */
	private async applySubmitResult(
		task: PendingTask,
		job: PendingJob,
		res: { jobId: string; creditCount?: number } | { results: ResultItem[] }
	): Promise<void> {
		if ('jobId' in res) {
			job.id = res.jobId;
			job.status = 'running';
			// 提交响应即带积分（即梦费用提交瞬间锁定）：记账并实时刷新，卡片立现本次消耗。
			// poll 终结后以实际值为准覆盖（费用口径一致，覆盖无害）
			if (res.creditCount !== undefined) {
				job.creditCount = res.creditCount;
			}
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
			// 等 notifyFinished 里的积分 meta 落盘完成再刷新侧栏：emit 会触发历史扫盘读 meta.json，
			// 不等待会让刚终结的卡片短暂缺积分（writeMeta 走串行链，返回即整链排空）
			await this.metaWrites;
			this.emit();
		}
		// 无论本轮是否有状态变更，都重新评估定时器，以便运行满 10 分钟时从快轮询切到慢轮询
		this.ensureTimer();
	}

	/** 任务终结时弹通知：全成功报喜、部分/全失败呈现错误。通知带「查看」按钮，点击跳到任务栏看该任务 */
	private notifyFinished(task: PendingTask): void {
		const failed = task.jobs.filter((j) => j.status === 'failed' || j.status === 'violation');
		// 积分（即梦渠道）：把终结 job 携带的 creditCount 累进台账。任务终结后即移出进行中列表，
		// 只能在这里（移除前）落盘——失败任务同样记（远端已扣费），全为 0/缺省则不加字段留空
		const credit = task.jobs.reduce((sum, j) => sum + (j.creditCount ?? 0), 0);
		if (credit > 0) {
			task.meta.credit = credit;
			void this.writeMeta(task);
		}
		// 通知名：generate 的 title 建卡即为 md 名；edit 在 AI 命名返回前终结时 title 缺失，
		// 回退「编辑任务」而非裸时间戳文件夹名，文案更可读
		const name = task.title || (task.kind === 'edit' ? '编辑任务' : task.folder);
		const errors = [...new Set(failed.map((j) => j.error).filter((e): e is string => !!e))];
		const detail = errors.length ? `：${errors.join('；')}` : '';
		// 分母按张数（meta.requested）：批量 adapter 单 job 出多张，按 job 数会记成「成功 10/1」
		const requested = Math.max(task.jobs.length, task.meta.requested);
		log(`任务 ${task.folder} 终结：成功 ${task.images.length}/${requested}，失败 ${failed.length}${detail}`);
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
		// requireModel：原模型被删除/改名时明确报错终结 job（F099），绝不回落首个模型——
		// 那会把旧 job id 发往另一模型的地址，任务永远查不回来还说不清用了哪个模型
		const { adapter, ctx } = this.deps.resolveImageCall(
			{
				...config,
				providerId: task.providerId ?? config.providerId,
				model: task.model,
			},
			{ requireModel: true }
		);
		if (!adapter.poll) {
			throw new Error('当前协议不支持异步轮询');
		}
		// 仅 running job 进入这里，id 必已回填；断言收窄可选类型。
		// taskDir：CLI 型 adapter 把成品下载到任务夹 download/ 子目录（同盘 rename、残片随任务夹回收）
		const result = await adapter.poll({ ...ctx, taskDir: vscode.Uri.parse(task.dir).fsPath }, job.id!);
		if (result.status === 'running') {
			// 下载重试等 running 态：轮询结果可能已带实际积分（jimengCli 下载失败时透传终态 credit_count），
			// 覆盖提交期的估计值——即使后续下载一直失败到任务超时，已扣费也按实际值入账
			if (result.creditCount !== undefined) {
				job.creditCount = result.creditCount;
			}
			// 进度有变化才算「变更」，驱动侧栏刷新；无变化则不触发整轮 emit，避免空刷
			if (typeof result.progress === 'number' && result.progress !== job.progress) {
				job.progress = result.progress;
				return true;
			}
			// 仅积分透传（无进度变化）也标记为变更：让侧栏实时刷新已扣积分
			return result.creditCount !== undefined;
		}
		if (result.status === 'failed' || result.status === 'violation') {
			job.status = result.status;
			job.error = result.error;
			// 失败任务同样记积分：即梦远端已扣费，credit_count 如实入账（失败扣费不是 bug，是该展示的成本）。
			// poll 未带回实际值（如登录失效等本地终结失败）时保留提交时已锁定的积分，绝不抹掉已知扣费。
			// 注意：creditCount 赋值与 persist() 之间隔 storeJobResults 的 await 窗口（仅 succeeded 分支），
			// 该窗口崩溃会丢此 job 积分——与 succeeded 状态同窗口，属基线崩溃语义，概率极低，勿据此优化 persist 时机
			job.creditCount = result.creditCount ?? job.creditCount;
			return true;
		}
		// succeeded：先记实际积分再落盘——落盘可能抛错（磁盘满/权限）走任务终结路径，
		// 若先落盘再赋值，抛错会让已取得的实际积分丢失（Codex 复核确认），任务超时后保留提交期估计值
		job.creditCount = result.creditCount ?? job.creditCount;
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
