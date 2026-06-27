import * as vscode from 'vscode';
import * as path from 'path';
import { isImageFileName, mimeOf } from '../util/images';
import { uriBaseName } from '../storage/paths';

/** 编辑区一张图：name 为引用名（文件名），data 为 base64 data URI（统一驻内存，提交直接用） */
export interface EditImage {
	name: string;
	data: string;
	/** 压缩展示图（webview canvas 降采样后回传的 webp data URI）：推送展示用它，提交仍用 data */
	display?: string;
}

/** 原图 data URI 超过此长度才值得做压缩展示图（约对应 100KB 二进制的 base64 体积） */
const DISPLAY_MIN_DATA_LENGTH = 140 * 1024;

/**
 * 编辑区图片列表：扩展主进程持有（webview 重建不丢）。
 * 统一存 data URI——绕开 localResourceRoots 限制（图片可能来自任意目录），
 * 也顺带覆盖系统拖入拿不到路径的二进制；提交时本就要转 base64，无重复开销。
 * 重名直接拒绝（引用按文件名，重名会产生歧义）。
 */
export class EditSession {
	private images: EditImage[] = [];

	list(): EditImage[] {
		return this.images;
	}

	/** 按文件 Uri 添加：读文件转 data URI。返回错误消息，null 表示成功 */
	async addUri(uriStr: string): Promise<string | null> {
		const uri = vscode.Uri.parse(uriStr);
		const name = uriBaseName(uri);
		const invalid = this.validate(name);
		if (invalid) {
			return invalid;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const data = `data:${mimeOf(path.extname(name))};base64,${Buffer.from(bytes).toString('base64')}`;
			this.images.push({ name, data });
			return null;
		} catch {
			return `图片读取失败：${name}`;
		}
	}

	/** 添加内存图（系统拖入的二进制，前端已转 data URI）。返回错误消息，null 表示成功 */
	addData(name: string, data: string): string | null {
		const invalid = this.validate(name);
		if (invalid) {
			return invalid;
		}
		if (!data.startsWith('data:image/')) {
			return `图片数据异常：${name}`;
		}
		this.images.push({ name, data });
		return null;
	}

	remove(name: string): void {
		this.images = this.images.filter((i) => i.name !== name);
	}

	/** 清空编辑区全部图片（提交后保留图片以支持迭代编辑，需手动清空时调用） */
	clear(): void {
		this.images = [];
	}

	/** 是否需要 webview 生成压缩展示图：尚无展示图、原图够大、且非 gif（降采样丢动画） */
	needsDisplay(img: EditImage): boolean {
		return (
			!img.display &&
			img.data.length > DISPLAY_MIN_DATA_LENGTH &&
			!img.data.startsWith('data:image/gif')
		);
	}

	/** 写入 webview 回传的压缩展示图。srcLength 为生成时原图 data URI 的长度——
	 *  生成期间同名图被删后换图时据此丢弃过期回传；图片已移除或数据形状不对同样忽略 */
	setDisplay(name: string, srcLength: number, data: string): void {
		const img = this.images.find((i) => i.name === name);
		if (img && img.data.length === srcLength && data.startsWith('data:image/webp;base64,')) {
			img.display = data;
		}
	}

	private validate(name: string): string | null {
		if (!isImageFileName(name)) {
			return `不支持的图片格式：${name}`;
		}
		if (this.images.some((i) => i.name === name)) {
			return `已存在同名图片，请改名后再添加：${name}`;
		}
		// 命名引用按「去扩展主名」匹配声明，主名相同（如 logo.png 与 logo.jpg）会让提交时编号冲突——入列即拦截
		const stem = path.basename(name, path.extname(name));
		if (this.images.some((i) => path.basename(i.name, path.extname(i.name)) === stem)) {
			return `已存在同主名图片（命名引用会冲突），请改名后再添加：${name}`;
		}
		return null;
	}
}
