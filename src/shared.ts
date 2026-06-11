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
	/** 工作台素材库每行显示几张 */
	workbenchCols: number;
	/** 任务栏每行显示几张 */
	tasksCols: number;
	/** 模型 → 用户自定义注入句的覆盖表；缺省回退内置默认表 */
	modelInjections: Record<string, string>;
	/** 编辑页专属模型（与主生成界面互不影响） */
	editModel: string;
	/** 编辑页专属比例 */
	editAspectRatio: string;
	/** 编辑页专属分辨率 */
	editImageSize: string;
	/** 编辑页专属并发数 */
	editConcurrency: number;
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

/** 预设提示词模板：name 为文件名去扩展名，content 为全文 */
export interface PromptTemplate {
	name: string;
	content: string;
}

/** 编辑区图片（发往 webview）：src 为原图的 data URI（未缩放，直接作 img src） */
export interface WebviewEditImage {
	name: string;
	src: string;
}

/** 异步生成中单个 job 的状态（对应一次 generate 提交、一个远端 job id） */
// submitting：本地已建卡、generate 请求尚未拿到 job id 的中间态。
// 这样点生成可立即建卡返回，不必干等网络往返；拿到 id 后转 running。
export type JobStatus = 'submitting' | 'running' | 'succeeded' | 'failed' | 'violation';

/** 一次异步提交对应的 job：远端 id + 状态。succeeded 后不再轮询即不会重复下载 */
export interface PendingJob {
	/** 远端任务 id；submitting 态尚未拿到，转 running 时写入 */
	id?: string;
	status: JobStatus;
	error?: string;
	/** 远端返回的生成进度 0~100，仅 running 态有意义 */
	progress?: number;
}

/**
 * 一个进行中的任务（一次点击 = N 个并发 job，落到 .image-flow/tasks/<folder>）。
 * 持久化进 globalState，重启后据此续拉。
 */
export interface PendingTask {
	id: string;
	/** 任务来源：generate = Markdown 生成；edit = 编辑页 */
	kind: 'generate' | 'edit';
	/** 任务文件夹名（毫秒级时间戳），位于 .image-flow/tasks/ 下 */
	folder: string;
	/** 任务文件夹的绝对 Uri 字符串。globalState 跨工作区共享，续拉时不能依赖当前窗口的工作区根定位 */
	dir: string;
	/** 产出图片文件名前缀：生成任务为 md 名，编辑任务为 edit */
	prefix: string;
	/** 来源 md 的 Uri 字符串（仅 generate，用于追溯） */
	mdUri?: string;
	model: string;
	jobs: PendingJob[];
	/** 已成功下载到文件夹的图片，随 job 完成累加 */
	images: TaskImage[];
	/** 创建时间（ms），用于超时兜底。注意 resume() 会按会话起算重置它，不代表真实墙钟年龄 */
	createdAt: number;
	/** 任务首次提交时间（ms），仅用于显示已进行时间；resume() 不重置，保留真实墙钟年龄 */
	startedAt: number;
}

/** 发往 webview 的进行中任务：聚合进度 + 已存缩略图（带 src） */
export interface WebviewPendingTask {
	id: string;
	folder: string;
	model: string;
	total: number;
	done: number;
	failed: number;
	/** 仍在提交（尚未拿到 job id）的数量，>0 时卡片显示「提交中」 */
	submitting: number;
	/** 整任务聚合进度 0~100：已完成 job 记满分，running job 取远端进度均摊 */
	progress: number;
	/** 任务首次提交时间（ms），前端据此显示已进行时间（真实墙钟，不随重启重置） */
	startedAt: number;
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
	| { type: 'navigate'; tab: 'workbench' | 'edit' | 'tasks' | 'api' }
	| { type: 'libraries'; libraries: WebviewLibrary[] }
	| { type: 'autoLibraries'; libraries: WebviewLibrary[] }
	| { type: 'promptTemplates'; templates: PromptTemplate[] }
	| { type: 'editImages'; images: WebviewEditImage[] };

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
	| { type: 'removeLibrary'; folder: string }
	| { type: 'editUpload' }
	| { type: 'editAddImages'; uris: string[] }
	| { type: 'editAddImagesData'; items: { name: string; data: string }[] }
	| { type: 'editRemoveImage'; name: string }
	| { type: 'editGenerate'; prompt: string }
	| { type: 'editPreviewRequest'; prompt: string }
	| { type: 'openPrompt'; folder: string }
	| { type: 'refreshTemplates' };
