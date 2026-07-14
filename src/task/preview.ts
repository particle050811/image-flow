import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import type { ImageFlowConfig } from '../shared';
import { readConfig } from '../ui/config';
import { buildInjectedPrompt } from '../prompt/inject';
import { buildPrompt } from '../prompt/buildPrompt';
import { isJimengVideoModel, JIMENG_PROVIDER_ID } from '../backend/providers';
import { errMsg } from '../util/errors';
import { log } from '../util/log';
import { showTransientWarning } from '../util/notify';

/**
 * 解析指定 Markdown，构建「替换后的最终提示词正文」（发给后端的 prompt，不含请求参数与参考图概览）。
 * 不调用 API、不消耗额度。引用解析失败（如图片引用找不到文件）时抛错，供调用方决定如何呈现。
 * 供 openRequestPreview（打开编辑器预览）与 CLI 桥 preview 命令共用，保证两处口径不漂移。
 */
export async function buildRequestPreviewText(
	config: ImageFlowConfig,
	mdUri: vscode.Uri
): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(mdUri);
	const content = Buffer.from(bytes).toString('utf8').trim();
	if (!content) {
		throw new Error('Markdown 文件内容为空。');
	}
	// 与提交链路同口径：即梦视频（全能参考）允许音/视频参考，预览不误报
	const allowNonImage = config.providerId === JIMENG_PROVIDER_ID && isJimengVideoModel(config.model);
	const { prompt: basePrompt } = await buildPrompt(mdUri, content, allowNonImage);
	return buildInjectedPrompt(config, basePrompt);
}

/**
 * 解析指定 Markdown 并把「替换后的最终提示词正文」打开成预览文档。供右键命令与侧栏按钮共用。
 */
export async function openRequestPreview(
	config: ImageFlowConfig,
	mdUri: vscode.Uri
): Promise<void> {
	const prompt = await buildRequestPreviewText(config, mdUri);
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
		showTransientWarning('Image Flow：请在 Markdown 文件上右键，或先打开一个文件。');
		return;
	}
	try {
		const config = await readConfig(context);
		await openRequestPreview(config, target);
	} catch (err: unknown) {
		// 与 sidebarProvider.post 的错误收口同口径：弹窗 + 记台账日志（此路径不经 webview，需自行记）
		log(`错误：预览请求失败：${errMsg(err)}`);
		vscode.window.showErrorMessage(`Image Flow：${errMsg(err)}`);
	}
}
