import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import {
	listLibraries,
	listAutoLibraries,
	readImageDesc,
	aliasFromDesc,
	scanDirImages,
} from '../storage/materials';
import type { MediaType, PendingTask, TaskImage } from '../shared';
import { tokenFile, tasksRoot } from '../storage/storage';
import { uriBaseName } from '../storage/paths';
import { parseImageRefs, IMAGE_REGEX, refPath } from '../prompt/buildPrompt';
import { type Decision, decideRef, buildFixReport } from './cliBridgeLogic';
import {
	parseSubmitArgs,
	parseEditArgs,
	resolveSubmitPlan,
	editSubmitConfig,
	normalizeSubmitId,
	taskGenStatus,
	type CliSubmitPlan,
} from './cliOpsLogic';
import { EditSession } from '../prompt/editSession';
import { buildRequestPreviewText } from '../task/preview';
import { aggregateProgress, isTaskActive, type TaskManager } from '../task/tasks';
import { listHistory } from '../task/history';
import { readTaskMeta } from '../task/taskFiles';
import { configOptions } from '../backend/providerRuntime';
import { GRSAI_PROVIDER_ID } from '../backend/providers';
import { isMediaFileName, mediaTypeOfFileName } from '../util/images';
import { checkMediaBytes, checkMediaCount, CLI_EDIT_LIMITS, type MediaSize } from '../util/mediaBytes';
import { addFavorite, mutateFavorites } from '../favorites/favorites';
import { readConfig } from './config';
import { log } from '../util/log';
import { errMsg } from '../util/errors';

/**
 * 「给 AI 自动调用」的命令入口：因库列表/任务态存在扩展主进程、独立进程读不到，
 * 改由 skills/image-flow/imgflow.mjs 这层 CLI 壳桥接——扩展激活时在 127.0.0.1 的固定候选端口段
 * （47870~47879）依次试绑 HTTP 服务，壳按同一顺序扫描端口直连 POST {token, op, md|cwd, args}，
 * 这里在扩展主进程内跑逻辑（有 vscode API + workspaceState），响应体即结果。
 * op 分两类：md 类（list/fix/preview/submit）与 cwd 类（edit/query_result/list_task/list_model/favorite）。
 * md（或 cwd 类的 cwd）不在本窗口工作区时回 421，壳据此换下一个端口找目标窗口——端口发现零落盘，
 * 工作区内不再写任何文件（曾用工作区根 bridge.json 传端口，导致光打开文件夹就拉出 .image-flow）。
 *
 * 选回环 HTTP 而非 vscode:// URI：URI 由外部进程触发会弹「是否允许扩展打开此 URI」安全确认，
 * 与「零点击自动调用」冲突。相比早期的「文件请求 + 轮询」桥，直连是真同步请求/响应：
 * VS Code 没开时连接立刻被拒（壳侧秒级报错而非干等超时），也没有 watcher 漏事件、残留请求文件的问题。
 * 服务只绑 127.0.0.1，请求须带 token（用户级稳定值，存 ~/.image-flow/token、跨激活复用，
 * 不进任何仓库；本机单用户场景不做挑战-响应等更重的防护）。
 */

/** 候选端口段（与 skills/image-flow/imgflow.mjs 约定一致）：依次试绑，绑上哪个用哪个 */
const PORT_START = 47870;
const PORT_COUNT = 10;
/** 响应标识头：壳凭此区分「本扩展的服务」与「端口被复用后的陌生进程」 */
const MARKER_HEADER = 'x-image-flow';
/** 请求体上限：请求只含 token/op/md|cwd/args 几个短字段，64KB 给足余量 */
const MAX_BODY = 64 * 1024;

/** 必须带工作区内 md 的 op（md 兼作窗口归属路由）；submit 与 fix 同理有副作用，锁在本工作区内 */
const MD_OPS = new Set(['list', 'fix', 'preview', 'submit']);
/** 不吃 md 的 cwd 路由 op：payload 带 cwd 做窗口归属路由（421 换端口逻辑与 md 一致）。
 *  favorite 有副作用（写工作区 favorites.json），其 path 参数在处理时另行校验限工作区内；
 *  edit 也有副作用（建任务、调 API），但参考图按产品决策不限工作区（与编辑页可上传任意目录的图一致）*/
const CWD_OPS = new Set(['query_result', 'list_task', 'list_model', 'favorite', 'edit']);

export function registerCliBridge(
	context: vscode.ExtensionContext,
	tasks: TaskManager,
	onFavoritesChanged: () => Promise<void>
): vscode.Disposable {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		// 无工作区：没有库可查、也没有归属校验的基准，返回空 Disposable
		return new vscode.Disposable(() => undefined);
	}
	// 读 token 与逐端口试绑都是异步的，先同步返回 Disposable、后台完成初始化；
	// disposed 标记防「窗口已停用、初始化随后又开始监听」的竞态
	let disposed = false;
	let server: http.Server | undefined;
	void cleanupLegacyBridgeFile(folder.uri);
	void (async () => {
		const token = await loadToken();
		if (!token || disposed) {
			return;
		}
		const srv = http.createServer((req, res) => {
			void handleRequest(context, tasks, folder.uri, token, onFavoritesChanged, req, res);
		});
		const port = await listenOnFreePort(srv, PORT_START, PORT_COUNT);
		if (port === null) {
			log(`CLI 桥候选端口 ${PORT_START}~${PORT_START + PORT_COUNT - 1} 全不可用，桥不可用`);
			return;
		}
		if (disposed) {
			srv.close();
			return;
		}
		srv.on('error', (err) => {
			log(`CLI 桥服务异常：${errMsg(err)}`);
		});
		server = srv;
		log(`CLI 桥已就绪：127.0.0.1:${port}`);
	})();
	return new vscode.Disposable(() => {
		disposed = true;
		server?.close();
	});
}

/**
 * 读用户级稳定 token（~/.image-flow/token，纯文本一行）；不存在则生成随机值写入。
 * 跨激活/跨窗口复用、不轮换：文件在用户主目录、不进任何仓库；删除后重载窗口即换新值。
 */
async function loadToken(): Promise<string | null> {
	const file = tokenFile();
	try {
		const raw = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8').trim();
		if (raw) {
			return raw;
		}
	} catch {
		/* 不存在或读失败，走新建 */
	}
	try {
		const fresh = crypto.randomUUID();
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
		await vscode.workspace.fs.writeFile(file, Buffer.from(fresh + '\n', 'utf8'));
		return fresh;
	} catch (e) {
		log(`CLI 桥 token 文件写入失败，桥不可用：${errMsg(e)}`);
		return null;
	}
}

/**
 * 清理旧机制残留：曾把 {port, token} 写进工作区根 .image-flow/bridge.json（导致光打开
 * 文件夹就创建 .image-flow），现已零落盘。存在即删；目录随之变空则一并移除，
 * 有真实数据（tasks/prompts 等）的目录先查空再删、不受影响。
 */
async function cleanupLegacyBridgeFile(wsFolder: vscode.Uri): Promise<void> {
	const dir = vscode.Uri.joinPath(wsFolder, '.image-flow');
	for (const name of ['bridge.json', 'bridge.json.tmp']) {
		try {
			await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name), { useTrash: false });
		} catch {
			/* 不存在即略过 */
		}
	}
	try {
		if ((await vscode.workspace.fs.readDirectory(dir)).length === 0) {
			await vscode.workspace.fs.delete(dir, { recursive: false, useTrash: false });
		}
	} catch {
		/* 目录不存在等，略过 */
	}
}

/**
 * 在候选端口段 [startPort, startPort + count) 内依次试绑：占用/权限类错误换下一个，全失败返回 null。
 * 多窗口各绑各的端口互不冲突（壳靠 421 找到目标窗口），超出端口池的窗口桥不可用。
 * 每次尝试的 error/listening 两个监听器成对挂、成对摘：listen(port, cb) 的 cb 挂在 'listening' 上，
 * 绑定失败时若不摘掉，残留回调会在后续端口绑定成功时抢先触发、把 Promise resolve 到失败端口号。
 */
export function listenOnFreePort(
	server: http.Server,
	startPort: number,
	count: number
): Promise<number | null> {
	return new Promise((resolve) => {
		let i = 0;
		const tryNext = () => {
			if (i >= count) {
				resolve(null);
				return;
			}
			const port = startPort + i++;
			const onListening = () => {
				server.removeListener('error', onError);
				resolve(port);
			};
			const onError = () => {
				server.removeListener('listening', onListening);
				tryNext();
			};
			server.once('error', onError);
			server.listen(port, '127.0.0.1', onListening);
		};
		tryNext();
	});
}

/** 非空字符串守卫：请求字段来自外部进程，逐项校验类型而非裸信任 */
function isNonEmptyString(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

/**
 * child 是否落在 parent 目录内（含子目录）。fix 会回写 md，把外部请求的 md 路径锁在
 * 工作区内，不让「本机任意进程发请求」变成改写任意文件的原语。Windows 大小写不敏感，统一小写比较。
 */
function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
	return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** child 等于 parent 或落在其内：cwd 窗口归属路由用（壳的 cwd 常就是工作区根本身） */
function sameOrInside(parent: string, child: string): boolean {
	const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 超限错误标记：让处理层能回 413 而非当作普通 400 */
const BODY_TOO_LARGE = 'BODY_TOO_LARGE';

/** 读请求体（带大小上限）。超限时停止收集并以 BODY_TOO_LARGE reject——
 *  不在这里 destroy 连接，留给处理层先回 413 响应（直接断开会让壳误判「扩展未运行」） */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				req.removeAllListeners('data');
				req.removeAllListeners('end');
				reject(Object.assign(new Error('请求体超限'), { code: BODY_TOO_LARGE }));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** 恒定时间比较 token：先各自 sha256 摘要等长化，再 timingSafeEqual */
function tokenMatches(expected: string, got: unknown): boolean {
	if (typeof got !== 'string') {
		return false;
	}
	const a = crypto.createHash('sha256').update(expected).digest();
	const b = crypto.createHash('sha256').update(got).digest();
	return crypto.timingSafeEqual(a, b);
}

/** 统一回包：所有响应（含错误）都带标识头，供壳识别「确实是本扩展在应答」 */
function respond(res: http.ServerResponse, status: number, text: string): void {
	res.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		[MARKER_HEADER]: '1',
	});
	res.end(text);
}

/** 处理一个请求：读体 → 验 token → 校验字段（md/cwd 按 op 分流）→ 跑 op → 响应体即结果 */
async function handleRequest(
	context: vscode.ExtensionContext,
	tasks: TaskManager,
	wsFolder: vscode.Uri,
	token: string,
	onFavoritesChanged: () => Promise<void>,
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	try {
		if (req.method !== 'POST' || req.url !== '/') {
			respond(res, 404, 'ERROR 未知路径\n');
			return;
		}
		// 客户端断连标记：壳侧超时（edit/submit 给 120s）会销毁连接，此后再建卡就成了
		// 「调用方不知情的付费任务」——它只看到超时、拿不到 submit_id，重试即重复扣费。
		// 挂在最早处，让长耗时 op（读参考图/归档）能在提交前查一次并放弃。
		let clientGone = false;
		res.on('close', () => {
			if (!res.writableFinished) {
				clientGone = true;
			}
		});
		// readBody 单独 await：超限的 BODY_TOO_LARGE 要直达外层 catch 回 413，
		// 不能被下面「JSON 解析失败」的 catch 吞成 400
		const body = await readBody(req);
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			respond(res, 400, 'ERROR 请求体不是合法 JSON\n');
			return;
		}
		const { token: reqToken, op, md, cwd, args } = (parsed ?? {}) as Record<string, unknown>;
		// token 先于一切业务校验：不给无凭据请求任何字段级错误信息
		if (!tokenMatches(token, reqToken)) {
			respond(res, 403, 'ERROR token 校验失败（~/.image-flow/token 与扩展加载值不一致，重载窗口后重试）\n');
			return;
		}
		if (!isNonEmptyString(op) || (!MD_OPS.has(op) && !CWD_OPS.has(op))) {
			respond(
				res,
				400,
				'ERROR 未知操作（仅支持 list / fix / preview / submit / edit / query_result / list_task / list_model / favorite）\n'
			);
			return;
		}
		// 归属校验先于 op 执行：不在本窗口工作区回 421，壳据此换下一个端口找目标窗口，
		// 保证非目标窗口对真实 op 零副作用。md 类 op 的 md 兼作路由与安全边界
		//（fix 回写/submit 提交都锁在本工作区内，不让本机任意进程借请求碰任意文件）；
		// 查询类 op 无 md，改用壳的 cwd 做同样的路由。
		let mdUri: vscode.Uri | undefined;
		if (MD_OPS.has(op)) {
			if (!isNonEmptyString(md)) {
				respond(res, 400, 'ERROR 请求字段缺失或类型非法（该操作的 md 需为非空字符串）\n');
				return;
			}
			if (!isInside(wsFolder.fsPath, md)) {
				respond(res, 421, 'ERROR md 不在当前窗口的工作区内\n');
				return;
			}
			mdUri = vscode.Uri.file(md);
		} else {
			if (!isNonEmptyString(cwd)) {
				respond(res, 400, 'ERROR 请求字段缺失或类型非法（该操作的 cwd 需为非空字符串）\n');
				return;
			}
			if (!sameOrInside(wsFolder.fsPath, cwd)) {
				respond(res, 421, 'ERROR cwd 不在当前窗口的工作区内\n');
				return;
			}
		}
		try {
			let text: string;
			if (op === 'list') {
				text = await runList(context, mdUri!);
			} else if (op === 'fix') {
				text = await runFix(context, mdUri!);
			} else if (op === 'preview') {
				text = await runPreview(context, mdUri!);
			} else if (op === 'submit') {
				text = await runSubmit(context, tasks, mdUri!, args);
			} else if (op === 'edit') {
				text = await runEdit(context, tasks, args, () => clientGone);
			} else if (op === 'query_result') {
				text = await runQueryResult(tasks, args);
			} else if (op === 'list_task') {
				text = await runListTask(tasks, args);
			} else if (op === 'favorite') {
				text = await runFavorite(wsFolder, onFavoritesChanged, args);
			} else {
				text = await runListModel(context);
			}
			respond(res, 200, text);
			log(`CLI ${op} 完成${mdUri ? `：${mdUri.fsPath}` : ''}`);
		} catch (e) {
			const msg = `ERROR ${op}: ${errMsg(e)}`;
			log(msg);
			respond(res, 500, msg + '\n');
		}
	} catch (e) {
		// 读体失败（超限/连接中断）等：尽力回包，连接已断则忽略
		log(`CLI 桥请求处理失败：${errMsg(e)}`);
		try {
			const tooLarge = (e as NodeJS.ErrnoException | null)?.code === BODY_TOO_LARGE;
			respond(res, tooLarge ? 413 : 400, `ERROR ${errMsg(e)}\n`);
			if (tooLarge) {
				// 排空剩余请求体让连接正常收尾，客户端才能读到 413 而非半途断连
				req.resume();
			}
		} catch {
			/* 连接已断，无处回包 */
		}
	}
}

/** 收集结果项：图片 + 是否来自配置素材库（list 据此对大素材库只挑写了描述的，fix 全取） */
type SourcedImg = TaskImage & { fromLibrary: boolean };

/**
 * 某 md 的可用参考图（与工作台所见同源、list/fix 共用此一处，保证不漂移）：
 * md 目录 + 自动库（工作区根→md 目录沿途各级目录的直接图）+ 已配置素材库（递归）。
 * 按 uri 去重——自动库最后一层即 md 目录，会与 md 目录扫描重复。fromLibrary 标记来源，
 * 区分「上下文图（md 目录/自动库）」与「配置素材库」，供两个消费端各自决定取舍。
 */
async function collectMdImages(
	context: vscode.ExtensionContext,
	mdUri: vscode.Uri
): Promise<SourcedImg[]> {
	const mdDir = vscode.Uri.file(path.dirname(mdUri.fsPath));
	const out: SourcedImg[] = [];
	const seenUri = new Set<string>();
	const add = (img: TaskImage, fromLibrary: boolean) => {
		// 去重 key 小写：消解 Windows 盘符大小写差异（md 目录 Uri.file 与自动库 ws.uri 可能不一致），
		// 文件名本就大小写不敏感，避免同一文件因盘符casing 未去重而被 fix 误判「多候选」
		const key = img.uri.toLowerCase();
		if (seenUri.has(key)) {
			return;
		}
		seenUri.add(key);
		out.push({ ...img, fromLibrary });
	};
	for (const img of await scanDirImages(mdDir)) {
		add(img, false);
	}
	for (const lib of await listAutoLibraries(mdUri)) {
		for (const img of lib.images) {
			add(img, false);
		}
	}
	for (const lib of await listLibraries(context)) {
		for (const img of lib.images) {
			add(img, true);
		}
	}
	return out;
}

/**
 * list：列出可用参考图，每条为「描述（若有）+ `![别名或主名](文件名)`」（只给文件名、不给路径）。
 * 描述在前、引用紧随，与右键插入引用同格式，可直接粘进正文。
 * 范围取 collectMdImages（与工作台同源）：md 目录、自动库、配置素材库全列（不筛描述，全量占用的上下文有限）。
 * 按文件名去重。
 */
async function runList(context: vscode.ExtensionContext, mdUri: vscode.Uri): Promise<string> {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const img of await collectMdImages(context, mdUri)) {
		const key = img.name.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		// 描述读一次：既用于取别名（[九胡] → 九胡），也整段前置到引用之前
		const desc = img.hasDesc ? await readImageDesc(img.uri) : '';
		const alt = aliasFromDesc(desc) || path.basename(img.name, path.extname(img.name));
		lines.push(desc + `![${alt}](${img.name})`);
	}
	return lines.join('\n') + '\n';
}

/**
 * preview：解析 md 并构建替换后的最终提示词正文（与侧栏「预览」按钮同一份逻辑，不调用 API、不消耗额度）。
 * 引用解析失败（如图片引用找不到文件）时抛错，交给外层 catch 统一回 `ERROR preview: ...`——
 * AI 据此自行判断参考图是否填对，无需再解析人类可读的 UI 提示。
 */
async function runPreview(context: vscode.ExtensionContext, mdUri: vscode.Uri): Promise<string> {
	const config = await readConfig(context);
	return buildRequestPreviewText(config, mdUri);
}

/** 路径是否存在 */
async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * fix：把正文里「当前路径解析不到」的图片引用，按文件名查到真实位置后改成相对路径。
 * 查找范围取 collectMdImages（与工作台同源）：md 目录 + 自动库（上级各层）+ 配置素材库，全取。
 * 已能解析的引用原样不动；找不到/多个同名候选只记录问题、不改写。仅当有改写时回写 md。返回处理报告。
 */
async function runFix(context: vscode.ExtensionContext, mdUri: vscode.Uri): Promise<string> {
	const content = Buffer.from(await vscode.workspace.fs.readFile(mdUri)).toString('utf8');
	const mdDirPath = path.dirname(mdUri.fsPath);

	// 文件名（小写）→ 真实位置 fsPath 列表。collectMdImages 已按 uri 去重，故同名不同档=真歧义（多候选）
	const index = new Map<string, string[]>();
	for (const img of await collectMdImages(context, mdUri)) {
		const key = img.name.toLowerCase();
		const arr = index.get(key) ?? [];
		arr.push(vscode.Uri.parse(img.uri).fsPath);
		index.set(key, arr);
	}

	// 按去重后的引用路径逐个定夺（含 stat，不能放进同步 replace 回调里）；分类纯逻辑见 cliBridgeLogic.decideRef
	const { order } = parseImageRefs(content);
	const decisions = new Map<string, Decision>();
	for (const p of order) {
		const here = await exists(vscode.Uri.file(path.resolve(mdDirPath, p)));
		const cands = index.get(path.basename(p).toLowerCase()) ?? [];
		decisions.set(p, decideRef(here, cands, mdDirPath));
	}

	// 同步改写：命中 rewrite 的换路径，保留原 alt；其余原样
	const fixed = content.replace(IMAGE_REGEX, (full, ...groups) => {
		const p = refPath([full, groups[0], groups[1]] as unknown as RegExpMatchArray);
		const d = decisions.get(p);
		if (!d || d.action !== 'rewrite') {
			return full;
		}
		const alt = (/^!\[([^\]]*)\]/.exec(full)?.[1] ?? '').trim();
		return `![${alt}](${d.dest})`;
	});

	if (fixed !== content) {
		await vscode.workspace.fs.writeFile(mdUri, Buffer.from(fixed, 'utf8'));
	}
	return buildFixReport(order, decisions);
}

// —— 模型调用类 op（submit / query_result / list_task / list_model）——
// 统一 JSON 输出、成败看 gen_status 不看 HTTP 状态（照抄即梦 dreamina CLI 约定）：
// 参数/校验类失败回 200 + {gen_status:'fail', fail_reason}，非 200 只留给传输/鉴权层错误。

/** 新命令统一的失败形态 */
function failJson(reason: string): string {
	return JSON.stringify({ gen_status: 'fail', fail_reason: reason }) + '\n';
}

/**
 * submit/edit 建卡成功的统一响应：回显本次实际生效的参数，让调用方立刻发现是否误用默认值。
 * 张数取台账值（start 内按模型钳制后的最终值），与远端实际提交一致。
 */
function submittedJson(task: PendingTask, plan: CliSubmitPlan): string {
	return (
		JSON.stringify({
			submit_id: task.folder,
			gen_status: 'querying',
			params: {
				provider: plan.overrides.providerId,
				model: plan.overrides.model,
				ratio: plan.overrides.aspectRatio,
				resolution: plan.overrides.imageSize,
				generate_num: task.meta.requested,
				video: plan.video,
				custom: plan.overrides.params,
			},
		}) + '\n'
	);
}

/**
 * submit：解析按次覆盖参数（--model 换模型时参数域随之切换，等价侧栏切模型）→
 * 复用工作台前置校验（grsai 缺 Key / 视频模型 v.md 防误触）→ 提交并等创建阶段结束
 * （提示词/参考图解析失败能同步回 fail_reason，而非给个查无此任务的 submit_id）→
 * 回显本次实际生效的参数，让调用方立刻发现是否误用默认值。
 */
async function runSubmit(
	context: vscode.ExtensionContext,
	tasks: TaskManager,
	mdUri: vscode.Uri,
	rawArgs: unknown
): Promise<string> {
	try {
		const config = await readConfig(context);
		const plan = resolveSubmitPlan(configOptions(), config, parseSubmitArgs(rawArgs));
		// 与工作台 doGenerate 同一套闸门：密钥检查按目标渠道分流（自定义模型缺 Key 由 resolveImageCall 报错）
		if (plan.overrides.providerId === GRSAI_PROVIDER_ID && !config.apiKey) {
			return failJson('尚未配置 API Key，请在侧栏设置页填写。');
		}
		// 视频昂贵：--model 覆盖成视频模型同样只放行 *v.md 文件名（设置页可关）
		if (plan.video && config.videoOnlyVmd && !uriBaseName(mdUri).toLowerCase().endsWith('v.md')) {
			return failJson(
				'视频模型仅允许文件名以 v.md 结尾的 Markdown 生成（防误触发付费视频任务）。可在设置页关闭此限制。'
			);
		}
		const { task, creation } = await tasks.submit(mdUri, plan.overrides);
		const creationError = await creation;
		if (creationError !== null) {
			return failJson(creationError);
		}
		return submittedJson(task, plan);
	} catch (e) {
		return failJson(errMsg(e));
	}
}

/**
 * 读盘前对全部参考图做一遍轻量预检（只 stat、不读内容）：绝对路径、必须是图片扩展名、
 * 必须是存在的普通文件、张数与单张/合计字节都在上限内（CLI_EDIT_LIMITS 严格档）。
 * 独立一遍先扫完再读，是为了「传了 10 张、第 10 张超限」时一张都不白读。
 * 返回错误文案，null 表示通过。
 */
async function precheckEditImages(images: string[]): Promise<string | null> {
	// 张数超标先拒，一个路径都不碰：慢盘/网络盘上「传了几百张」不该先耗几百次 stat 才报错
	const overCount = checkMediaCount(images.length, CLI_EDIT_LIMITS);
	if (overCount) {
		return overCount;
	}
	const sizes: MediaSize[] = [];
	for (const p of images) {
		if (!path.isAbsolute(p)) {
			return `参考图路径须为绝对路径：${p}`;
		}
		// 音视频在这里先拦：EditSession 收得下（编辑区支持音视频），但编辑链路只能生成图片，
		// 放过去只会拿到一句提「编辑区」的错（CLI 调用方没有编辑区，看不懂）
		if (mediaTypeOfFileName(path.basename(p)) !== 'image') {
			return `编辑模式只支持图片参考图，不支持音视频：${p}`;
		}
		let stat: vscode.FileStat;
		try {
			stat = await vscode.workspace.fs.stat(vscode.Uri.file(p));
		} catch {
			return `参考图不存在：${p}`;
		}
		if (stat.type !== vscode.FileType.File) {
			return `参考图不是普通文件：${p}`;
		}
		sizes.push({ name: p, size: stat.size });
		// 每 stat 一张就判一次：超限当场返回，不让后面某张「不存在」的错误盖过真正的大小问题
		const overSize = checkMediaBytes(sizes, CLI_EDIT_LIMITS);
		if (overSize) {
			return overSize;
		}
	}
	return null;
}

/** 调用方已断开时的统一返回：明确「没建任务」，让重试不必担心重复扣费 */
function abandoned(): string {
	log('CLI edit 放弃提交：调用方已断开连接（壳超时或被中断），未创建任务');
	return failJson('调用方已断开连接（壳超时或被中断），已放弃提交，未创建任务');
}

/**
 * edit：编辑模式（图生图，不经 md）——一段提示词 + 若干张参考图路径，等价「编辑页拖图进编辑区点生成」。
 * 一次调用 = 一个任务：多张 --image 是同一次编辑的多张参考图（顺序即 【@图片N】 编号）；
 * 「同一提示词批量套到 N 张图」由调用方循环调 N 次，语义不在这里合并。
 * 参数基线取编辑页配置（editSubmitConfig），--model 等按次覆盖等价「编辑页切模型点生成」。
 * 参考图路径按产品决策不限工作区（编辑页本就能上传任意目录的图），但要求绝对路径——
 * 相对路径由壳按 cwd 解析，到这里仍是相对说明调用方绕过了壳，直接拒掉而非按扩展进程 cwd 瞎猜。
 */
async function runEdit(
	context: vscode.ExtensionContext,
	tasks: TaskManager,
	rawArgs: unknown,
	clientGone: () => boolean
): Promise<string> {
	try {
		const config = await readConfig(context);
		const args = parseEditArgs(rawArgs);
		const plan = resolveSubmitPlan(configOptions(), editSubmitConfig(config), args, '编辑页');
		if (plan.overrides.providerId === GRSAI_PROVIDER_ID && !config.apiKey) {
			return failJson('尚未配置 API Key，请在侧栏设置页填写。');
		}
		// 编辑模式不支持视频模型（与编辑页一致：模型列表已滤掉视频模型）
		if (plan.video) {
			return failJson(`模型「${plan.overrides.model}」是视频模型，编辑模式不支持视频生成。`);
		}
		const precheckError = await precheckEditImages(args.images);
		if (precheckError) {
			return failJson(precheckError);
		}
		// 复用 EditSession 装载参考图：格式校验、重名/同主名冲突（命名引用会歧义）、data URI 转换与编辑页同一份
		const session = new EditSession();
		for (const p of args.images) {
			const err = await session.addUri(vscode.Uri.file(p).toString());
			if (err) {
				return failJson(`${err}（${p}）`);
			}
			// 读图可能很慢（网络盘/大图）：每张之后查一次断连，不给已放弃的调用方继续读下去
			if (clientGone()) {
				return abandoned();
			}
		}
		// 建卡前最后一道：此刻断开就绝不提交——付费任务必须有人接得住 submit_id
		if (clientGone()) {
			return abandoned();
		}
		const { task, creation } = await tasks.submitEdit(args.prompt, session.list(), plan.overrides);
		const creationError = await creation;
		if (creationError !== null) {
			return failJson(creationError);
		}
		return submittedJson(task, plan);
	} catch (e) {
		return failJson(errMsg(e));
	}
}

/** 任务夹顶层的媒体产物（绝对路径 + image/video/audio 类型）；任务夹不存在返回 null */
async function listTaskOutputs(dir: vscode.Uri): Promise<{ path: string; media: MediaType }[] | null> {
	let files: [string, vscode.FileType][];
	try {
		files = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return null;
	}
	return files
		.filter(([name, type]) => type === vscode.FileType.File && isMediaFileName(name))
		.map(([name]) => name)
		.sort()
		.map((name) => ({ path: vscode.Uri.joinPath(dir, name).fsPath, media: mediaTypeOfFileName(name) }));
}

/**
 * query_result：进行中（内存实时态）→ querying + 进度/已出产物；已终结 → 磁盘兜底
 * （meta.json + 盘上产物数判 success/fail，产物给绝对路径 + 媒体类型，部分失败按 fail 报但产物照给）。
 * 不做 --download_dir：产物本就自动落盘任务夹。
 */
async function runQueryResult(tasks: TaskManager, rawArgs: unknown): Promise<string> {
	const obj = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
	const id = normalizeSubmitId(obj.submit_id);
	if (!id) {
		return failJson('submit_id 缺失或格式非法（应为 "yyMMdd/HHmmssSSS"）');
	}
	const memTask = tasks.list().find((t) => t.folder === id);
	// 仍活跃才走内存报 querying；已终结但尚未移出列表的走磁盘兜底拿终态
	if (memTask && isTaskActive(memTask)) {
		const errors = [...new Set(memTask.jobs.map((j) => j.error).filter((e): e is string => !!e))];
		const credit = memTask.jobs.reduce((sum, j) => sum + (j.creditCount ?? 0), 0);
		return (
			JSON.stringify({
				submit_id: id,
				gen_status: 'querying',
				progress: aggregateProgress(memTask.jobs),
				requested: Math.max(memTask.jobs.length, memTask.meta.requested),
				done: memTask.images.length,
				failed: memTask.jobs.filter((j) => j.status === 'failed' || j.status === 'violation').length,
				...(credit > 0 ? { credit } : {}),
				...(errors.length ? { errors } : {}),
				outputs: memTask.images.map((img) => ({
					path: vscode.Uri.parse(img.uri).fsPath,
					media: img.media ?? 'image',
				})),
			}) + '\n'
		);
	}
	const dir = vscode.Uri.joinPath(tasksRoot(), id);
	const outputs = await listTaskOutputs(dir);
	if (outputs === null) {
		return failJson(`任务「${id}」不存在`);
	}
	const meta = await readTaskMeta(dir);
	const title = memTask?.title ?? meta?.title;
	// meta.credit 由 pollOnce 终结时写入（await metaWrites 保证先于侧栏刷新）；CLI 查询与它并发时
	// 可能极窄地读到尚无 credit 的 meta（最终一致）——任务已终结、产出正确，仅积分瞬时缺省，可接受
	return (
		JSON.stringify({
			submit_id: id,
			...taskGenStatus(meta?.requested ?? 0, outputs.length),
			requested: meta?.requested ?? 0,
			succeeded: outputs.length,
			...(meta?.credit ? { credit: meta.credit } : {}),
			...(title ? { title } : {}),
			outputs,
		}) + '\n'
	);
}

/** list_task：进行中（内存实时态）在前 + 已终结历史（扫盘 meta.json）在后，各自倒序，合并取 limit 条 */
async function runListTask(tasks: TaskManager, rawArgs: unknown): Promise<string> {
	const obj = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
	let limit = 20;
	if (obj.limit !== undefined) {
		if (typeof obj.limit !== 'number' || !Number.isInteger(obj.limit) || obj.limit < 1) {
			return failJson('limit 须为正整数');
		}
		limit = Math.min(obj.limit, 100);
	}
	const active = tasks.list().map((t) => {
		const credit = t.jobs.reduce((sum, j) => sum + (j.creditCount ?? 0), 0);
		return {
			submit_id: t.folder,
			gen_status: 'querying',
			progress: aggregateProgress(t.jobs),
			model: t.model,
			ratio: t.meta.aspectRatio,
			resolution: t.meta.imageSize,
			requested: Math.max(t.jobs.length, t.meta.requested),
			succeeded: t.images.length,
			...(credit > 0 ? { credit } : {}),
			...(t.title ? { title: t.title } : {}),
			source: t.meta.source,
		};
	});
	const history = (await listHistory(tasks.activeFolders())).map((t) => {
		const title = t.meta?.title ?? t.promptName;
		return {
			submit_id: t.folder,
			...taskGenStatus(t.meta?.requested ?? 0, t.images.length),
			model: t.meta?.model,
			ratio: t.meta?.aspectRatio,
			resolution: t.meta?.imageSize,
			requested: t.meta?.requested ?? 0,
			succeeded: t.images.length,
			...(t.meta?.credit ? { credit: t.meta.credit } : {}),
			...(title ? { title } : {}),
			source: t.meta?.source,
		};
	});
	return JSON.stringify({ gen_status: 'success', tasks: [...active, ...history].slice(0, limit) }) + '\n';
}

/**
 * favorite：把一件产物（绝对路径）收进当前收藏夹，可带备注——CLI 核对成图后直接把「筛过的成品」
 * 送进侧栏收藏页，调用方无需在编辑器里逐张点开。只加不减（addFavorite），重复调用幂等。
 * path 限当前窗口工作区内：favorites.json 属于本工作区，且 CLI 场景的产物本就在 .image-flow/tasks/ 下；
 * 这也避免「本机任意进程可往收藏塞任意外部路径」。成功后触发侧栏重推，新收藏即时可见。
 */
async function runFavorite(
	wsFolder: vscode.Uri,
	onFavoritesChanged: () => Promise<void>,
	rawArgs: unknown
): Promise<string> {
	try {
		const obj = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
		if (!isNonEmptyString(obj.path)) {
			return failJson('path 缺失或须为非空字符串（产物的绝对路径，取自 query_result 的 outputs）');
		}
		if (obj.note !== undefined && typeof obj.note !== 'string') {
			return failJson('note 须为字符串');
		}
		const fsPath = path.resolve(obj.path);
		if (!isInside(wsFolder.fsPath, fsPath)) {
			return failJson(`path 不在当前窗口的工作区内：${fsPath}`);
		}
		if (!isMediaFileName(path.basename(fsPath))) {
			return failJson('仅支持收藏图片/视频/音频文件');
		}
		const uri = vscode.Uri.file(fsPath);
		// 必须真实存在且是普通文件：收藏悬空路径会被收藏页的悬空过滤隐藏，CLI 报成功而侧栏看不到，
		// 徒增困惑；目录也能顶着 .png 名字通过 stat，一并拦掉
		let statType: vscode.FileType;
		try {
			statType = (await vscode.workspace.fs.stat(uri)).type;
		} catch {
			return failJson(`文件不存在：${fsPath}`);
		}
		if (statType !== vscode.FileType.File) {
			return failJson(`不是普通文件：${fsPath}`);
		}
		// 空白备注视同未提供：CLI 场景没有「清空备注」需求，避免误传空串抹掉已有备注
		const note = obj.note?.trim() || undefined;
		let outcome = { collectionId: '', already: false };
		const data = await mutateFavorites((d) => {
			const r = addFavorite(d, uri.toString(), note, Date.now());
			outcome = { collectionId: r.collectionId, already: r.already };
			return r.data;
		});
		// 落库已成功，侧栏重推失败只记日志，不把成功谎报成失败
		try {
			await onFavoritesChanged();
		} catch (e) {
			log(`CLI favorite 侧栏重推失败：${errMsg(e)}`);
		}
		const collection = data.collections.find((c) => c.id === outcome.collectionId)?.name;
		return (
			JSON.stringify({
				gen_status: 'success',
				path: fsPath,
				collection,
				already_favorited: outcome.already,
				...(note ? { note } : {}),
			}) + '\n'
		);
	} catch (e) {
		return failJson(errMsg(e));
	}
}

/**
 * list_model：全渠道模型档位直出（configOptions 类型上就不含 baseUrl/apiKey），
 * 附 current 回显工作台当前选择——调用方不传覆盖时能预判将用什么参数。
 * 视频模型 video:true 且 imageSizes 实为 video_resolution 档；custom 为可调自定义参数（如视频 duration）。
 */
async function runListModel(context: vscode.ExtensionContext): Promise<string> {
	const config = await readConfig(context);
	return (
		JSON.stringify(
			{
				gen_status: 'success',
				current: {
					provider: config.providerId,
					model: config.model,
					ratio: config.aspectRatio,
					resolution: config.imageSize,
					generate_num: config.concurrency,
				},
				models: configOptions().imageModels,
			},
			null,
			2
		) + '\n'
	);
}
