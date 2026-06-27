import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

/** 生成 CSP nonce（扩展运行在 Node 主进程，用 crypto 安全随机） */
function nonceStr(): string {
	return randomBytes(16).toString('hex');
}

/** 构造侧栏 Webview 的 HTML：注入 CSP、加载 media 下的 sidebar.css 与 sidebar.js（脚本锁 nonce） */
export function sidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const uri = (f: string) =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
	const nonce = nonceStr();
	// style-src 必须含 'unsafe-inline'：Radix（Select/Collapsible 等）的浮层定位、
	// 滚动锁、动画高度均通过元素级内联 style 属性实现，而 CSP nonce/hash 只覆盖
	// <style>/<script> 标签、管不到内联 style 属性，故无法收紧为 nonce。脚本仍锁 nonce。
	// img-src 须含 data:：编辑区图片统一以 data URI 推送（可能来自 localResourceRoots 之外）。
	const csp =
		`default-src 'none'; img-src ${webview.cspSource} data:; ` +
		`style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('sidebar.css')}" rel="stylesheet">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('sidebar.js')}"></script>
</body>
</html>`;
}
