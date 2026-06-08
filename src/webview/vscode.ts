// VS Code webview API 封装。消息与配置类型从 ../shared 复用，保证前后端协议一致。

import type { OutboundMessage } from '../shared';

export type {
	ImageFlowConfig as Config,
	ConfigOptions,
	BaseUrlOption,
	WebviewImage,
	WebviewTask,
	WebviewPendingTask,
	WebviewLibrary,
	InboundMessage,
	OutboundMessage,
} from '../shared';

interface VsCodeApi {
	postMessage(msg: OutboundMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
