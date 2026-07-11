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
import { resolveImageCall, requestTaskName } from '../backend/providerRuntime';
import type { ImageAdapter, SubmitAsync } from '../backend/adapters/types';
import type { PendingTask } from '../shared';
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

/** submitJobs / poll 在后台异步推进，用轮询等待其到达断言点 */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
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
});
