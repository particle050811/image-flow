import * as vscode from 'vscode';
import { aggregateProgress } from '../task/tasks';
import { resolveThumb } from '../storage/thumbs';
import type {
	Task,
	TaskImage,
	WebviewImage,
	WebviewTask,
	PendingTask,
	WebviewPendingTask,
	MaterialLibrary,
	WebviewLibrary,
} from '../shared';

/** 把文件图转成 webview 可加载的图：有缩略图用缩略图作 src（F051），
 *  没有则用原图并下发 thumbKey 请 webview 生成；uri 字段始终保留原图（点开/拖拽用）。
 *  无 webview 时返回 src=原图 uri 的兜底分支。 */
async function toWebviewImage(
	webview: vscode.Webview | undefined,
	img: TaskImage,
	favSet: Set<string>
): Promise<WebviewImage> {
	const favorited = favSet.has(img.uri);
	if (!webview) {
		return { ...img, src: img.uri, favorited };
	}
	const { thumbUri, thumbKey } = await resolveThumb(img.uri);
	return {
		...img,
		src: webview.asWebviewUri(thumbUri ?? vscode.Uri.parse(img.uri)).toString(),
		thumbKey,
		favorited,
	};
}

export async function toWebviewImages(
	webview: vscode.Webview | undefined,
	images: TaskImage[],
	favSet: Set<string>
): Promise<WebviewImage[]> {
	return Promise.all(images.map((img) => toWebviewImage(webview, img, favSet)));
}

/** 把任务里的文件 Uri 转成 webview 可加载的 src（asWebviewUri） */
export async function toWebviewTask(
	webview: vscode.Webview | undefined,
	task: Task,
	favSet: Set<string>
): Promise<WebviewTask> {
	return {
		folder: task.folder,
		images: await toWebviewImages(webview, task.images, favSet),
		promptName: task.promptName,
		meta: task.meta,
	};
}

/** 把进行中任务转成 webview 视图：聚合进度 + 已存缩略图带 src */
export async function toWebviewPendingTask(
	webview: vscode.Webview | undefined,
	task: PendingTask,
	favSet: Set<string>
): Promise<WebviewPendingTask> {
	const done = task.jobs.filter((j) => j.status === 'succeeded').length;
	const failed = task.jobs.filter((j) => j.status === 'failed' || j.status === 'violation').length;
	const submitting = task.jobs.filter((j) => j.status === 'submitting').length;
	const errors = task.jobs.map((j) => j.error).filter((e): e is string => !!e);
	return {
		id: task.id,
		folder: task.folder,
		model: task.model,
		aspectRatio: task.meta.aspectRatio,
		imageSize: task.meta.imageSize,
		title: task.title,
		promptName: task.prefix,
		total: task.jobs.length,
		done,
		failed,
		submitting,
		sync: task.sync,
		progress: aggregateProgress(task.jobs),
		startedAt: task.startedAt,
		errors,
		images: await toWebviewImages(webview, task.images, favSet),
	};
}

/** 把素材库里的文件 Uri 转成 webview 可加载的 src */
export async function toWebviewLibrary(
	webview: vscode.Webview | undefined,
	lib: MaterialLibrary,
	favSet: Set<string>
): Promise<WebviewLibrary> {
	return {
		folder: lib.folder,
		name: lib.name,
		images: await toWebviewImages(webview, lib.images, favSet),
	};
}
