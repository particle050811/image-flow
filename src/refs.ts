// 编辑提示词中的图片引用片段。webview 与扩展两端共用，
// 禁止引入 vscode / node 内置模块（webview bundle 是浏览器环境）。

/** 右键插入的命名引用：`[主名]`（去掉扩展名）。命名引用替换链路按此名匹配声明 */
export function namedRefSnippet(fileName: string): string {
	const stem = fileName.replace(/\.[^.\\/]+$/, '');
	return `[${stem}]`;
}

/** 媒体声明片段：`![alt](文件名)`；含空格或半角括号的文件名用尖括号包裹，与解析端约定一致 */
export function mediaDeclSnippet(alt: string, name: string): string {
	const dest = /[ ()]/.test(name) ? `<${name}>` : name;
	return `![${alt}](${dest})`;
}
