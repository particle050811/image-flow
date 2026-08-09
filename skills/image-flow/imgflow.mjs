#!/usr/bin/env node
// image-flow CLI 壳：给 AI 同步调用。真正的逻辑跑在 VS Code 扩展主进程里（要读 workspaceState
// 里的素材库列表、内存里的任务实时态，独立进程读不到），壳只负责「解析参数 → 构建请求 →
// 经回环 HTTP 桥取结果 → 轮询/格式化 → 输出」。具体能力拆在 lib/ 各模块：
//   lib/args.mjs    命令面定义 + 参数解析（哪些 op、各 op 允许哪些 flag）
//   lib/bridge.mjs  回环 HTTP 桥 + 端口扫描 + 端口缓存
//   lib/poll.mjs    --poll 的任务轮询
//   lib/format.mjs  list_model 精简输出 + debug 计时
//   lib/errors.mjs  统一错误出口
//
// 前提：目标工作区已在 VS Code 打开、image-flow 扩展已激活。
// 用法：
//   node .claude/skills/image-flow/imgflow.mjs list    <md路径>
//   node .claude/skills/image-flow/imgflow.mjs fix     <md路径>
//   node .claude/skills/image-flow/imgflow.mjs preview <md路径>
//   node .claude/skills/image-flow/imgflow.mjs submit  <md路径> [--model=模型名或渠道:模型名] [--ratio=3:4]
//                                    [--resolution=2k] [--generate_num=4] [--param=键=值] [--poll=秒]
//   node .claude/skills/image-flow/imgflow.mjs edit    --prompt=<提示词正文> [--image=<图片路径>]... [同上覆盖参数] [--poll=秒]
//   node .claude/skills/image-flow/imgflow.mjs query_result --submit_id=yyMMdd/HHmmssSSS [--poll=秒]
//   node .claude/skills/image-flow/imgflow.mjs list_task [--limit=20]
//   node .claude/skills/image-flow/imgflow.mjs list_model [--full]
//   node .claude/skills/image-flow/imgflow.mjs favorite --path=<产物绝对路径> [--note=备注]
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
//
// --debug：任意命令后跟 --debug 或设环境变量 IMGFLOW_DEBUG=1，脚本返回时在 stdout 末尾追加
// 一行 `[debug] <本次总耗时>s`，方便量各命令耗时。可配合 --full（list_model）或 --poll 使用。

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { MD_OPS, parseArgs, intFlag } from './lib/args.mjs';
import { scanSend, createPortCache, SUBMIT_TIMEOUT_MS, REQUEST_TIMEOUT_MS, LIGHT_TIMEOUT_MS, notRunningMsg } from './lib/bridge.mjs';
import { pollTask } from './lib/poll.mjs';
import { formatListModelCompact, createTimer } from './lib/format.mjs';
import { fail, usageFail as makeUsageFail } from './lib/errors.mjs';

const USAGE = `用法:
  node .claude/skills/image-flow/imgflow.mjs list    <md路径>
  node .claude/skills/image-flow/imgflow.mjs fix     <md路径>
  node .claude/skills/image-flow/imgflow.mjs preview <md路径>
  node .claude/skills/image-flow/imgflow.mjs submit  <md路径> [--model=] [--ratio=] [--resolution=] [--generate_num=] [--param=键=值] [--poll=秒]
  node .claude/skills/image-flow/imgflow.mjs edit    --prompt=<提示词> [--image=<图片路径>]... [--model=] [--ratio=] [--resolution=] [--generate_num=] [--param=键=值] [--poll=秒]
  node .claude/skills/image-flow/imgflow.mjs query_result --submit_id=yyMMdd/HHmmssSSS [--poll=秒]
  node .claude/skills/image-flow/imgflow.mjs list_task [--limit=20]
  node .claude/skills/image-flow/imgflow.mjs list_model [--full]
  node .claude/skills/image-flow/imgflow.mjs favorite --path=<产物绝对路径> [--note=备注]
`;
const usageFail = makeUsageFail(USAGE);

const timer = createTimer();

// —— 参数解析 —— //
const { op, mdArg, flags, params, imageArgs } = parseArgs(process.argv.slice(2), usageFail);
// 调试开关：--debug / --debug=1 或环境变量 IMGFLOW_DEBUG=1 任一开启（--debug=0 视为关闭）
const debug = (flags.debug !== undefined && flags.debug !== '0') || process.env.IMGFLOW_DEBUG === '1';
const pollSeconds = intFlag(flags, 'poll', usageFail) ?? 0;

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

// 端口缓存（用户级）：记住上次成功端口，优先试它再全扫
const portCache = createPortCache(path.join(homedir(), '.image-flow', 'port-cache.json'));

/** 按次覆盖参数（submit 与 edit 共用）：只带用户显式给的 flag，其余留给扩展侧回落配置 */
function overrideArgs() {
	const args = {};
	for (const key of ['model', 'ratio', 'resolution']) {
		if (flags[key] !== undefined) {
			args[key] = flags[key];
		}
	}
	const generateNum = intFlag(flags, 'generate_num', usageFail);
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
	const limit = intFlag(flags, 'limit', usageFail);
	if (limit !== undefined) {
		args.limit = limit;
	}
	payload = { token, op, cwd, args };
}

// —— 桥接取结果 —— //
// submit/edit 都要等扩展完成创建阶段（解析提示词 + 读参考图转 base64 + 归档），单独放宽；
// 其余纯查询走普通/轻量超时（list_model/list_task/query_result/favorite 本地秒回，不该卡 30s）
const timeoutMs =
	op === 'submit' || op === 'edit'
		? SUBMIT_TIMEOUT_MS
		: ['list_model', 'list_task', 'query_result', 'favorite'].includes(op)
			? LIGHT_TIMEOUT_MS
			: REQUEST_TIMEOUT_MS;
const { res, lastRejected } = await scanSend(payload, { timeoutMs, portCache });
if (!res) {
	fail(lastRejected ? lastRejected.text.trimEnd() : notRunningMsg());
}
if (res.status !== 200) {
	// 扩展端错误响应以 "ERROR " 开头：原样转给 AI，并以非零退出码标记失败
	process.stderr.write(res.text);
	process.exit(1);
}

let finalText = res.text;

// —— --poll：任务未终结则壳内每 1s 重查，直到终结或超时 —— //
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
		const polled = await pollTask({
			pollCwd,
			submitId,
			pollSeconds,
			auth: { token },
			portCache,
		});
		if (polled.errored) {
			// 任务可能已建成，含 submit_id 的最后一次 JSON 不能丢：先补到 stdout 再报错退出
			process.stdout.write(finalText);
			process.stderr.write(polled.text);
			process.exit(1);
		}
		if (polled.text !== null) {
			finalText = polled.text;
		}
	}
}

// —— 输出：list_model 默认精简；--debug 追加耗时行 —— //
if (op === 'list_model' && flags.full === undefined) {
	try {
		process.stdout.write(formatListModelCompact(JSON.parse(finalText)));
	} catch {
		// 非 JSON：原样输出
		process.stdout.write(finalText);
	}
} else {
	process.stdout.write(finalText);
}
if (debug) {
	timer.end(op);
}
