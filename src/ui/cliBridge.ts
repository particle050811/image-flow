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
import type { TaskImage } from '../shared';
import { tokenFile } from '../storage/storage';
import { parseImageRefs, IMAGE_REGEX, refPath } from '../prompt/buildPrompt';
import { type Decision, decideRef, buildFixReport } from './cliBridgeLogic';
import { buildRequestPreviewText } from '../task/preview';
import { readConfig } from './config';
import { log } from '../util/log';
import { errMsg } from '../util/errors';

/**
 * 「给 AI 自动调用」的命令入口：因库列表存在扩展主进程的 workspaceState、独立进程读不到，
 * 改由 scripts/imgflow.mjs 这层 CLI 壳桥接——扩展激活时在 127.0.0.1 的固定候选端口段
 * （47870~47879）依次试绑 HTTP 服务，壳按同一顺序扫描端口直连 POST {token, op, md}，
 * 这里在扩展主进程内跑逻辑（有 vscode API + workspaceState），响应体即结果。
 * md 不在本窗口工作区时回 421，壳据此换下一个端口找目标窗口——端口发现零落盘，
 * 工作区内不再写任何文件（曾用工作区根 bridge.json 传端口，导致光打开文件夹就拉出 .image-flow）。
 *
 * 选回环 HTTP 而非 vscode:// URI：URI 由外部进程触发会弹「是否允许扩展打开此 URI」安全确认，
 * 与「零点击自动调用」冲突。相比早期的「文件请求 + 轮询」桥，直连是真同步请求/响应：
 * VS Code 没开时连接立刻被拒（壳侧秒级报错而非干等超时），也没有 watcher 漏事件、残留请求文件的问题。
 * 服务只绑 127.0.0.1，请求须带 token（用户级稳定值，存 ~/.image-flow/token、跨激活复用，
 * 不进任何仓库；本机单用户场景不做挑战-响应等更重的防护）。
 */

/** 候选端口段（与 scripts/imgflow.mjs 约定一致）：依次试绑，绑上哪个用哪个 */
const PORT_START = 47870;
const PORT_COUNT = 10;
/** 响应标识头：壳凭此区分「本扩展的服务」与「端口被复用后的陌生进程」 */
const MARKER_HEADER = 'x-image-flow';
/** 请求体上限：请求只含 token/op/md 三个短字段，64KB 给足余量 */
const MAX_BODY = 64 * 1024;

export function registerCliBridge(context: vscode.ExtensionContext): vscode.Disposable {
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
			void handleRequest(context, folder.uri, token, req, res);
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

/** 处理一个请求：读体 → 验 token → 校验字段 → 跑 op → 响应体即结果 */
async function handleRequest(
	context: vscode.ExtensionContext,
	wsFolder: vscode.Uri,
	token: string,
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	try {
		if (req.method !== 'POST' || req.url !== '/') {
			respond(res, 404, 'ERROR 未知路径\n');
			return;
		}
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
		const { token: reqToken, op, md } = (parsed ?? {}) as Record<string, unknown>;
		// token 先于一切业务校验：不给无凭据请求任何字段级错误信息
		if (!tokenMatches(token, reqToken)) {
			respond(res, 403, 'ERROR token 校验失败（~/.image-flow/token 与扩展加载值不一致，重载窗口后重试）\n');
			return;
		}
		if (!isNonEmptyString(op) || !isNonEmptyString(md)) {
			respond(res, 400, 'ERROR 请求字段缺失或类型非法（op/md 需为非空字符串）\n');
			return;
		}
		// 归属校验先于 op 执行：md 不在本窗口工作区回 421，壳据此换下一个端口找目标窗口；
		// 也把 fix 的回写能力锁在本工作区内（不让本机任意进程借请求改写任意文件），
		// 且保证非目标窗口对真实 op 零副作用
		if (!isInside(wsFolder.fsPath, md)) {
			respond(res, 421, 'ERROR md 不在当前窗口的工作区内\n');
			return;
		}
		try {
			const mdUri = vscode.Uri.file(md);
			let text: string;
			if (op === 'list') {
				text = await runList(context, mdUri);
			} else if (op === 'fix') {
				text = await runFix(context, mdUri);
			} else if (op === 'preview') {
				text = await runPreview(context, mdUri);
			} else {
				throw new Error(`未知操作：${op}（仅支持 list / fix / preview）`);
			}
			respond(res, 200, text);
			log(`CLI ${op} 完成：${md}`);
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
