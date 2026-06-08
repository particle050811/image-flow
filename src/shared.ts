// 扩展主进程（Node）与 Webview 前端（浏览器）共享的类型。
// 纯类型文件——编译后被擦除，对两端环境都安全，不要在此引入 vscode 或 DOM 依赖。
// 这是 Config / Task / 消息协议的唯一定义处，避免在 api.ts、command.ts、webview 各写一份导致漂移。

/** 扩展配置（globalState 存非敏感项 + secrets 存 apiKey） */
export interface ImageFlowConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	aspectRatio: string;
	imageSize: string;
	concurrency: number;
	/** 工作台缩略图边长（px） */
	workbenchThumbSize: number;
	/** 任务栏缩略图边长（px） */
	tasksThumbSize: number;
	/** 模型 → 用户自定义注入句的覆盖表；缺省回退内置默认表 */
	modelInjections: Record<string, string>;
}

export interface BaseUrlOption {
	value: string;
	label: string;
}

/** 各配置项的可选值，供侧栏下拉渲染 */
export interface ConfigOptions {
	baseUrl: readonly BaseUrlOption[];
	model: readonly string[];
	aspectRatio: readonly string[];
	imageSize: readonly string[];
}

/** 扩展内部产出的一张图片：仅含文件引用（file Uri 字符串） */
export interface TaskImage {
	name: string;
	uri: string;
}

/** 扩展内部的一个生成任务（对应一个 task-* 文件夹） */
export interface Task {
	folder: string;
	images: TaskImage[];
}

/** 发往 webview 的图片：额外带 webview 可加载的 src（asWebviewUri 转换结果） */
export interface WebviewImage extends TaskImage {
	src: string;
}

export interface WebviewTask {
	folder: string;
	images: WebviewImage[];
}

/** 一个素材库（对应一个文件夹，递归扫描出的图片） */
export interface MaterialLibrary {
	folder: string;
	name: string;
	images: TaskImage[];
}

/** 发往 webview 的素材库：图片带 asWebviewUri 转换后的 src */
export interface WebviewLibrary {
	folder: string;
	name: string;
	images: WebviewImage[];
}

/** 异步生成中单个 job 的状态（对应一次 generate 提交、一个远端 job id） */
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'violation';

/** 一次异步提交对应的 job：远端 id + 状态。succeeded 后不再轮询即不会重复下载 */
export interface PendingJob {
	id: string;
	status: JobStatus;
	error?: string;
}

/**
 * 一个进行中的生成任务（一次点击 = N 个并发 job，落到同一 task 文件夹）。
 * 持久化进 globalState，重启后据此续拉。
 */
export interface PendingTask {
	id: string;
	folder: string;
	mdUri: string;
	model: string;
	jobs: PendingJob[];
	/** 已成功下载到文件夹的图片，随 job 完成累加 */
	images: TaskImage[];
	/** 创建时间（ms），用于超时兜底 */
	createdAt: number;
}

/** 发往 webview 的进行中任务：聚合进度 + 已存缩略图（带 src） */
export interface WebviewPendingTask {
	id: string;
	folder: string;
	model: string;
	total: number;
	done: number;
	failed: number;
	errors: string[];
	images: WebviewImage[];
}

/** 扩展 → 前端 */
export type InboundMessage =
	| { type: 'config'; config: ImageFlowConfig; options: ConfigOptions }
	| { type: 'activeMd'; name: string | null }
	| { type: 'history'; tasks: WebviewTask[] }
	| { type: 'pendingTasks'; tasks: WebviewPendingTask[] }
	| { type: 'status'; message: string }
	| { type: 'error'; message: string }
	| { type: 'busy'; busy: boolean }
	| { type: 'libraries'; libraries: WebviewLibrary[] }
	| { type: 'autoLibraries'; libraries: WebviewLibrary[] };

/** 前端 → 扩展 */
export type OutboundMessage =
	| { type: 'init' }
	| { type: 'saveConfig'; patch: Partial<ImageFlowConfig> }
	| { type: 'generate' }
	| { type: 'previewRequest' }
	| { type: 'openImage'; uri: string }
	| { type: 'insertImage'; uri: string }
	| { type: 'openExternal'; url: string }
	| { type: 'refreshHistory' }
	| { type: 'addLibrary' }
	| { type: 'removeLibrary'; folder: string };
