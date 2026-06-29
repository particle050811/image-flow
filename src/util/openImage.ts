import * as vscode from 'vscode';

/**
 * 在编辑器里打开一张图片。
 *
 * 图片走 VS Code 原生「预览模式」打开——图片之间复用同一预览槽、互相替换、只留最新一张，
 * 不维护任何状态。唯一规避：图片默认落入活动编辑组，若该组当前的预览标签是 md（提示词正文），
 * 开图前先用 preview:false 把这份 md 就地固定（预览标签转固定标签，不新建标签），图片便不会
 * 顶替它，只会去顶替「上一张图的预览槽」。其余编辑组的 md 不在落点上，本就不受影响。
 *
 * 只认 file scheme 的真实 md：git diff 左侧、untitled、vscode-userdata 等 TabInputText 的 path
 * 也可能以 .md 结尾，固定它们是无谓副作用。preserveFocus:true 是为保持活动组不变，让随后的
 * vscode.open 落回同一组、正好命中刚固定的 md 所在组。
 */
export async function openImageInEditor(uri: vscode.Uri): Promise<void> {
	const group = vscode.window.tabGroups.activeTabGroup;
	const input = group.tabs.find((t) => t.isPreview)?.input;
	if (
		input instanceof vscode.TabInputText &&
		input.uri.scheme === 'file' &&
		input.uri.path.toLowerCase().endsWith('.md')
	) {
		await vscode.window.showTextDocument(input.uri, {
			viewColumn: group.viewColumn,
			preview: false,
			preserveFocus: true,
		});
	}
	await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
}
