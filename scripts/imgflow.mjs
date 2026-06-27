#!/usr/bin/env node
// image-flow CLI 壳：给 AI 同步调用。
//
// 为什么是「壳」：真正的 list/fix 逻辑跑在 VS Code 扩展主进程里（要读 workspaceState 里的素材库列表，
// 独立进程读不到）。这个壳通过「文件请求」桥接：往工作区根 .image-flow/requests/ 写一个请求 json，
// 扩展的 FileSystemWatcher 收到后处理、把结果原子写进 out 文件，壳轮询读回并打印。
// 不用 vscode:// URI（外部触发会弹「是否允许扩展打开此 URI」确认，与零点击自动调用冲突）。
//
// 前提：目标工作区已在 VS Code 打开、image-flow 扩展已激活、素材库已配置。
// 用法：
//   node scripts/imgflow.mjs list <md路径>
//   node scripts/imgflow.mjs fix  <md路径>

import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const POLL_INTERVAL_MS = 120;
const TIMEOUT_MS = 30_000;

function fail(msg) {
	process.stderr.write(msg + '\n');
	process.exit(1);
}

const [op, mdArg] = process.argv.slice(2);
if ((op !== 'list' && op !== 'fix') || !mdArg) {
	process.stderr.write('用法: node scripts/imgflow.mjs <list|fix> <md路径>\n');
	process.exit(2);
}

const mdAbs = path.resolve(mdArg);

// 向上找含 .image-flow 的目录作为工作区根（扩展把存储目录建在工作区根，且只此一处）。
// 排除用户主目录：~/.image-flow 是自定义 Provider 的 settings.json 所在，不是工作区、没有窗口监听，
// 误判会让请求写进无人处理的目录而超时。
function findRoot(startDir) {
	const home = homedir();
	let dir = startDir;
	for (;;) {
		if (dir !== home && existsSync(path.join(dir, '.image-flow'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

const root = findRoot(path.dirname(mdAbs));
if (!root) {
	fail('找不到 .image-flow 目录——请确认该 md 在已用过 image-flow 的工作区内，且该工作区已在 VS Code 打开。');
}

const id = randomUUID();
const reqDir = path.join(root, '.image-flow', 'requests');
const reqAbs = path.join(reqDir, `req-${id}.json`);
const outAbs = path.join(tmpdir(), `imgflow-${id}.txt`);

try {
	await fs.mkdir(reqDir, { recursive: true });
	// 原子写请求：先 .tmp 再 rename 成 req-*.json，watcher 只匹配 req-*.json，避免读到半截
	const tmp = reqAbs + '.tmp';
	await fs.writeFile(tmp, JSON.stringify({ op, md: mdAbs, out: outAbs }), 'utf8');
	await fs.rename(tmp, reqAbs);

	// 轮询 out（扩展端临时文件+rename 原子写，文件一出现即完整）
	const deadline = Date.now() + TIMEOUT_MS;
	let result = null;
	while (Date.now() < deadline) {
		try {
			result = await fs.readFile(outAbs, 'utf8');
			break;
		} catch {
			await sleep(POLL_INTERVAL_MS);
		}
	}

	if (result === null) {
		await fs.unlink(reqAbs).catch(() => {}); // 清掉没人处理的残留请求
		fail('等待 VS Code 响应超时——确认目标工作区已在 VS Code 打开、image-flow 扩展已激活。');
	}

	await fs.unlink(outAbs).catch(() => {});
	// 扩展端出错时 out 以 "ERROR " 开头：原样转给 AI，并以非零退出码标记失败
	if (result.startsWith('ERROR ')) {
		process.stderr.write(result);
		process.exit(1);
	}
	process.stdout.write(result);
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}
