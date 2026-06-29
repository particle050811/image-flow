import * as vscode from 'vscode';
import * as path from 'path';
import { readFavorites, favoriteUriSet } from '../favorites/favorites';
import { showTransientWarning } from '../util/notify';
import {
	getLibraryFolders,
	addLibraryFolder,
	removeLibraryFolder,
	listLibraries,
	listAutoLibraries,
	readImageDesc,
	aliasFromDesc,
} from '../storage/materials';
import { parseMediaDecls } from '../prompt/buildPrompt';
import { toWebviewLibrary } from './toWebview';
import type { InboundMessage } from '../shared';

/** 两个文件系统路径是否指向同一文件（规范化分隔符；Windows 大小写不敏感，统一小写比对） */
function samePath(a: string, b: string): boolean {
	const norm = (p: string) => path.normalize(p).toLowerCase();
	return norm(a) === norm(b);
}

/** 素材控制器依赖：webview view 与当前 MD 由 SidebarProvider 动态持有，经 getter 回调取 */
export interface MaterialsDeps {
	post(msg: InboundMessage): void;
	/** 当前 webview view（设资源根 / asWebviewUri 需要），未 resolve 时 undefined */
	view(): vscode.WebviewView | undefined;
	/** 当前关联的 MD（自动库与插入引用的归属），无则 undefined */
	currentMd(): vscode.Uri | undefined;
}

/**
 * 素材库相关的消息处理：库增删、webview 资源根管理、库/自动库推送、右键插入引用。
 * 库目录要进 localResourceRoots 缩略图才可加载，故资源根管理与素材库一并归此。
 * view/currentMd 经 deps getter 取，数据全经 materials/favorites 模块。
 */
export class MaterialsController {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly deps: MaterialsDeps
	) {}

	/** 构造 webview 的资源根：扩展 media + 工作区目录 + 各素材库目录 */
	buildResourceRoots(): vscode.Uri[] {
		return [
			vscode.Uri.joinPath(this.context.extensionUri, 'media'),
			...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
			...getLibraryFolders(this.context).map((f) => vscode.Uri.parse(f)),
		];
	}

	/** 素材库增删后重设 localResourceRoots，使新目录的缩略图可加载 */
	refreshResourceRoots(): void {
		const view = this.deps.view();
		if (!view) {
			return;
		}
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: this.buildResourceRoots(),
		};
	}

	/** 弹出文件夹选择器，把选中的目录加为素材库 */
	async addLibrary(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: '作为素材库添加',
		});
		if (!picked?.length) {
			return;
		}
		await addLibraryFolder(this.context, picked[0].toString());
		this.refreshResourceRoots();
		await this.pushLibraries();
	}

	async removeLibrary(folder: string): Promise<void> {
		await removeLibraryFolder(this.context, folder);
		this.refreshResourceRoots();
		await this.pushLibraries();
	}

	async pushLibraries(): Promise<void> {
		const favSet = favoriteUriSet(await readFavorites());
		const libs = await listLibraries(this.context);
		this.deps.post({
			type: 'libraries',
			libraries: await Promise.all(libs.map((l) => toWebviewLibrary(this.deps.view()?.webview, l, favSet))),
		});
	}

	/** 推送随当前 Markdown 路径自动生成的素材库（无 MD 时清空） */
	async pushAutoLibraries(): Promise<void> {
		const favSet = favoriteUriSet(await readFavorites());
		const md = this.deps.currentMd();
		const libs = md ? await listAutoLibraries(md) : [];
		this.deps.post({
			type: 'autoLibraries',
			libraries: await Promise.all(libs.map((l) => toWebviewLibrary(this.deps.view()?.webview, l, favSet))),
		});
	}

	/**
	 * 右键素材缩略图：把图片以相对引用插入「生效页面」光标处。
	 * 生效页面 = 侧栏关联的 MD（currentMd）。仅当当前活动编辑器正是该 MD 时才插入，
	 * 否则忽略——避免插到小说原文、预览或别的文件里。
	 *
	 * 正文里已声明该图（已有 `![名](路径)` 指向同一文件）时，只插命名引用 `[名]`（沿用已有声明的 alt，
	 * 保证引用能对上声明）；否则插完整声明 `![alt](路径)`。对应「声明一次、多处引用」的写作流程。
	 */
	async insertImageRef(imageUri: string): Promise<void> {
		const md = this.deps.currentMd();
		const editor = vscode.window.activeTextEditor;
		if (!md || !editor || editor.document.uri.toString() !== md.toString()) {
			showTransientWarning('Image Flow：未插入——当前活动编辑器不是生效页面');
			return;
		}
		const mdDir = path.dirname(md.fsPath);
		const imgPath = vscode.Uri.parse(imageUri).fsPath;
		let rel = path.relative(mdDir, imgPath).split(path.sep).join('/');
		// 跨盘符时 path.relative 退回绝对路径（如 E:/foo.png），无法用相对引用表示。
		if (path.isAbsolute(rel)) {
			showTransientWarning('Image Flow：未插入——图片与文档不在同一磁盘，无法相对引用');
			return;
		}
		if (!rel.startsWith('.')) {
			rel = './' + rel;
		}
		// 正文已声明该图（声明路径解析到同一文件、且声明带非空 alt）时只插 `[名]` 引用。
		// 按解析后的绝对路径比对，兼容 `./x`、`x`、`<x>` 等不同写法都算同一图。
		const declared = parseMediaDecls(editor.document.getText()).find(
			(d) => d.alt && samePath(path.resolve(mdDir, d.path), imgPath)
		);
		if (declared) {
			await editor.edit((b) => b.insert(editor.selection.active, `[${declared.alt}]`));
			await editor.document.save();
			return;
		}
		// 图片旁有同主名 .md 描述文件时，描述在前、图片引用紧随其后一并写进正文
		// （buildPrompt 拼提示词时自然包含），如：- [某角色] 描述文字。![alt](路径)
		const desc = await readImageDesc(imageUri);
		// alt 优先用描述里的别名（如 `[九胡]` → 九胡），与正文命名引用对齐；无别名退回文件主名。
		const alt = aliasFromDesc(desc) || path.basename(imgPath, path.extname(imgPath));
		// 路径含空格或半角括号时用尖括号包裹，否则 Markdown 会在空格处截断或被 ) 提前闭合。
		// 中文/全角括号对 CommonMark 是普通字符，无需处理，保持可读。
		const dest = /[ ()]/.test(rel) ? `<${rel}>` : rel;
		let snippet = `![${alt}](${dest})`;
		if (desc) {
			snippet = desc + snippet;
		}
		// 首次插入的是整行声明（含可能的描述），末尾补一个换行让其独占一行、光标落到下一行；
		// 后续只插 `[名]` 引用（上面的 declared 分支）是行内片段，不加换行。
		await editor.edit((b) => b.insert(editor.selection.active, snippet + '\n'));
		await editor.document.save();
	}
}
