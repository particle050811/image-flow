// VS Code webview API 封装。消息与配置类型从 ../shared 复用，保证前后端协议一致。

import type { OutboundMessage } from '../shared';

export type {
	ImageFlowConfig as Config,
	ConfigOptions,
	WebviewImage,
	WebviewCollection,
	MediaType,
	WebviewTask,
	WebviewPendingTask,
	WebviewLibrary,
	PromptTemplate,
	StatusState,
	WebviewEditImage,
	InboundMessage,
	OutboundMessage,
} from '../shared';

/** 持久化在 webview 内的本地状态（跨重载/重启保留），目前仅记已看过的完成任务文件夹 */
export interface WebviewState {
	/** 已点开看过的「已完成任务」文件夹名集合，用于任务页未读特效与标签角标计数 */
	viewedTasks?: string[];
}

interface VsCodeApi {
	postMessage(msg: OutboundMessage): void;
	getState(): WebviewState | undefined;
	setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
