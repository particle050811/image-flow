import * as vscode from 'vscode';
import * as path from 'path';
import { isImageFileName, mimeOf } from './images';
import { uriBaseName } from './paths';

/** 编辑区一张图：name 为引用名（文件名），data 为 base64 data URI（统一驻内存，提交直接用） */
export interface EditImage {
	name: string;
	data: string;
}

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

	private validate(name: string): string | null {
		if (!isImageFileName(name)) {
			return `不支持的图片格式：${name}`;
		}
		if (this.images.some((i) => i.name === name)) {
			return `已存在同名图片，请改名后再添加：${name}`;
		}
		return null;
	}
}
