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

/** 持久化在 webview 内的本地状态（跨重载/重启保留），目前仅记未读任务集合 */
export interface WebviewState {
	/** 未读任务的文件夹标识集合：创建时登记、点开即删，用于任务页未读特效与标签角标计数 */
	unreadTasks?: string[];
}

interface VsCodeApi {
	postMessage(msg: OutboundMessage): void;
	getState(): WebviewState | undefined;
	setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
