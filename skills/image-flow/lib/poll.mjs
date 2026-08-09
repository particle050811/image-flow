// --poll 的任务轮询：任务未终结则壳内每 1s 重查，直到终结或超时；最终只输出最后一次 JSON。
// 每次查询都用宽松扫描（只读可安全跳过瞬时故障），单次请求超时收窄到剩余时间。

import { setTimeout as sleep } from 'node:timers/promises';
import { scanSend, REQUEST_TIMEOUT_MS } from './bridge.mjs';

export const POLL_INTERVAL_MS = 1000;

/**
 * @param {object} opts
 * @param {string} opts.pollCwd 查询路由的 cwd（submit 用 md 所在目录，edit 用进程 cwd）
 * @param {string} opts.submitId 任务 id
 * @param {number} opts.pollSeconds --poll=N 总等待上限（秒）
 * @param {{ token: string }} opts.auth
 * @param {object} [opts.portCache] 端口缓存（可复用成功端口）
 * @returns {Promise<{ text: string, errored: boolean }>} 最终 JSON 文本；errored=true 表示中途遇非 200（内容已含 submit_id 兜底）
 */
export async function pollTask({ pollCwd, submitId, pollSeconds, auth, portCache }) {
	const pollPayload = { token: auth.token, op: 'query_result', cwd: pollCwd, args: { submit_id: submitId } };
	const deadline = Date.now() + pollSeconds * 1000;
	// 最后一次成功拿到的查询文本：超时/无新结果时带回给调用方，避免丢失轮询期间最新 progress 快照
	let lastText = null;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		// 睡醒重查截止：--poll=N 是总等待上限，过点不再发请求
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			break;
		}
		// 单轮宽松扫描：窗口重载等瞬时不可达当作过路波动，未到截止继续查；
		// 单次请求超时收窄到剩余时间（至少 1s），避免一次慢请求把总时长拖出 N 秒外
		const tick = await scanSend(pollPayload, { attempts: 1, timeoutMs: Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, remaining)), lenient: true, deadline, portCache });
		if (!tick.res) {
			continue;
		}
		if (tick.res.status !== 200) {
			// 任务可能已建成，含 submit_id 的最后一次 JSON 不能丢：errored 标记给调用方补 stdout
			return { text: tick.res.text, errored: true };
		}
		lastText = tick.res.text;
		let parsed;
		try {
			parsed = JSON.parse(tick.res.text);
		} catch {
			return { text: tick.res.text, errored: false };
		}
		if (parsed.gen_status !== 'querying') {
			return { text: tick.res.text, errored: false };
		}
	}
	// 超时（任务仍在 querying）：带回最后一次成功快照（若有），调用方输出它而非最初响应
	return { text: lastText, errored: false };
}
