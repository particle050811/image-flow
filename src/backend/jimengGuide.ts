// 即梦 CLI 引导流（vscode 侧）：提交前探测 CLI 安装与登录态，缺失时弹带按钮的引导通知。
// 登录必须由用户在终端手动完成——官方 FAQ 明载 Agent/程序启动的 dreamina login 打印的
// 授权 URL 是错的（「非法应用」），扩展绝不代跑登录、不接触任何凭据。

import * as vscode from 'vscode';
import type { ImageFlowConfig } from '../shared';
import { JIMENG_PROVIDER_ID } from './providers';
import { findDreamina, checkJimengLogin, queryJimengLogin, CLI_MISSING_MESSAGE, NOT_LOGGED_IN_MESSAGE } from './adapters/jimengCli';
import { showTransientInfo } from '../util/notify';

/** 官方安装命令（Windows 走 Git Bash 的 bash -c 包一层，PowerShell 下也能执行） */
const INSTALL_CMD = 'curl -fsSL https://jimeng.jianying.com/cli | bash';
/** 即梦官网（查看说明 / 合规授权入口） */
const JIMENG_HOME = 'https://jimeng.jianying.com';

/** 打开集成终端并自动执行命令（命令与输出全程用户可见） */
function runInTerminal(command: string): void {
	const terminal = vscode.window.createTerminal('即梦 CLI');
	terminal.show();
	terminal.sendText(command, true);
}

/** CLI 未安装的引导通知：终端自动执行官方安装脚本 / 打开官网说明 */
function promptInstall(): void {
	void vscode.window
		.showWarningMessage('Image Flow：未检测到即梦 CLI（dreamina）', '安装即梦 CLI', '查看说明')
		.then((picked) => {
			if (picked === '安装即梦 CLI') {
				// PowerShell 无管道到 bash 的语义，统一经 bash -c 执行官方安装脚本
				runInTerminal(process.platform === 'win32' ? `bash -c "${INSTALL_CMD}"` : INSTALL_CMD);
			} else if (picked === '查看说明') {
				void vscode.env.openExternal(vscode.Uri.parse(JIMENG_HOME));
			}
		});
}

/**
 * 设置页「登录」按钮：未安装 → 弹安装引导；已登录 → 轻提示无需重复登录；
 * 否则打开终端自动执行 dreamina login（授权仍由用户在终端完成，扩展不接触凭据）。
 */
export async function jimengLogin(): Promise<void> {
	try {
		await findDreamina();
	} catch {
		promptInstall();
		return;
	}
	// 只有「确认已登录」才提示无需重复；确认未登录或无法确认（网络抖动）都打开终端执行登录，
	// 由 CLI 自行复用现有登录态或发起授权——不能把「查不到」误报成「已登录」
	if ((await queryJimengLogin()) === 'ok') {
		showTransientInfo('即梦 CLI 已登录，可直接使用。');
		return;
	}
	runInTerminal('dreamina login');
}

/**
 * 即梦提交前置检查：CLI 未安装 → 弹「安装即梦 CLI / 查看说明」并中止；
 * 未登录 → 弹「去登录」（终端自动执行 dreamina login，用户在终端完成授权）并中止。
 * 非即梦渠道直接放行。通知按钮回调非阻塞，函数通过抛错让调用方走统一错误路径。
 */
export async function ensureJimengReady(config: ImageFlowConfig): Promise<void> {
	if (config.providerId !== JIMENG_PROVIDER_ID) {
		return;
	}
	try {
		await findDreamina();
	} catch {
		promptInstall();
		throw new Error(`${CLI_MISSING_MESSAGE}，请先安装（安装完成后如仍检测不到，请重启 VS Code 刷新 PATH）`);
	}
	if (!(await checkJimengLogin())) {
		void vscode.window
			.showWarningMessage('Image Flow：即梦 CLI 未登录（需即梦高级会员及以上）', '去登录')
			.then((picked) => {
				if (picked === '去登录') {
					runInTerminal('dreamina login');
				}
			});
		throw new Error(`${NOT_LOGGED_IN_MESSAGE}，请在终端完成 dreamina login 授权后重试`);
	}
}
