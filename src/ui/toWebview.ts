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
	// 音/视频不做缩略图：原生 <audio>/<video> 直接加载原文件，canvas 降采样不适用
	if (img.media && img.media !== 'image') {
		return { ...img, src: webview.asWebviewUri(vscode.Uri.parse(img.uri)).toString(), favorited };
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
	// 计数统一按「张数」而非 job 数：批量 adapter（即梦 generate_num）单 job 出 N 张，
	// total 取 meta.requested 兜底、done 取已落盘张数，避免 10 张任务显示成 0/1。
	// 非批量任务 jobs.length === requested 且每 job 落 1 张，口径不变。
	const total = Math.max(task.jobs.length, task.meta.requested);
	const done = task.images.length;
	const failedJobs = task.jobs.filter((j) => j.status === 'failed' || j.status === 'violation').length;
	// 批量 job 失败即整批失败：失败张数按每 job 均摊张数换算（非批量时恰为失败 job 数）
	const failed = Math.min(total - done, Math.round((failedJobs * total) / task.jobs.length));
	// submitting 同样换算成张数（前端用 total - submitting 显示已提交数），批量单 job 提交中 = 整批提交中
	const submittingJobs = task.jobs.filter((j) => j.status === 'submitting').length;
	const submitting = Math.min(total, Math.round((submittingJobs * total) / task.jobs.length));
	const errors = task.jobs.map((j) => j.error).filter((e): e is string => !!e);
	// 积分（即梦渠道）：已终结 job 的 creditCount 实时累加。进行中即可显示当前花费，
	// 任务终结转历史时 meta.credit 已有最终值，此处只覆盖进行中的场景
	const credit = task.jobs.reduce((sum, j) => sum + (j.creditCount ?? 0), 0);
	return {
		id: task.id,
		folder: task.folder,
		model: task.model,
		aspectRatio: task.meta.aspectRatio,
		imageSize: task.meta.imageSize,
		title: task.title,
		promptName: task.prefix,
		total,
		done,
		failed,
		creating: task.creating,
		submitting,
		sync: task.sync,
		progress: aggregateProgress(task.jobs),
		startedAt: task.startedAt,
		...(credit > 0 ? { credit } : {}),
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
