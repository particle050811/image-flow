// TaskManager 状态机回归测试：通过依赖 seam（resolveImageCall / createTaskFolder）注入假 adapter
// 与临时任务目录，覆盖 F079（解析失败不卡死）、F096（逐 job 持久化）与 sync 成功路径。
// providerRuntime 的 F098/F099（渠道白名单 / 续拉严格匹配）在下方独立 suite 直测纯解析逻辑。
// 文件落盘走真实 fs（os.tmpdir 下），不走网络。
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TaskManager } from '../task/tasks';
import type { TaskManagerDeps } from '../task/tasks';
import { readTaskMeta } from '../task/taskFiles';
import { resolveImageCall, resolveChatCall, requestTaskName } from '../backend/providerRuntime';
import type { RuntimeProvider } from '../backend/providers';
import type { ImageAdapter, SubmitAsync } from '../backend/adapters/types';
import type { PendingTask, PendingJob, TaskMeta } from '../shared';
import { baseConfig } from './fixtures';

const PENDING_KEY = 'image-flow.pendingTasks';
const CONFIG_KEY = 'image-flow.config';
const TEST_ROOT = path.join(os.tmpdir(), 'imageflow-taskmanager-tests');
const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

function fakeMemento(seed: Record<string, unknown> = {}): vscode.Memento {
	const store = new Map<string, unknown>(Object.entries(seed));
	return {
		keys: () => [...store.keys()],
		get: (key: string, defaultValue?: unknown) =>
			store.has(key) ? structuredClone(store.get(key)) : defaultValue,
		update: async (key: string, value: unknown) => {
			if (value === undefined) {
				store.delete(key);
			} else {
				store.set(key, structuredClone(value));
			}
		},
	} as unknown as vscode.Memento;
}

/** 只带 TaskManager / readConfig 用到的两个成员：globalState 与 secrets */
function fakeContext(config: Record<string, unknown>): vscode.ExtensionContext {
	return {
		globalState: fakeMemento({ [CONFIG_KEY]: config }),
		secrets: { get: async () => '' },
	} as unknown as vscode.ExtensionContext;
}

let folderSeq = 0;
function fakeCreateTaskFolder(created: vscode.Uri[]): TaskManagerDeps['createTaskFolder'] {
	return async () => {
		const folder = `tm-${Date.now()}-${folderSeq++}`;
		const dir = vscode.Uri.file(path.join(TEST_ROOT, folder));
		await vscode.workspace.fs.createDirectory(dir);
		created.push(dir);
		return [folder, dir];
	};
}

function fakeDeps(adapter: ImageAdapter, created: vscode.Uri[]): TaskManagerDeps {
	return {
		resolveImageCall: (config) => ({ adapter, ctx: { baseUrl: 'http://fake', apiKey: 'k', config } }),
		createTaskFolder: fakeCreateTaskFolder(created),
	};
}

/** submitJobs / poll 在后台异步推进，用轮询等待其到达断言点（谓词可为 async，内部自动 await） */
async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const start = Date.now();
	while (!(await cond())) {
		if (Date.now() - start > ms) {
			throw new Error('等待任务状态超时');
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function pendingOf(context: vscode.ExtensionContext): PendingTask[] {
	return context.globalState.get<PendingTask[]>(PENDING_KEY, []);
}

suite('TaskManager 状态机', () => {
	suiteTeardown(async () => {
		await vscode.workspace.fs.delete(vscode.Uri.file(TEST_ROOT), { recursive: true, useTrash: false }).then(
			() => undefined,
			() => undefined
		);
	});

	test('Provider 解析失败：全部 job 失败、任务移出 pending、meta 留痕（F079 回归）', async () => {
		const context = fakeContext({ autoName: false, editConcurrency: 2 });
		const dirs: vscode.Uri[] = [];
		const manager = new TaskManager(context, {
			resolveImageCall: () => {
				throw new Error('缺少 apiKey');
			},
			createTaskFolder: fakeCreateTaskFolder(dirs),
		});
		try {
			await manager.submitEdit('画一只猫', []);
			await until(() => manager.list().length === 0);
			assert.strictEqual(pendingOf(context).length, 0);
			const meta = await readTaskMeta(dirs[0]);
			assert.ok(meta);
			assert.strictEqual(meta.requested, 2);
			assert.strictEqual(meta.succeeded, 0);
		} finally {
			manager.dispose();
		}
	});

	test('sync 提交成功：就地落盘出图、meta.succeeded 累加、任务终结', async () => {
		const context = fakeContext({ autoName: false, editConcurrency: 2 });
		const dirs: vscode.Uri[] = [];
		const adapter: ImageAdapter = {
			id: 'fake-sync',
			kind: 'sync',
			supportsBatch: false,
			submit: async () => ({ results: [{ kind: 'base64', data: PNG_B64, mime: 'image/png' }] }),
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			await until(() => manager.list().length === 0);
			assert.strictEqual(pendingOf(context).length, 0);
			const meta = await readTaskMeta(dirs[0]);
			assert.strictEqual(meta?.succeeded, 2);
		} finally {
			manager.dispose();
		}
	});

	test('F096 回归：async 逐 job 持久化——首个 job id 到手即入库，后续 job 仍在提交也不丢', async () => {
		const context = fakeContext({ autoName: false, editConcurrency: 2 });
		const dirs: vscode.Uri[] = [];
		let releaseSecond: ((v: SubmitAsync) => void) | undefined;
		let calls = 0;
		const adapter: ImageAdapter = {
			id: 'fake-async',
			kind: 'async',
			supportsBatch: false,
			submit: () =>
				++calls === 1
					? Promise.resolve({ jobId: 'job-1' })
					: new Promise<SubmitAsync>((resolve) => {
							releaseSecond = resolve;
						}),
			// 断言期间定时器可能触发轮询：保持 running 不推进状态
			poll: async () => ({ status: 'running', results: [], progress: 0 }),
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			// job-2 已挂在 submit 上（releaseSecond 就位）时，job-1 的 id 必须已持久化（重载/崩溃不丢已扣费任务）
			await until(() => {
				const stored = pendingOf(context);
				return (
					!!releaseSecond &&
					stored.length === 1 &&
					stored[0].jobs[0]?.status === 'running' &&
					stored[0].jobs[0]?.id === 'job-1' &&
					stored[0].jobs[1]?.status === 'submitting'
				);
			});
			releaseSecond!({ jobId: 'job-2' });
			await until(() => pendingOf(context)[0]?.jobs.every((j) => j.status === 'running'));
		} finally {
			manager.dispose();
		}
	});

	test('即梦积分入账：提交响应即带 credit_count 实时记账，poll 终结实际值覆盖，累加进 meta.credit 落盘', async function () {
		// 轮询间隔 4s：任务需等首个轮询周期终结，放宽 mocha 默认 2s 超时
		this.timeout(15_000);
		const context = fakeContext({ autoName: false, editConcurrency: 2 });
		const dirs: vscode.Uri[] = [];
		// 两个 job：提交响应各带预估积分（费用提交即锁定）；第一个 poll 成功覆盖为 144、第二个 poll 失败也带 20
		let submitCalls = 0;
		let pollCount = 0;
		const adapter: ImageAdapter = {
			id: 'fake-jimeng',
			kind: 'async',
			supportsBatch: false,
			submit: async () => {
				submitCalls++;
				return { jobId: `job-${submitCalls}`, creditCount: submitCalls === 1 ? 100 : 50 };
			},
			poll: async () => {
				pollCount++;
				return pollCount === 1
					? { status: 'succeeded', results: [{ kind: 'base64', data: PNG_B64, mime: 'image/png' }], creditCount: 144 }
					: { status: 'failed', results: [], error: '生成失败', creditCount: 20 };
			},
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			// 提交全部完成后（任务 running、尚未轮询终结）即可从内存任务看到实时积分（100+50）
			await until(() => {
				const t = manager.list()[0];
				return !!t && t.jobs.every((j) => j.status === 'running') && t.jobs.every((j) => j.creditCount !== undefined);
			});
			const live = manager.list()[0].jobs.reduce((s, j) => s + (j.creditCount ?? 0), 0);
			assert.strictEqual(live, 100 + 50);
			// 轮询终结后：实际值（144+20）覆盖提交值，落盘进 meta.credit
			await until(() => manager.list().length === 0);
			assert.strictEqual(pendingOf(context).length, 0);
			const meta = await readTaskMeta(dirs[0]);
			assert.strictEqual(meta?.credit, 144 + 20);
			assert.strictEqual(meta?.succeeded, 1);
		} finally {
			manager.dispose();
		}
	});

	test('下载重试的 running 态透传实际积分：覆盖提交期估计值（Codex 复核回归）', async function () {
		this.timeout(15_000);
		const context = fakeContext({ autoName: false, editConcurrency: 1 });
		const dirs: vscode.Uri[] = [];
		// 提交带估计积分 200；poll 首轮 running 携带实际积分 288（模拟下载失败透传终态 credit_count），
		// 后续轮次 running 不带积分（模拟查询已终态但无新数据）。即使任务超时，已扣费也该记 288 而非 200
		let pollCount = 0;
		const adapter: ImageAdapter = {
			id: 'fake-jimeng-running-credit',
			kind: 'async',
			supportsBatch: false,
			submit: async () => ({ jobId: 'job-1', creditCount: 200 }),
			poll: async () => {
				pollCount++;
				return pollCount === 1
					? { status: 'running', results: [], creditCount: 288 }
					: { status: 'running', results: [] };
			},
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			// 首轮轮询（4s 后）把 job.creditCount 从 200 覆盖为 288
			await until(() => manager.list()[0]?.jobs[0]?.creditCount === 288, 10_000);
			// 后续轮询不带积分也不回退（保持 288）
			await new Promise((resolve) => setTimeout(resolve, 4500));
			assert.strictEqual(manager.list()[0]?.jobs[0]?.creditCount, 288);
		} finally {
			manager.dispose();
		}
	});

	test('poll 认证失败不带积分：保留提交时已锁定的积分，不抹掉已知扣费（Codex 缺陷2回归）', async function () {
		this.timeout(15_000);
		const context = fakeContext({ autoName: false, editConcurrency: 1 });
		const dirs: vscode.Uri[] = [];
		// 提交带积分 4（费用已锁定）；poll 未登录 → 终结失败但不带 creditCount，提交值必须保留
		const adapter: ImageAdapter = {
			id: 'fake-jimeng-auth',
			kind: 'async',
			supportsBatch: false,
			submit: async () => ({ jobId: 'job-1', creditCount: 4 }),
			poll: async () => ({ status: 'failed', results: [], error: '即梦 CLI 未登录' }),
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			await until(() => manager.list().length === 0);
			const meta = await readTaskMeta(dirs[0]);
			// 提交锁定的 4 积分保留（不会被 poll 的 undefined 覆盖）
			assert.strictEqual(meta?.credit, 4);
			assert.strictEqual(meta?.succeeded, 0);
		} finally {
			manager.dispose();
		}
	});
});

suite('TaskManager 积分续拉与缺省', () => {
	suiteTeardown(async () => {
		await vscode.workspace.fs.delete(vscode.Uri.file(TEST_ROOT), { recursive: true, useTrash: false }).then(
			() => undefined,
			() => undefined
		);
	});

	function makePersistedTask(
		override: Partial<PendingTask>,
		jobs: PendingJob[],
		meta: TaskMeta
	): PendingTask {
		const folder = `pm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const dir = vscode.Uri.file(path.join(TEST_ROOT, folder));
		// 持久化记录只有 dir 字符串；测试直接构造真实目录供 meta 落盘
		void vscode.workspace.fs.createDirectory(dir);
		return {
			id: folder,
			kind: 'generate',
			folder,
			dir: dir.toString(),
			prefix: 'gen',
			providerId: 'jimeng',
			model: 'seedance2.0',
			sync: false,
			meta,
			jobs,
			images: [],
			createdAt: Date.now(),
			startedAt: Date.now(),
			...override,
		};
	}

	/** 构造一个含持久化记录的任务目录，目录建好才返回（resume 的 poll 会往里写文件） */
	async function makeTaskDir(): Promise<{ folder: string; dir: vscode.Uri }> {
		const folder = `pm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const dir = vscode.Uri.file(path.join(TEST_ROOT, folder));
		await vscode.workspace.fs.createDirectory(dir);
		return { folder, dir };
	}

	test('resume 续拉：已终结 job 的 creditCount 持久化恢复后正确累加进 meta.credit 且不重复', async function () {
		this.timeout(15_000);
		const { dir } = await makeTaskDir();
		// 构造持久化记录：job-1 已终结（creditCount 144）、job-2 仍 running（creditCount 200）
		const seed: PendingTask = makePersistedTask(
			{ dir: dir.toString() },
			[
				{ id: 'job-1', status: 'succeeded', startedAt: Date.now(), creditCount: 144 },
				{ id: 'job-2', status: 'running', startedAt: Date.now(), creditCount: 200 },
			],
			{ source: 'x.md', title: 'resume', model: 'seedance2.0', aspectRatio: '16:9', imageSize: '720p', requested: 2, succeeded: 1 }
		);
		// PENDING_KEY 须在 globalState 顶层（TaskManager 构造器从顶层读）；config 仍塞 'image-flow.config'
		const context = {
			globalState: fakeMemento({ [CONFIG_KEY]: { autoName: false }, [PENDING_KEY]: [seed] }),
			secrets: { get: async () => '' },
		} as unknown as vscode.ExtensionContext;
		// resume 后 poll 拉取 job-2 成功，creditCount 覆盖为 288
		const adapter: ImageAdapter = {
			id: 'fake-jimeng',
			kind: 'async',
			supportsBatch: false,
			submit: async () => ({ jobId: 'new' }),
			poll: async () => ({ status: 'succeeded', results: [{ kind: 'base64', data: PNG_B64, mime: 'image/png' }], creditCount: 288 }),
		};
		const manager = new TaskManager(context, fakeDeps(adapter, []));
		try {
			manager.resume();
			// 等任务终结且 meta.credit 落盘完成（列表移除早于 writeMeta 落盘，须以文件内容为准）
			await until(async () => {
				if (manager.list().length !== 0) {
					return false;
				}
				const m = await readTaskMeta(dir);
				return m?.credit !== undefined;
			}, 8000);
			const meta = await readTaskMeta(dir);
			// job-1 的 144 + job-2 终结后的 288（覆盖原 200，不重复累加）
			assert.strictEqual(meta?.credit, 144 + 288);
			// succeeded 以落盘计数为准：续拉的已终结 job 不重复落盘，本轮只落 job-2 的 1 张
			assert.strictEqual(meta?.succeeded, 1);
		} finally {
			manager.dispose();
		}
	});

	test('非即梦（sync）成功任务不写 meta.credit', async function () {
		this.timeout(15_000);
		const context = fakeContext({ autoName: false, editConcurrency: 1 });
		const dirs: vscode.Uri[] = [];
		const adapter: ImageAdapter = {
			id: 'fake-sync',
			kind: 'sync',
			supportsBatch: false,
			submit: async () => ({ results: [{ kind: 'base64', data: PNG_B64, mime: 'image/png' }] }),
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			await until(() => manager.list().length === 0);
			const meta = await readTaskMeta(dirs[0]);
			assert.strictEqual(meta?.succeeded, 1);
			assert.strictEqual(meta?.credit, undefined);
		} finally {
			manager.dispose();
		}
	});

	test('async 全部提交失败（内联终结）：不记账、meta.credit 缺省', async function () {
		this.timeout(15_000);
		const context = fakeContext({ autoName: false, editConcurrency: 2 });
		const dirs: vscode.Uri[] = [];
		// 提交即失败（未拿到 job id → 未锁定费用 → 不扣费），两个 job 都走 failJob
		const adapter: ImageAdapter = {
			id: 'fake-async-fail',
			kind: 'async',
			supportsBatch: false,
			submit: async () => {
				throw new Error('提交失败');
			},
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			await until(() => manager.list().length === 0);
			assert.strictEqual(pendingOf(context).length, 0);
			const meta = await readTaskMeta(dirs[0]);
			assert.strictEqual(meta?.succeeded, 0);
			assert.strictEqual(meta?.credit, undefined);
		} finally {
			manager.dispose();
		}
	});

	test('混合内联终结：前 job 已带积分终结、后 job 提交失败，积分不丢且终结前已落盘（Codex 缺陷1回归）', async function () {
		this.timeout(15_000);
		const context = fakeContext({ autoName: false, editConcurrency: 2 });
		const dirs: vscode.Uri[] = [];
		// 前 job 提交即成功（带积分 144）、后 job 提交失败（未锁定费用）——但前 job 的积分必须保留
		let submitCalls = 0;
		const adapter: ImageAdapter = {
			id: 'fake-jimeng-mixed',
			kind: 'async',
			supportsBatch: false,
			submit: async () => {
				submitCalls++;
				if (submitCalls === 1) {
					return { jobId: 'job-1', creditCount: 144 };
				}
				throw new Error('提交失败');
			},
			poll: async () => ({ status: 'succeeded', results: [{ kind: 'base64', data: PNG_B64, mime: 'image/png' }], creditCount: 144 }),
		};
		const manager = new TaskManager(context, fakeDeps(adapter, dirs));
		try {
			await manager.submitEdit('画一只猫', []);
			await until(() => manager.list().length === 0);
			assert.strictEqual(pendingOf(context).length, 0);
			const meta = await readTaskMeta(dirs[0]);
			// 前 job 的 144 保留（submitJobs 内联终结路径 emit 前 await metaWrites，落盘已排空）
			assert.strictEqual(meta?.credit, 144);
			assert.strictEqual(meta?.succeeded, 1);
		} finally {
			manager.dispose();
		}
	});
});

suite('providerRuntime 渠道与模型边界', () => {
	test('F099 回归：requireModel 时找不到原模型直接报错，绝不回落首个模型', () => {
		const config = { ...baseConfig, providerId: 'grsai', model: '已被删除的模型' };
		// 交互路径（不带 requireModel）保持原回落行为
		assert.ok(resolveImageCall(config).adapter);
		// 续拉路径严格匹配：报错终结而不是把旧 job id 发往另一模型
		assert.throws(() => resolveImageCall(config, { requireModel: true }), /找不到模型/);
	});

	test('F098 回归：未知渠道 id 直接报错，不静默当作 grsai', () => {
		assert.throws(() => resolveImageCall({ ...baseConfig, providerId: 'bogus' }), /未知渠道/);
	});

	test('未知 namingProviderId：requestTaskName 静默跳过（不成 unhandled rejection）', async () => {
		const title = await requestTaskName({ ...baseConfig, namingProviderId: 'bogus' }, '画一只猫');
		assert.strictEqual(title, undefined);
	});

	test('未配置自定义 chat 时命名回落 namingProviderId 渠道，grsai 用 config 的地址与密钥', () => {
		// 测试进程从不调 reloadCustomProvider，自定义缓存必为空 → 走内置回落分支
		const call = resolveChatCall(baseConfig);
		assert.strictEqual(call?.model, 'gemini-3.5-flash');
		assert.strictEqual(call?.ctx.baseUrl, 'https://example.com');
		assert.strictEqual(call?.ctx.apiKey, 'k');
	});

	test('自定义 chat 无条件优先：绕过 namingProviderId，凭据取自自定义模型自身', () => {
		const custom: RuntimeProvider = {
			id: 'custom',
			label: '自定义',
			image: [],
			chat: [
				// 首项凭据不全：须被跳过，绝不与 config 里的内置凭据拼凑
				{ model: 'no-key', label: 'no-key', adapter: 'openai-chat', baseUrl: 'https://c1.example' },
				// 可用但非目标的干扰项：若接线忽略 namingModel 只取首个可用项，会错选它、测试即失败
				{ model: 'decoy', label: 'decoy', adapter: 'openai-chat', baseUrl: 'https://c3.example', apiKey: 'dk' },
				{ model: 'deepseek-v4-flash', label: 'ds', adapter: 'openai-chat', baseUrl: 'https://c2.example', apiKey: 'ck' },
			],
		};
		// namingProviderId 传未知值：走到内置回落会抛「未知渠道」，能走通即证明自定义优先绕过了它
		const call = resolveChatCall(
			{ ...baseConfig, namingProviderId: 'bogus', namingModel: 'deepseek-v4-flash' },
			custom
		);
		assert.strictEqual(call?.model, 'deepseek-v4-flash');
		assert.strictEqual(call?.ctx.baseUrl, 'https://c2.example');
		assert.strictEqual(call?.ctx.apiKey, 'ck');
	});
});
