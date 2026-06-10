// 编辑提示词中的图片引用片段。webview 与扩展两端共用，
// 禁止引入 vscode / node 内置模块（webview bundle 是浏览器环境）。

/** 点击编辑区图片时插入的引用：`![](文件名)`；含空格或半角括号时用尖括号包裹，与解析端约定一致 */
export function imageRefSnippet(name: string): string {
	const dest = /[ ()]/.test(name) ? `<${name}>` : name;
	return `![](${dest})`;
}
