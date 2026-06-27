import * as vscode from 'vscode';
import type { TaskMeta } from '../shared';

/** 提示词文件内容：纯正文归档（来源等元信息已迁出到 meta.json，不再写 frontmatter） */
export function buildPromptFileContent(prompt: string): string {
	return `${prompt}\n`;
}

/** 任务元数据文件名 */
const META_FILE = 'meta.json';

/** 写入 / 覆盖任务文件夹内的 meta.json */
export async function writeTaskMeta(taskDir: vscode.Uri, meta: TaskMeta): Promise<void> {
	await vscode.workspace.fs.writeFile(
		vscode.Uri.joinPath(taskDir, META_FILE),
		Buffer.from(JSON.stringify(meta, null, 2), 'utf8')
	);
}

/** 读取任务文件夹内的 meta.json；不存在或解析失败返回 undefined（旧任务无此文件） */
export async function readTaskMeta(taskDir: vscode.Uri): Promise<TaskMeta | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(taskDir, META_FILE));
		return JSON.parse(Buffer.from(bytes).toString('utf8')) as TaskMeta;
	} catch {
		return undefined;
	}
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
 * 归档参考图到任务文件夹 input/ 子目录：保留原文件名（重名已由调用方去重），
 * 与提示词文件里 ![](input/原名) 的引用一一对应。无参考图则不建目录。
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
	for (const ref of refs) {
		const file = vscode.Uri.joinPath(dir, ref.name);
		await vscode.workspace.fs.writeFile(file, dataUriBytes(ref.data));
	}
}
