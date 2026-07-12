// 即梦官方 dreamina CLI 调用协议（async）：子进程提交拿 submit_id → query_result 轮询 →
// 成功后带 --download_dir 下载到临时目录，返回 file 型结果由 saveResults 移入任务文件夹。
// 鉴权在 CLI 侧（~/.dreamina_cli/ 登录态），本 adapter 不接触任何 baseUrl/apiKey。

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TransientError } from '../api';
import { isMediaFileName } from '../../util/images';
import { parseDreaminaOutput, buildSubmitArgs } from './jimengCliLogic';
import { isJimengVideoModel } from '../providers';
import type { ImageAdapter, CallContext, AdapterJobResult, ResultItem, SubmitAsync } from './types';

/** CLI 未安装时的错误文案开头，引导层（jimengGuide）按此识别弹安装引导 */
export const CLI_MISSING_MESSAGE = '未检测到即梦 CLI（dreamina）';
/** 未登录时的错误文案开头，引导层按此识别弹登录引导 */
export const NOT_LOGGED_IN_MESSAGE = '即梦 CLI 未登录';

/** 生图提交超时（ms）：上传参考图 + 提交 */
const SUBMIT_TIMEOUT_IMAGE = 120_000;
/** 视频提交超时（ms）：全能参考可能上传视频/音频大文件，窗口放宽 */
const SUBMIT_TIMEOUT_VIDEO = 300_000;
/** 轮询查询超时（ms）：不带下载，纯状态查询 */
const QUERY_TIMEOUT = 30_000;
/** 成功后下载成品超时（ms）：4k 图 / 视频体量大 */
const DOWNLOAD_TIMEOUT = 600_000;
/** stdout 缓冲上限：结果 JSON 含 url 列表，给足余量 */
const MAX_BUFFER = 20 * 1024 * 1024;

/** 子进程一次执行的输出 */
interface ExecOutput {
	stdout: string;
	stderr: string;
}

/** 跑一次 dreamina 命令；进程不存在抛 ENOENT 原样上抛（由 findDreamina/调用方识别）。
 *  strict=true 时任何执行错误（含非零退出）都 reject——用于下载等「部分完成不可接受」的命令；
 *  默认宽松：非零退出但 stdout 完整（如 gen_status=fail 的提交回执）交给解析层判断。 */
function run(bin: string, args: string[], timeout: number, strict = false): Promise<ExecOutput> {
	return new Promise((resolve, reject) => {
		execFile(bin, args, { timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				// 超时被 kill / 信号终止 / stdout 超限截断：即使已有部分 stdout 也不可信，
				// 半截 JSON 或半截下载绝不能当正常完成（否则批量任务会静默缺成品）
				const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
				const truncated = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
				if (strict || !stdout || e.killed || e.signal || truncated) {
					reject(err);
					return;
				}
			}
			resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
		});
	});
}

/** 缓存的 CLI 可执行路径；探测一次后复用（安装/卸载需重载窗口） */
let cachedBin: string | undefined;

/**
 * 探测 dreamina 可执行文件：先走 PATH，再查默认安装位置 ~/bin/dreamina(.exe)
 * （官方安装脚本写入用户 PATH，但 VS Code 未重启时进程环境里可能还没有）。
 * 找不到抛 CLI_MISSING_MESSAGE 开头的错误。
 */
export async function findDreamina(): Promise<string> {
	if (cachedBin) {
		return cachedBin;
	}
	const home = os.homedir();
	const candidates = [
		'dreamina',
		path.join(home, 'bin', process.platform === 'win32' ? 'dreamina.exe' : 'dreamina'),
	];
	for (const bin of candidates) {
		try {
			await run(bin, ['version'], 15_000);
			cachedBin = bin;
			return bin;
		} catch {
			/* 试下一个候选 */
		}
	}
	throw new Error(`${CLI_MISSING_MESSAGE}，请先安装（curl -fsSL https://jimeng.jianying.com/cli | bash）`);
}

/** 登录态三态：ok = 确认已登录；no = 确认未登录；unknown = 查询失败（超时/网络）无法确认 */
export type JimengLoginState = 'ok' | 'no' | 'unknown';

/** 跑 user_credit 探登录态（三态）。CLI 缺失原样上抛（由调用方走安装引导） */
export async function queryJimengLogin(): Promise<JimengLoginState> {
	const bin = await findDreamina();
	try {
		const out = await run(bin, ['user_credit'], 30_000);
		const parsed = parseDreaminaOutput(out.stdout, out.stderr);
		// unparsed（空输出/非 JSON）不能当已登录：归 unknown，由调用方按场景决定宽严
		return parsed.kind === 'not-logged-in' ? 'no' : parsed.kind === 'ok' ? 'ok' : 'unknown';
	} catch (err) {
		if (err instanceof Error && NOT_LOGGED_IN_MESSAGE_RE.test(err.message)) {
			return 'no';
		}
		// 网络抖动等未知失败：无法确认，交给调用方按场景决定宽严
		return 'unknown';
	}
}

/** 提交前置检查用的宽松布尔：只有「确认未登录」才拦，未知失败放行让提交自身的错误路径兜底 */
export async function checkJimengLogin(): Promise<boolean> {
	return (await queryJimengLogin()) !== 'no';
}

const NOT_LOGGED_IN_MESSAGE_RE = /未检测到有效登录态|请先登录|not logged in/i;

/** 把解析层的三态输出规约成「必须拿到 ok」，否则抛对应错误 */
function requireOk(out: ReturnType<typeof parseDreaminaOutput>, what: string): Extract<ReturnType<typeof parseDreaminaOutput>, { kind: 'ok' }> {
	if (out.kind === 'not-logged-in') {
		throw new Error(`${NOT_LOGGED_IN_MESSAGE}，请在终端运行 dreamina login 完成登录`);
	}
	if (out.kind === 'unparsed') {
		throw new Error(`${what}输出无法解析：${out.raw.slice(0, 500)}`);
	}
	return out;
}

/** 递归收集目录下的媒体文件绝对路径（按路径排序保证落盘顺序稳定） */
async function collectMediaFiles(dir: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(d: string): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				await walk(full);
			} else if (e.isFile() && isMediaFileName(e.name)) {
				found.push(full);
			}
		}
	}
	await walk(dir);
	return found.sort();
}

/** 即梦 CLI adapter：生图（text2image/image2image，批量 generate_num）+ 全能参考视频（multimodal2video） */
export const jimengCli: ImageAdapter = {
	id: 'jimeng-cli',
	kind: 'async',
	// 生图单次提交映射 generate_num 出多张（视频在 TaskManager 侧拆成多 job，不走批量）
	supportsBatch: true,

	async submit(ctx: CallContext, prompt: string, _refs: string[], count: number): Promise<SubmitAsync> {
		const refPaths = ctx.refPaths;
		if (refPaths === undefined) {
			throw new Error('即梦调用缺少参考素材文件路径（refPaths），这是内部接线错误');
		}
		const bin = await findDreamina();
		const args = buildSubmitArgs(ctx.config, prompt, refPaths, count);
		const timeout = isJimengVideoModel(ctx.config.model) ? SUBMIT_TIMEOUT_VIDEO : SUBMIT_TIMEOUT_IMAGE;
		const out = await run(bin, args, timeout);
		const parsed = requireOk(parseDreaminaOutput(out.stdout, out.stderr), '即梦提交');
		if (parsed.genStatus === 'fail') {
			throw new Error(withComplianceHint(parsed.failReason || '即梦提交失败（gen_status=fail）'));
		}
		if (!parsed.submitId) {
			throw new Error(`即梦提交未返回 submit_id：${out.stdout.slice(0, 500)}`);
		}
		return { jobId: parsed.submitId };
	},

	async poll(ctx: CallContext, jobId: string): Promise<AdapterJobResult> {
		// jobId 会拼进临时目录路径并递归删除：先校验为 UUID 形状，
		// 防持久化记录被篡改/损坏时 '..' 之类的值把 rm 目标逃逸到临时目录之外
		if (!/^[A-Za-z0-9-]{8,64}$/.test(jobId)) {
			return { status: 'failed', results: [], error: `即梦任务 id 非法：${jobId.slice(0, 80)}` };
		}
		const bin = await findDreamina();
		let out: ExecOutput;
		try {
			out = await run(bin, ['query_result', `--submit_id=${jobId}`], QUERY_TIMEOUT);
		} catch (err) {
			// 查询失败（超时/网络）视作瞬时错误：任务有 30 分钟兜底超时，不会无限重试
			throw new TransientError(`即梦查询失败：${err instanceof Error ? err.message : String(err)}`);
		}
		const parsed = parseDreaminaOutput(out.stdout, out.stderr);
		if (parsed.kind === 'not-logged-in') {
			return { status: 'failed', results: [], error: `${NOT_LOGGED_IN_MESSAGE}，请在终端运行 dreamina login 后重试` };
		}
		if (parsed.kind === 'unparsed') {
			// 输出异常按瞬时处理，下轮重试（CLI 偶发日志混杂）
			throw new TransientError(`即梦查询输出无法解析：${parsed.raw.slice(0, 300)}`);
		}
		if (parsed.genStatus === 'fail') {
			return {
				status: 'failed',
				results: [],
				error: withComplianceHint(parsed.failReason || '即梦生成失败（gen_status=fail）'),
			};
		}
		if (parsed.genStatus !== 'success') {
			return { status: 'running', results: [] };
		}
		// success：带 --download_dir 再查一次让 CLI 下载成品，扫目录拿本地文件。
		// 下载根优先用任务夹 download/ 子目录（与最终落盘同盘、saveResults rename 原子、
		// 残片随任务夹生命周期回收且不进顶层产物扫描），无 taskDir（如脱离 TaskManager 的直调）回落系统临时目录。
		// 目录固定为 per-job 路径且每轮清空重下：重试不攒残片，半截大文件也会被下轮覆盖清掉。
		// 远端已成功（已扣费），下载阶段任何失败一律按瞬时错误抛出让下轮重试，绝不把已生成的结果永久判死。
		const downloadDir = ctx.taskDir
			? path.join(ctx.taskDir, 'download', jobId)
			: path.join(os.tmpdir(), 'image-flow-jimeng', jobId);
		let downloadOut: ExecOutput;
		try {
			// 清空重下也在瞬时错误范围内：Windows 下 EBUSY/EPERM（占用/杀软锁定）同样该下轮重试，
			// 绝不能让已扣费的远端成功结果因本地目录抖动被永久判死
			await fs.rm(downloadDir, { recursive: true, force: true });
			await fs.mkdir(downloadDir, { recursive: true });
			// strict：下载命令任何非零退出都视为失败——部分文件已落地 + stdout 恰好完整时，
			// 宽松模式会把半批下载误判全齐
			downloadOut = await run(
				bin,
				['query_result', `--submit_id=${jobId}`, `--download_dir=${downloadDir}`],
				DOWNLOAD_TIMEOUT,
				true
			);
		} catch (err) {
			await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
			throw new TransientError(`即梦成品下载失败（下轮重试）：${err instanceof Error ? err.message : String(err)}`);
		}
		// 复验下载输出仍为 success：run() 会放行「非零退出但 stdout 完整」的情况，
		// 若 CLI 下载中途出错（部分文件已落地），不能因目录非空就当批量全齐
		const downloadParsed = parseDreaminaOutput(downloadOut.stdout, downloadOut.stderr);
		if (downloadParsed.kind !== 'ok' || downloadParsed.genStatus !== 'success') {
			await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
			throw new TransientError('即梦成品下载输出异常，可能未下载完整（下轮重试）');
		}
		const files = await collectMediaFiles(downloadDir);
		if (!files.length) {
			// 下载命令“成功”但目录为空同样按瞬时处理：可能是 CLI 输出异常，重试无害（任务有 30 分钟兜底）
			await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
			throw new TransientError('即梦任务已成功但本轮未下载到成品文件（下轮重试）');
		}
		const results: ResultItem[] = files.map((p) => ({ kind: 'file', path: p }));
		return { status: 'succeeded', results };
	},
};

/** 合规确认错误补充网页授权指引（首次使用高风险模型需去即梦网页端一次性授权） */
function withComplianceHint(message: string): string {
	return /AigcComplianceConfirmationRequired/i.test(message)
		? `${message}（首次使用该模型需在即梦网页端 https://jimeng.jianying.com 完成一次授权确认后重试）`
		: message;
}
