import * as vscode from 'vscode';

/** 提示词文件内容：frontmatter 记来源（md 工作区相对路径 / （编辑任务）），正文为最终提示词 */
export function buildPromptFileContent(source: string, prompt: string): string {
	return `---\nsource: ${source}\n---\n\n${prompt}\n`;
}

/** 把提示词文件写进任务文件夹 */
export async function writePromptFile(
	taskDir: vscode.Uri,
	fileName: string,
	content: string
): Promise<void> {
	await vscode.workspace.fs.writeFile(
		vscode.Uri.joinPath(taskDir, fileName),
		Buffer.from(content, 'utf8')
	);
}

/** 解析 base64 data URI 为字节；格式异常抛错 */
export function dataUriBytes(dataUri: string): Uint8Array {
	const comma = dataUri.indexOf(',');
	if (!dataUri.startsWith('data:') || comma < 0) {
		throw new Error('参考图数据格式异常（非 data URI）');
	}
	return new Uint8Array(Buffer.from(dataUri.slice(comma + 1), 'base64'));
}

/**
 * 归档参考图到任务文件夹 input/ 子目录：image<N>-<原名>，
 * 与提示词文件中的 [imageN] 一一对应。无参考图则不建目录。
 */
export async function archiveInputs(
	taskDir: vscode.Uri,
	refs: { name: string; data: string }[]
): Promise<void> {
	if (!refs.length) {
		return;
	}
	const dir = vscode.Uri.joinPath(taskDir, 'input');
	await vscode.workspace.fs.createDirectory(dir);
	for (let i = 0; i < refs.length; i++) {
		const file = vscode.Uri.joinPath(dir, `image${i + 1}-${refs[i].name}`);
		await vscode.workspace.fs.writeFile(file, dataUriBytes(refs[i].data));
	}
}
