import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import type { ImageFlowConfig } from '../shared';
import { readConfig } from '../ui/config';
import { buildInjectedPrompt } from '../prompt/inject';
import { buildPrompt } from '../prompt/buildPrompt';
import { errMsg } from '../util/errors';

/**
 * 解析指定 Markdown 并把「替换后的最终提示词正文」打开成预览文档。供右键命令与侧栏按钮共用。
 * 只展示发送给后端的提示词正文，不附请求参数与参考图概览。不调用 API、不消耗额度。
 */
export async function openRequestPreview(
	config: ImageFlowConfig,
	mdUri: vscode.Uri
): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(mdUri);
	const content = Buffer.from(bytes).toString('utf8').trim();
	if (!content) {
		throw new Error('Markdown 文件内容为空。');
	}
	const { prompt: basePrompt } = await buildPrompt(mdUri, content);
	const prompt = await buildInjectedPrompt(config, basePrompt);
	await openTextPreview(prompt);
}

/** 请求预览文档统一命名 preview.md，拦截误触生成时按此名识别 */
export const PREVIEW_DOC_NAME = 'preview.md';

/** 该 Uri 是否为请求预览文档——其内容是请求参数而非正文，不能用于生成 */
export function isPreviewDoc(uri: vscode.Uri): boolean {
	return path.basename(uri.fsPath).toLowerCase() === PREVIEW_DOC_NAME;
}

/**
 * 把文本写入系统临时目录的 .md 文件并打开预览。
 * 用临时文件而非 untitled 文档：内容已落盘，关闭时不会弹「是否保存」。
 */
export async function openTextPreview(text: string): Promise<void> {
	const dir = path.join(os.tmpdir(), 'image-flow');
	const uri = vscode.Uri.file(path.join(dir, PREVIEW_DOC_NAME));
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * 右键 Markdown 文件时触发：解析正文并把替换后的提示词与请求参数打开成预览文档，便于调试。
 * 不调用 API、不消耗额度。
 */
export async function previewRequestCommand(
	context: vscode.ExtensionContext,
	uri?: vscode.Uri
): Promise<void> {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (!target) {
		vscode.window.showErrorMessage('Image Flow：请在 Markdown 文件上右键，或先打开一个文件。');
		return;
	}
	try {
		const config = await readConfig(context);
		await openRequestPreview(config, target);
	} catch (err: unknown) {
		vscode.window.showErrorMessage(`Image Flow：${errMsg(err)}`);
	}
}
