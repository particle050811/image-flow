#!/usr/bin/env node
// image-flow CLI 壳：给 AI 同步调用。
//
// 为什么是「壳」：真正的 list/fix 逻辑跑在 VS Code 扩展主进程里（要读 workspaceState 里的素材库列表，
// 独立进程读不到）。这个壳通过回环 HTTP 桥接：扩展激活时在 127.0.0.1 的固定候选端口段
// （47870~47879）依次试绑服务，壳按同一顺序扫描端口直连 POST 拿结果——真同步请求/响应，
// VS Code 没开时连接立刻被拒、秒级报错。端口发现零落盘，工作区内没有任何桥接文件；
// token 是用户级稳定值，存 ~/.image-flow/token（扩展首次激活生成）。
// 不用 vscode:// URI（外部触发会弹「是否允许扩展打开此 URI」确认，与零点击自动调用冲突）；
// 用 node:http 而非全局 fetch：fetch 在 NODE_USE_ENV_PROXY=1 时会把 127.0.0.1 请求发给代理
// （token/路径泄露给代理且直接连不上），node:http 不读代理环境变量、恒定直连。
//
// 前提：目标工作区已在 VS Code 打开、image-flow 扩展已激活、素材库已配置。
// 用法：
//   node scripts/imgflow.mjs list    <md路径>
//   node scripts/imgflow.mjs fix     <md路径>
//   node scripts/imgflow.mjs preview <md路径>

import { setTimeout as sleep } from 'node:timers/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';

// 候选端口段：与扩展侧 src/ui/cliBridge.ts 约定一致
const PORT_START = 47870;
const PORT_COUNT = 10;
// 连接重试窗口：覆盖「窗口正在重载、服务还没起来」的一两秒空档
const CONNECT_ATTEMPTS = 6;
const CONNECT_INTERVAL_MS = 500;
// 单次请求处理超时（socket 无活动即超时）：fix/list 要扫素材库目录，给足窗口
const REQUEST_TIMEOUT_MS = 30_000;
const NOT_RUNNING_MSG =
	'连不上 image-flow 扩展——请确认目标工作区已在 VS Code 打开、扩展已激活。';

function fail(msg) {
	process.stderr.write(msg + '\n');
	process.exit(1);
}

const [op, mdArg] = process.argv.slice(2);
if ((op !== 'list' && op !== 'fix' && op !== 'preview') || !mdArg) {
	process.stderr.write('用法: node scripts/imgflow.mjs <list|fix|preview> <md路径>\n');
	process.exit(2);
}

const mdAbs = path.resolve(mdArg);

// 用户级稳定 token：扩展首次激活生成，跨窗口/跨重启复用
const tokenPath = path.join(homedir(), '.image-flow', 'token');
let token = '';
try {
	token = (await fs.readFile(tokenPath, 'utf8')).trim();
} catch {
	/* 缺失走下面统一报错 */
}
if (!token) {
	fail(`读不到 ${tokenPath}——请先在 VS Code 打开任一工作区激活 image-flow 扩展（首次激活会生成该文件）。`);
}

/** 发一次请求，resolve { status, marker, text }；socket 无活动超时以 code=IMGFLOW_TIMEOUT reject */
function request(port, payload) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				path: '/',
				method: 'POST',
				headers: { 'content-type': 'application/json' },
			},
			(res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('error', reject);
				res.on('end', () =>
					resolve({
						status: res.statusCode,
						marker: res.headers['x-image-flow'],
						text: Buffer.concat(chunks).toString('utf8'),
					})
				);
			}
		);
		req.setTimeout(REQUEST_TIMEOUT_MS, () => {
			req.destroy(Object.assign(new Error('处理超时'), { code: 'IMGFLOW_TIMEOUT' }));
		});
		req.on('error', reject);
		req.end(JSON.stringify(payload));
	});
}

/** 是否「连接被拒」：唯一能证明请求从未送达、可安全重发的错误（含 AggregateError 包裹） */
function isConnRefused(e) {
	if (e?.code === 'ECONNREFUSED') {
		return true;
	}
	return Array.isArray(e?.errors) && e.errors.some((x) => x?.code === 'ECONNREFUSED');
}

// 扫描候选端口段找到目标窗口，外层多轮重试跨过窗口重载的空档。换下一个端口的只有四类：
// 连接被拒（没人监听）、响应无扩展标识头（端口被陌生进程占用）、421（是扩展但不是目标工作区
// 的窗口——归属校验在 op 执行之前，非目标窗口零副作用）、带标识头的 403（token 不一致，
// 服务端未进业务逻辑）。带标识头的其余响应一律是最终结果，不再换端口/重发——
// fix 会回写 md，「已送达但结果不明」时重发会双跑。
let res = null;
let lastRejected = null; // 带标识头的 403（穷尽重试后原样报告，而非误报「连不上」）
outer: for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
	if (attempt > 0) {
		await sleep(CONNECT_INTERVAL_MS);
	}
	for (let i = 0; i < PORT_COUNT; i++) {
		let r;
		try {
			r = await request(PORT_START + i, { token, op, md: mdAbs });
		} catch (e) {
			if (e?.code === 'IMGFLOW_TIMEOUT') {
				fail(`等待 VS Code 处理超时（${REQUEST_TIMEOUT_MS / 1000}s）——素材库过大或扩展卡住。`);
			}
			if (isConnRefused(e)) {
				continue;
			}
			// 已连上但中途出错：无法确定扩展是否已执行操作，绝不重发
			fail(`请求 image-flow 扩展失败（无法确认是否已执行，不自动重发）：${e?.message ?? e}`);
		}
		// 响应不带扩展标识头：端口被别的进程占用，换下一个
		if (!r.marker) {
			continue;
		}
		// 421：是扩展但 md 不在该窗口的工作区内，换下一个端口找目标窗口
		if (r.status === 421) {
			continue;
		}
		// 403：token 不一致（如刚删过 token 文件、扩展还没重载），记录后继续找能认的窗口
		if (r.status === 403) {
			lastRejected = r;
			continue;
		}
		res = r;
		break outer;
	}
}

if (!res) {
	fail(lastRejected ? lastRejected.text.trimEnd() : NOT_RUNNING_MSG);
}

if (res.status !== 200) {
	// 扩展端错误响应以 "ERROR " 开头：原样转给 AI，并以非零退出码标记失败
	process.stderr.write(res.text);
	process.exit(1);
}
process.stdout.write(res.text);
