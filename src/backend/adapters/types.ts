// 调用协议（Adapter）抽象：每个 adapter 封装一种后端 HTTP 协议（怎么拼请求体、同步/异步、
// 结果取 url 还是 base64）。模型用 adapter id 引用，加新协议 = 加一个 adapter。
// 纯类型 + 接口定义，具体实现见同目录各 adapter 文件。

import type { ImageFlowConfig } from '../../shared';

/**
 * 单个产出结果项：待下载的图片 url、已内联的 base64（含 mime），
 * 或 CLI 型 adapter 已下载到本地临时目录的文件绝对路径（file）。
 * 落盘统一处理：url 下载、base64 解码写文件、file 移动进任务文件夹并按统一规则重命名
 * （见 task/history.ts 的 saveResults）。
 */
export type ResultItem =
	| { kind: 'url'; url: string }
	| { kind: 'base64'; data: string; mime: string }
	| { kind: 'file'; path: string };

/** 图片 adapter 调用上下文：该模型自带的 baseUrl/apiKey + 本次生效配置（尺寸/比例/自定义参数） */
export interface CallContext {
	baseUrl: string;
	apiKey: string;
	config: ImageFlowConfig;
	/**
	 * 与 refs（base64 data URI）一一对应的任务文件夹 input/ 已归档参考素材绝对路径。
	 * 归档时序先于提交，天然可用。CLI 型 adapter（如 jimeng-cli）吃文件路径而非 base64，
	 * 只用此字段；HTTP 型 adapter 忽略。提交链路填充，轮询链路缺省。
	 */
	refPaths?: string[];
	/**
	 * 任务文件夹绝对路径（fsPath）。CLI 型 adapter 把成品下载到其 download/<jobId>/ 子目录：
	 * 与最终落盘同盘（rename 原子）、残片随任务夹生命周期回收、不污染顶层产物扫描。
	 * 轮询链路填充；缺省时 adapter 回落系统临时目录。HTTP 型 adapter 忽略。
	 */
	taskDir?: string;
}

/** async adapter 提交结果：拿到 jobId 后凭它轮询 */
export interface SubmitAsync {
	jobId: string;
}

/** sync adapter 提交结果：一次返回（可多张），无需轮询 */
export interface SubmitSync {
	results: ResultItem[];
}

/** async adapter 轮询结果：running 时 results 为空、带 progress；终结态带 results 或 error */
export interface AdapterJobResult {
	status: 'running' | 'succeeded' | 'failed' | 'violation';
	results: ResultItem[];
	error?: string;
	/** running 态的生成进度 0~100（远端返回，可能缺省） */
	progress?: number;
}

/**
 * 图片生成 adapter。
 * - kind='async'：submit 返回 {jobId}，再由 poll 轮询取结果（如 grsai）。
 * - kind='sync'：submit 直接返回 {results}，无 poll（如 openai-images / gemini-generate）。
 * - supportsBatch：是否支持单请求多图（如 openai 的 n）。false 则由调用方拆成 count 个单图请求。
 */
export interface ImageAdapter {
	readonly id: string;
	readonly kind: 'async' | 'sync';
	readonly supportsBatch: boolean;
	/** 提交一次生成。supportsBatch 时一次出 count 张；否则忽略 count、出 1 张 */
	submit(ctx: CallContext, prompt: string, refs: string[], count: number): Promise<SubmitAsync | SubmitSync>;
	/** 仅 async 实现：凭 jobId 查结果 */
	poll?(ctx: CallContext, jobId: string): Promise<AdapterJobResult>;
}

/** 对话 adapter 上下文：只需地址与密钥（无图片尺寸语义） */
export interface ChatContext {
	baseUrl: string;
	apiKey: string;
}

/** 对话消息（OpenAI 兼容） */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

/**
 * 对话 adapter（当前用于 AI 任务命名）。接口比图片简单：一次返回文本。
 * 失败 / 超时一律返回 undefined，由调用方静默回退占位名。
 */
export interface ChatAdapter {
	readonly id: string;
	chat(ctx: ChatContext, model: string, messages: ChatMessage[], maxTokens: number): Promise<string | undefined>;
}

/**
 * 把用户的可见自定义参数（config.params）并进请求体。
 * 跳过 undefined / 空串，但保留 '0' / 'false' 这类合法 falsy 值（不能用 if(v)）。
 * 固定参数（如 moderation）不走这里——由 adapter 自己写死（见多 API 计划 §6）。
 */
export function mergeCustomParams(body: Record<string, unknown>, params: Record<string, string>): void {
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') {
			body[key] = value;
		}
	}
}
