import * as vscode from 'vscode';
import { isPreviewDoc, previewRequestCommand } from './task/preview';
import { cleanEmptyTaskFolders } from './task/history';
import { seedModelInjections, readConfig } from './ui/config';
import { reloadCustomProvider } from './backend/providerRuntime';
import { SidebarProvider } from './ui/sidebarProvider';
import { registerCliBridge } from './ui/cliBridge';
import { TaskManager } from './task/tasks';
import { initLog, log } from './util/log';
import { showTransientWarning } from './util/notify';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// 台账日志通道：尽早初始化，后续任务/错误写入供排障
	initLog(context);
	log('扩展已激活');

	// 首次激活把内置注入种子写入配置，让默认抑噪句在侧栏输入框可见可改。
	// 必须在注册侧栏 provider 前 await：否则 webview 可能先读到尚未种入的 config，默认句首次不显示。
	await seedModelInjections(context);

	// 读入自定义 Provider（~/.image-flow/settings.json）缓存：侧栏首读 config 即能拿到自定义模型候选。
	// 改 settings.json 后需重载窗口生效（无 file watch），切到自定义/打开配置时也会重读。
	await reloadCustomProvider();

	// 异步任务管理器：提交/轮询/持久化。配合 onStartupFinished 激活，开机即 resume 续拉重启前未完成的任务。
	const taskManager = new TaskManager(context);
	context.subscriptions.push(taskManager);

	// 启动清理无产物任务夹（默认开、可在设置关）：排除持久化待续拉任务的文件夹，避免删掉正在下载中的任务。
	// 须在 resume() 前做：清理与续拉互不干扰，「构建并复制」未回收的视频任务到下次启动即被清掉。
	const startupConfig = await readConfig(context);
	if (startupConfig.cleanEmptyTasksOnStartup) {
		const removed = await cleanEmptyTaskFolders(new Set(taskManager.list().map((t) => t.folder)));
		if (removed) {
			log(`启动清理无产物任务夹 ${removed} 个`);
		}
	}

	const sidebar = new SidebarProvider(context, taskManager);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar),
		vscode.commands.registerCommand('image-flow.generateImage', async (uri?: vscode.Uri) => {
			// 菜单传入 uri；从命令面板触发时回退到当前活动编辑器
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!target) {
				showTransientWarning('Image Flow：请在 Markdown 文件上右键，或先打开一个文件。');
				return;
			}
			if (isPreviewDoc(target)) {
				showTransientWarning('Image Flow：这是请求预览文档，仅供调试查看，不能用于生成。请对源 Markdown 触发生成。');
				return;
			}
			await sidebar.generateFor(target);
		}),
		vscode.commands.registerCommand('image-flow.previewRequest', (uri?: vscode.Uri) =>
			previewRequestCommand(context, uri)
		),
		// 给 AI 自动调用的回环 HTTP 桥：固定候选端口段依次试绑（工作区零落盘），
		// 处理 list|fix|preview|submit|query_result|list_task|list_model|favorite 请求
		//（submit/查询需 TaskManager；favorite 落库后经回调让侧栏即时刷新收藏）
		registerCliBridge(context, taskManager, () => sidebar.pushAfterFavoritesChange())
	);

	taskManager.resume();
}

// This method is called when your extension is deactivated
export function deactivate() {}
