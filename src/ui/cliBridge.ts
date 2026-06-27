import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import {
	listLibraries,
	listAutoLibraries,
	readImageDesc,
	aliasFromDesc,
	scanDirImages,
} from '../storage/materials';
import type { TaskImage } from '../shared';
import { parseImageRefs, IMAGE_REGEX, refPath } from '../prompt/buildPrompt';
import { type Decision, decideRef, buildFixReport } from './cliBridgeLogic';
import { log } from '../util/log';
import { errMsg } from '../util/errors';

/**
 * 「给 AI 自动调用」的命令入口：因库列表存在扩展主进程的 workspaceState、独立进程读不到，
 * 改由 scripts/imgflow.mjs 这层 CLI 壳走「文件请求」桥接——壳往工作区根
 * `.image-flow/requests/` 写一个请求 json（{op, md, out}），这里用 FileSystemWatcher 收到后
 * 在扩展主进程内跑逻辑（有 vscode API + workspaceState），结果原子写进 out 文件供壳轮询读回。
 *
 * 选文件监听而非 vscode:// URI：URI 由外部进程触发会弹「是否允许扩展打开此 URI」安全确认，
 * 与「零点击自动调用」冲突；写文件不触发任何确认，也省去 shell/编码转义。请求目录在工作区内，
 * 故监听可靠、且天然按工作区隔离（只有打开该工作区的窗口会处理自己根下的请求）。
 */

/** 请求目录（相对工作区根），与 scripts/imgflow.mjs 约定一致 */
const REQUESTS_GLOB = '.image-flow/requests/req-*.json';

interface CliRequest {
	op: string;
	md: string;
	out: string;
}

export function registerCliBridge(context: vscode.ExtensionContext): vscode.Disposable {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		// 无工作区：没有库可查也无处放请求，返回空 Disposable
		return new vscode.Disposable(() => undefined);
	}
	// 激活即建好请求目录：壳靠「向上找 .image-flow」定位工作区根，预先建好让全新项目
	// （还没跑过任务/收藏、.image-flow 尚不存在）也能直接用。createDirectory 递归且幂等。
	void vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.image-flow', 'requests'));
	// 仅监听新建：壳「写 .tmp 再 rename 成 req-*.json」，故 create 即完整文件
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(folder, REQUESTS_GLOB),
		false, // 不忽略 create
		true, // 忽略 change
		true // 忽略 delete
	);
	watcher.onDidCreate((uri) => handleRequest(context, folder.uri, uri));
	return watcher;
}

/** 非空字符串守卫：请求字段来自外部进程，逐项校验类型而非裸信任 */
function isNonEmptyString(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

/**
 * child 是否落在 parent 目录内（含子目录）。用于把外部请求的 out/md 路径锁在白名单目录里，
 * 不让「投递请求文件」变成往任意路径写盘的原语。Windows 文件系统大小写不敏感，统一小写比较。
 */
function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
	return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 处理一个请求文件：原子认领 → 校验 → 跑 op → 写 out → 删认领文件 */
async function handleRequest(
	context: vscode.ExtensionContext,
	wsFolder: vscode.Uri,
	reqUri: vscode.Uri
): Promise<void> {
	// 认领：把 req-*.json 原子 rename 成 .lock（不匹配 watcher 的 req-*.json，不会再触发 create）。
	// 同工作区双开时两个窗口都会收到 create，rename 失败（源已被另一窗口认领、不存在）者直接退出，
	// 避免双跑：尤其 fix 会被重复回写、且后写的「修正 0」报告覆盖真实报告误导调用方。
	const lockUri = reqUri.with({ path: reqUri.path + '.lock' });
	try {
		await vscode.workspace.fs.rename(reqUri, lockUri, { overwrite: false });
	} catch {
		return;
	}
	let req: CliRequest;
	try {
		req = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(lockUri)).toString('utf8'));
	} catch {
		// 内容损坏：删掉认领文件避免残留，壳侧会超时报错
		await deleteQuietly(lockUri);
		return;
	}
	const { op, md, out } = req;
	// 字段类型校验 + out 路径白名单：在向 out 写任何东西（含错误回写）之前完成。
	// out 限定在系统临时目录内（壳就写在 os.tmpdir()），不让外部请求把扩展变成「投递文件即往任意路径写盘」。
	// out 非法时只能记日志、不回写（无可信落点），壳侧超时报错。
	if (!isNonEmptyString(op) || !isNonEmptyString(md) || !isNonEmptyString(out)) {
		log('CLI 请求字段缺失或类型非法（op/md/out 需为非空字符串），已忽略');
		await deleteQuietly(lockUri);
		return;
	}
	if (!isInside(os.tmpdir(), out)) {
		log(`CLI 请求被拒：out 不在系统临时目录内（${out}）`);
		await deleteQuietly(lockUri);
		return;
	}
	try {
		// md 限定在当前工作区内：fix 会回写 md，不允许改写工作区外的任意文件
		if (!isInside(wsFolder.fsPath, md)) {
			throw new Error('md 不在当前工作区内，已拒绝处理');
		}
		const mdUri = vscode.Uri.file(md);
		let text: string;
		if (op === 'list') {
			text = await runList(context, mdUri);
		} else if (op === 'fix') {
			text = await runFix(context, mdUri);
		} else {
			throw new Error(`未知操作：${op}（仅支持 list / fix）`);
		}
		await writeOut(out, text);
		log(`CLI ${op} 完成：${md} → ${out}`);
	} catch (e) {
		const msg = `ERROR ${op}: ${errMsg(e)}`;
		log(msg);
		// out 已校验在白名单内，把错误写回去让轮询的壳拿到非零结果而非干等超时
		try {
			await writeOut(out, msg + '\n');
		} catch {
			/* out 写不了只能放弃，壳侧会超时 */
		}
	} finally {
		// 处理完删认领文件
		await deleteQuietly(lockUri);
	}
}

/** 删文件、吞掉「不存在」之类的错误（认领文件清理用） */
async function deleteQuietly(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.delete(uri);
	} catch {
		/* 已被删/不存在，忽略 */
	}
}

/** 原子写出：先写 .tmp 再 rename，避免壳轮询时读到半截内容 */
async function writeOut(outPath: string, text: string): Promise<void> {
	const out = vscode.Uri.file(outPath);
	const tmp = vscode.Uri.file(outPath + '.tmp');
	await vscode.workspace.fs.writeFile(tmp, Buffer.from(text, 'utf8'));
	await vscode.workspace.fs.rename(tmp, out, { overwrite: true });
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
 * 范围取 collectMdImages（与工作台同源）：md 目录与自动库全列；配置素材库可能很大、递归扫，
 * 故只列写了描述的（fromLibrary 且无描述则跳过）。按文件名去重。
 */
async function runList(context: vscode.ExtensionContext, mdUri: vscode.Uri): Promise<string> {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const img of await collectMdImages(context, mdUri)) {
		// 大素材库只列写了描述的；md 目录与自动库（上级各层）全列
		if (img.fromLibrary && !img.hasDesc) {
			continue;
		}
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
