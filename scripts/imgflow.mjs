#!/usr/bin/env node
// image-flow CLI 壳：给 AI 同步调用。
//
// 为什么是「壳」：真正的逻辑跑在 VS Code 扩展主进程里（要读 workspaceState 里的素材库列表、
// 内存里的任务实时态，独立进程读不到）。这个壳通过回环 HTTP 桥接：扩展激活时在 127.0.0.1
// 的固定候选端口段（47870~47879）依次试绑服务，壳按同一顺序扫描端口直连 POST 拿结果——
// 真同步请求/响应，VS Code 没开时连接立刻被拒、秒级报错。端口发现零落盘，工作区内没有任何
// 桥接文件；token 是用户级稳定值，存 ~/.image-flow/token（扩展首次激活生成）。
// 不用 vscode:// URI（外部触发会弹「是否允许扩展打开此 URI」确认，与零点击自动调用冲突）；
// 用 node:http 而非全局 fetch：fetch 在 NODE_USE_ENV_PROXY=1 时会把 127.0.0.1 请求发给代理
// （token/路径泄露给代理且直接连不上），node:http 不读代理环境变量、恒定直连。
//
// 前提：目标工作区已在 VS Code 打开、image-flow 扩展已激活。
// 用法：
//   node scripts/imgflow.mjs list    <md路径>
//   node scripts/imgflow.mjs fix     <md路径>
//   node scripts/imgflow.mjs preview <md路径>
//   node scripts/imgflow.mjs submit  <md路径> [--model=模型名或渠道:模型名] [--ratio=3:4]
//                                    [--resolution=2k] [--generate_num=4] [--param=键=值] [--poll=秒]
//   node scripts/imgflow.mjs edit    --prompt=<提示词正文> [--image=<图片路径>]... [同上覆盖参数] [--poll=秒]
//   node scripts/imgflow.mjs query_result --submit_id=yyMMdd/HHmmssSSS [--poll=秒]
//   node scripts/imgflow.mjs list_task [--limit=20]
//   node scripts/imgflow.mjs list_model
//   node scripts/imgflow.mjs favorite --path=<产物绝对路径> [--note=备注]
//
// 模型调用类命令（submit/edit/query_result/list_task/list_model/favorite）输出 JSON：
// 成败看 gen_status（querying/success/fail + fail_reason），不看退出码（非零退出码只代表传输层失败）。
// submit 不传的参数回落该模型在侧栏的配置（等价「侧栏切到该模型点生成」），响应回显实际生效值。
// edit 是编辑模式（图生图，不写 md）：等价「编辑页拖图进编辑区 + 输入提示词点生成」，参数基线取编辑页配置。
// 一次 edit = 一个任务，多个 --image 是同一次编辑的多张参考图（顺序即编号）；
// 「同一提示词批量套到 N 张图」请写循环调 N 次，每次一个 --image。
// --prompt 里可用 [主名] 引用某张图（主名 = 文件名去扩展名），会替换为 【@图片N】；
// 不写引用也行（图仍按序上传作参考，只是正文里没有 【@图片N】 指针），--image 全省即纯文生图。
// --poll=N：壳内每 1s 查询一次直到任务终结或超过 N 秒（默认 0 纯异步，提交即返回 submit_id）。
// favorite 把核对过的产物收进侧栏当前收藏夹（path 取 query_result 输出的绝对路径，须在工作区内），
// 可带一句备注说明为何选它；重复收藏幂等（不会取消已收藏项）。
// edit/查询/收藏类命令按当前目录（cwd）归属路由到对应 VS Code 窗口，需在目标工作区目录下运行；
// 但 edit 的 --image 参考图路径不限工作区（与编辑页可上传任意目录的图一致），相对路径按 cwd 解析。

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
// submit 要等扩展完成创建阶段（解析提示词 + 归档参考图，视频参考素材可达数十 MB），单独放宽
const SUBMIT_TIMEOUT_MS = 120_000;
// --poll 的查询间隔（与即梦 dreamina CLI 一致）
const POLL_INTERVAL_MS = 1000;
const NOT_RUNNING_MSG =
	'连不上 image-flow 扩展——请确认目标工作区已在 VS Code 打开、扩展已激活。';

const USAGE = `用法:
  node scripts/imgflow.mjs list    <md路径>
  node scripts/imgflow.mjs fix     <md路径>
  node scripts/imgflow.mjs preview <md路径>
  node scripts/imgflow.mjs submit  <md路径> [--model=] [--ratio=] [--resolution=] [--generate_num=] [--param=键=值] [--poll=秒]
  node scripts/imgflow.mjs edit    --prompt=<提示词> [--image=<图片路径>]... [--model=] [--ratio=] [--resolution=] [--generate_num=] [--param=键=值] [--poll=秒]
  node scripts/imgflow.mjs query_result --submit_id=yyMMdd/HHmmssSSS [--poll=秒]
  node scripts/imgflow.mjs list_task [--limit=20]
  node scripts/imgflow.mjs list_model
  node scripts/imgflow.mjs favorite --path=<产物绝对路径> [--note=备注]
`;

// 需要 md 位置参数的 op / 按 cwd 路由的 op（含 edit、favorite 这类有副作用的，与扩展侧 CWD_OPS 同名同集）；
// 各 op 允许的 --flag 白名单（拦 AI 手误）
const MD_OPS = ['list', 'fix', 'preview', 'submit'];
const CWD_OPS = ['query_result', 'list_task', 'list_model', 'favorite', 'edit'];
const ALLOWED_FLAGS = {
	list: [],
	fix: [],
	preview: [],
	submit: ['model', 'ratio', 'resolution', 'generate_num', 'param', 'poll'],
	edit: ['prompt', 'image', 'model', 'ratio', 'resolution', 'generate_num', 'param', 'poll'],
	query_result: ['submit_id', 'poll'],
	list_task: ['limit'],
	list_model: [],
	favorite: ['path', 'note'],
};

function fail(msg) {
	process.stderr.write(msg + '\n');
	process.exit(1);
}

function usageFail(msg) {
	process.stderr.write((msg ? msg + '\n' : '') + USAGE);
	process.exit(2);
}

// —— 参数解析：op + 可选 md 位置参数 + --key=value 选项（--param=键=值 可重复） —— //
const [op, ...rest] = process.argv.slice(2);
if (!MD_OPS.includes(op) && !CWD_OPS.includes(op)) {
	usageFail();
}
const flags = {};
const params = {};
/** --image 可重复：顺序即参考图编号顺序（同一次编辑的多张参考图） */
const imageArgs = [];
let mdArg;
for (const a of rest) {
	if (a.startsWith('--')) {
		const eq = a.indexOf('=');
		if (eq < 0) {
			usageFail(`选项 ${a} 须为 --key=value 形式`);
		}
		const key = a.slice(2, eq);
		const value = a.slice(eq + 1);
		if (!ALLOWED_FLAGS[op].includes(key)) {
			usageFail(`${op} 不支持选项 --${key}`);
		}
		if (key === 'param') {
			const eq2 = value.indexOf('=');
			if (eq2 <= 0) {
				usageFail('--param 须为 --param=键=值 形式');
			}
			params[value.slice(0, eq2)] = value.slice(eq2 + 1);
		} else if (key === 'image') {
			if (!value) {
				usageFail('--image 须带路径（--image=<图片路径>）');
			}
			imageArgs.push(value);
		} else if (key in flags) {
			usageFail(`选项 --${key} 重复`);
		} else {
			flags[key] = value;
		}
	} else if (MD_OPS.includes(op) && mdArg === undefined) {
		mdArg = a;
	} else {
		usageFail(`多余参数：${a}`);
	}
}
if (MD_OPS.includes(op) && !mdArg) {
	usageFail(`${op} 需要 <md路径> 参数`);
}
if (op === 'query_result' && !flags.submit_id) {
	usageFail('query_result 需要 --submit_id=yyMMdd/HHmmssSSS');
}
if (op === 'edit' && !flags.prompt) {
	usageFail('edit 需要 --prompt=<提示词正文>');
}
if (op === 'favorite' && !flags.path) {
	usageFail('favorite 需要 --path=<产物绝对路径>');
}

/** 把 --flag 字符串解析为正整数；非法即用法报错 */
function intFlag(name) {
	if (flags[name] === undefined) {
		return undefined;
	}
	const n = Number(flags[name]);
	if (!Number.isInteger(n) || n < 0) {
		usageFail(`--${name} 须为非负整数`);
	}
	return n;
}
const pollSeconds = intFlag('poll') ?? 0;

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

/** 按次覆盖参数（submit 与 edit 共用）：只带用户显式给的 flag，其余留给扩展侧回落配置 */
function overrideArgs() {
	const args = {};
	for (const key of ['model', 'ratio', 'resolution']) {
		if (flags[key] !== undefined) {
			args[key] = flags[key];
		}
	}
	const generateNum = intFlag('generate_num');
	if (generateNum !== undefined) {
		args.generate_num = generateNum;
	}
	if (Object.keys(params).length) {
		args.params = params;
	}
	return args;
}

// —— 构建请求体 —— //
const cwd = process.cwd();
let payload;
if (MD_OPS.includes(op)) {
	payload = { token, op, md: path.resolve(mdArg) };
	if (op === 'submit') {
		payload.args = overrideArgs();
	}
} else {
	const args = {};
	if (op === 'query_result') {
		args.submit_id = flags.submit_id;
	}
	if (op === 'edit') {
		Object.assign(args, overrideArgs());
		args.prompt = flags.prompt;
		// 参考图相对路径按 cwd 解析成绝对路径（扩展进程 cwd 与壳无关，只认绝对路径）
		args.images = imageArgs.map((p) => path.resolve(p));
	}
	if (op === 'favorite') {
		// 相对路径按 cwd 解析成绝对路径再发送（扩展侧只认工作区内的绝对路径）
		args.path = path.resolve(flags.path);
		if (flags.note) {
			args.note = flags.note;
		}
	}
	const limit = intFlag('limit');
	if (limit !== undefined) {
		args.limit = limit;
	}
	payload = { token, op, cwd, args };
}

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
async function scanSend(body, attempts, timeoutMs, lenient = false, deadline = Infinity) {
	let lastRejected = null; // 带标识头的 403 或版本不匹配 400（穷尽重试后原样报告，而非误报「连不上」）
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) {
			await sleep(CONNECT_INTERVAL_MS);
		}
		for (let i = 0; i < PORT_COUNT; i++) {
			if (Date.now() >= deadline) {
				return { res: null, lastRejected };
			}
			let r;
			try {
				r = await request(PORT_START + i, body, timeoutMs);
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
			return { res: r, lastRejected };
		}
	}
	return { res: null, lastRejected };
}

const { res, lastRejected } = await scanSend(
	payload,
	CONNECT_ATTEMPTS,
	// submit/edit 都要等扩展完成创建阶段（解析提示词 + 读参考图转 base64 + 归档），单独放宽
	op === 'submit' || op === 'edit' ? SUBMIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS
);
if (!res) {
	fail(lastRejected ? lastRejected.text.trimEnd() : NOT_RUNNING_MSG);
}
if (res.status !== 200) {
	// 扩展端错误响应以 "ERROR " 开头：原样转给 AI，并以非零退出码标记失败
	process.stderr.write(res.text);
	process.exit(1);
}

// —— --poll：任务未终结则壳内每 1s 重查，直到终结或超时；最终只输出最后一次 JSON —— //
let finalText = res.text;
if (pollSeconds > 0 && (op === 'submit' || op === 'edit' || op === 'query_result')) {
	let result = null;
	try {
		result = JSON.parse(finalText);
	} catch {
		/* 非 JSON（不应出现）：不轮询，原样输出 */
	}
	// query_result 的 id 来自 --submit_id，submit/edit 取本次响应新建的任务 id
	const submitId = op === 'query_result' ? flags.submit_id : result?.submit_id;
	if (result?.gen_status === 'querying' && submitId) {
		// submit 的后续查询按 md 所在目录路由：壳可能在目标工作区外执行（md 必在工作区内），
		// 用进程 cwd 会被所有窗口 421 拒掉，轮询永远查不到。edit 本就按 cwd 路由，沿用 cwd
		const pollCwd = op === 'submit' ? path.dirname(payload.md) : cwd;
		const pollPayload = { token, op: 'query_result', cwd: pollCwd, args: { submit_id: submitId } };
		const deadline = Date.now() + pollSeconds * 1000;
		while (Date.now() < deadline) {
			await sleep(POLL_INTERVAL_MS);
			// 睡醒重查截止：--poll=N 是总等待上限，过点不再发请求
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				break;
			}
			// 单轮宽松扫描：窗口重载等瞬时不可达当作过路波动，未到截止继续查；
			// 单次请求超时收窄到剩余时间（至少 1s），避免一次慢请求把总时长拖出 N 秒外
			const tick = await scanSend(
				pollPayload,
				1,
				Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, remaining)),
				true,
				deadline
			);
			if (!tick.res) {
				continue;
			}
			if (tick.res.status !== 200) {
				// 任务可能已建成，含 submit_id 的最后一次 JSON 不能丢：先补到 stdout 再报错退出
				process.stdout.write(finalText);
				process.stderr.write(tick.res.text);
				process.exit(1);
			}
			finalText = tick.res.text;
			let parsed;
			try {
				parsed = JSON.parse(finalText);
			} catch {
				break;
			}
			if (parsed.gen_status !== 'querying') {
				break;
			}
		}
	}
}
process.stdout.write(finalText);
