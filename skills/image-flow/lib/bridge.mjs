// 回环 HTTP 桥：扩展激活时在 127.0.0.1 的固定候选端口段（47870~47879）依次试绑服务，
// 壳按同序扫描端口直连 POST {token, op, md|cwd, args} 同步拿结果。
// 端口发现零落盘、工作区内没有任何桥接文件（与扩展侧 src/ui/cliBridge.ts 约定一致）。
// 用 node:http 而非全局 fetch：fetch 在 NODE_USE_ENV_PROXY=1 时会把 127.0.0.1 请求发给代理
// （token/路径泄露给代理且直接连不上），node:http 不读代理环境变量、恒定直连。

import { setTimeout as sleep } from 'node:timers/promises';
import * as http from 'node:http';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fail } from './errors.mjs';

// 候选端口段：与扩展侧 src/ui/cliBridge.ts 约定一致
export const PORT_START = 47870;
export const PORT_COUNT = 10;
// 连接重试窗口：覆盖「窗口正在重载、服务还没起来」的一两秒空档
const CONNECT_ATTEMPTS = 6;
const CONNECT_INTERVAL_MS = 500;
// 单次请求处理超时（socket 无活动即超时）：fix/list 要扫素材库目录，给足窗口
export const REQUEST_TIMEOUT_MS = 30_000;
// 轻查询（纯读、扩展本地秒回）：list_model/list_task/query_result/favorite——响应可能不小但不该卡
export const LIGHT_TIMEOUT_MS = 10_000;
// submit 要等扩展完成创建阶段（解析提示词 + 归档参考图，视频参考素材可达数十 MB），单独放宽
export const SUBMIT_TIMEOUT_MS = 120_000;

const NOT_RUNNING_MSG =
	'连不上 image-flow 扩展——请确认目标工作区已在 VS Code 打开、扩展已激活。';

/** 发一次请求，resolve { status, marker, text }；socket 无活动超时以 code=IMGFLOW_TIMEOUT reject */
function request(port, body, timeoutMs) {
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
		req.setTimeout(timeoutMs, () => {
			req.destroy(Object.assign(new Error('处理超时'), { code: 'IMGFLOW_TIMEOUT' }));
		});
		req.on('error', reject);
		req.end(JSON.stringify(body));
	});
}

/** 是否「连接被拒」：唯一能证明请求从未送达、可安全重发的错误（含 AggregateError 包裹） */
function isConnRefused(e) {
	if (e?.code === 'ECONNREFUSED') {
		return true;
	}
	return Array.isArray(e?.errors) && e.errors.some((x) => x?.code === 'ECONNREFUSED');
}

/**
 * 扫描候选端口段找到目标窗口，外层多轮重试跨过窗口重载的空档。换下一个端口的只有五类：
 * 连接被拒（没人监听）、响应无扩展标识头（端口被陌生进程占用）、421（是扩展但不是目标工作区
 * 的窗口——归属校验在 op 执行之前，非目标窗口零副作用）、带标识头的 403（token 不一致，
 * 服务端未进业务逻辑）、带版本不匹配签名的 400（新旧版本窗口共存，拒绝发生在字段校验层、
 * 同样零副作用）。带标识头的其余响应一律是最终结果，不再换端口/重发——
 * fix 回写 md、submit 建任务扣额度，「已送达但结果不明」时重发会双跑。
 * lenient：--poll 的查询轮用——query_result 只读可安全跳过瞬时故障，超时/中途错误不终止进程。
 * deadline：绝对截止时刻（ms），过点即放弃剩余端口返回——让 --poll=N 真正兜住总等待时间。
 * 返回 { res, lastRejected }；res=null 表示本轮没找到目标窗口。
 */
export async function scanSend(body, { attempts = CONNECT_ATTEMPTS, timeoutMs = REQUEST_TIMEOUT_MS, lenient = false, deadline = Infinity, portCache } = {}) {
	let lastRejected = null; // 带标识头的 403 或版本不匹配 400（穷尽重试后原样报告，而非误报「连不上」）
	const portOrder = portCache ? portCache.order(PORT_START, PORT_COUNT) : [...Array(PORT_COUNT).keys()].map((i) => PORT_START + i);
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) {
			await sleep(CONNECT_INTERVAL_MS);
		}
		for (const port of portOrder) {
			if (Date.now() >= deadline) {
				return { res: null, lastRejected };
			}
			let r;
			try {
				r = await request(port, body, timeoutMs);
			} catch (e) {
				if (e?.code === 'IMGFLOW_TIMEOUT') {
					if (lenient) {
						continue;
					}
					fail(`等待 VS Code 处理超时（${timeoutMs / 1000}s）——任务/素材库过大或扩展卡住。`);
				}
				if (isConnRefused(e)) {
					continue;
				}
				// 已连上但中途出错：无法确定扩展是否已执行操作，绝不重发（只读的查询轮除外）
				if (lenient) {
					continue;
				}
				fail(`请求 image-flow 扩展失败（无法确认是否已执行，不自动重发）：${e?.message ?? e}`);
			}
			// 响应不带扩展标识头：端口被别的进程占用，换下一个
			if (!r.marker) {
				continue;
			}
			// 421：是扩展但请求不属于该窗口的工作区，换下一个端口找目标窗口
			if (r.status === 421) {
				continue;
			}
			// 403：token 不一致（如刚删过 token 文件、扩展还没重载），记录后继续找能认的窗口
			if (r.status === 403) {
				lastRejected = r;
				continue;
			}
			// 400 且带版本不匹配签名：旧版扩展在归属校验（421）之前就会拒掉新协议请求
			//（旧版缺 md 报「需为非空字符串」、不认新 op 报「未知操作」），新旧版本窗口共存时
			// 视作「不是目标窗口」换下一个端口；记录并附提示，全扫无果时报出
			if (r.status === 400 && (r.text.includes('需为非空字符串') || r.text.includes('未知操作'))) {
				lastRejected = {
					...r,
					text: `${r.text.trimEnd()}（可能有旧版扩展窗口不识别此命令：升级扩展或重载对应窗口后重试）\n`,
				};
				continue;
			}
			// 找到目标窗口（端口缓存命中成功端口），记录后返回
			portCache?.markSuccess(port);
			return { res: r, lastRejected };
		}
	}
	return { res: null, lastRejected };
}

/**
 * 端口缓存（用户级 ~/.image-flow/port-cache.json）：记住上次成功的端口，下次优先试它再全扫，
 * 省掉每次都从头扫 10 个端口。与 token 同置用户级状态目录，保持工作区内零桥接文件。
 * 缓存损坏/缺字段时静默回退到全扫顺序（只读操作，不报错打扰）。
 */
export function createPortCache(cachePath) {
	let bestPort = null;
	try {
		// 同步读：进程启动早期就可用，且读失败不该阻塞主流程
		const raw = readFileSync(cachePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (Number.isInteger(parsed?.port) && parsed.port >= 0) {
			bestPort = parsed.port;
		}
	} catch {
		/* 无缓存/损坏：按全扫顺序 */
	}
	return {
		/** 优先缓存端口、再按编号全扫的访问顺序 */
		order(start, count) {
			const ports = [...Array(count).keys()].map((i) => start + i);
			if (bestPort !== null && ports.includes(bestPort)) {
				// 缓存端口提前，其余保持编号顺序
				return [bestPort, ...ports.filter((p) => p !== bestPort)];
			}
			return ports;
		},
		/** 命中后异步写缓存（失败静默） */
		markSuccess(port) {
			if (bestPort === port) {
				return;
			}
			bestPort = port;
			// fsp 是 Promise 版 API，外层 try/catch 捕获不到异步 rejection；用 async IIFE 包裹，
			// 失败静默，绝不让写缓存的异常破坏本次请求的输出（Node 24 默认 unhandled-rejection 即崩溃）
			void (async () => {
				try {
					await fsp.mkdir(path.dirname(cachePath), { recursive: true });
					await fsp.writeFile(cachePath, JSON.stringify({ port }), 'utf8');
				} catch {
					/* 写缓存失败不影响本次请求 */
				}
			})();
		},
	};
}

export function notRunningMsg() {
	return NOT_RUNNING_MSG;
}
