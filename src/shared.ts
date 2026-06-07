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

/** 扩展 → 前端 */
export type InboundMessage =
	| { type: 'config'; config: ImageFlowConfig; options: ConfigOptions }
	| { type: 'activeMd'; name: string | null }
	| { type: 'history'; tasks: WebviewTask[] }
	| { type: 'done'; task: WebviewTask }
	| { type: 'status'; message: string }
	| { type: 'error'; message: string }
	| { type: 'busy'; busy: boolean };

/** 前端 → 扩展 */
export type OutboundMessage =
	| { type: 'init' }
	| { type: 'saveConfig'; patch: Partial<ImageFlowConfig> }
	| { type: 'generate' }
	| { type: 'openImage'; uri: string }
	| { type: 'openExternal'; url: string }
	| { type: 'refreshHistory' };
