import * as vscode from 'vscode';
import { uriBaseName } from './paths';
import { workspaceRoot } from './storage';
import {
	readFavorites,
	mutateFavorites,
	toggleFavorite,
	moveFavorite,
	createCollection,
	renameCollection,
	deleteCollection,
	mergeTargetId,
	setActiveCollection,
	dedupeName,
	collectionNameError,
} from './favorites';
import type { InboundMessage } from './shared';

/** 收藏夹控制器依赖：错误提示与视图推送仍由 SidebarProvider 持有，经回调回去 */
export interface FavoritesDeps {
	post(msg: InboundMessage): void;
	/** 仅重推收藏页 */
	pushFavorites(): Promise<void>;
	/** 收藏变化后重推收藏页 + 所有带星标的列表 */
	pushAfterChange(): Promise<void>;
}

/**
 * 收藏夹相关的消息处理：收藏切换/移动 + 收藏夹 CRUD + 导出。
 * 把这些自带 showInputBox/showWarningMessage/showOpenDialog 的交互逻辑从 SidebarProvider 抽出，
 * 数据全经 favorites.ts，视图推送经 deps 回调，故不依赖 Provider 的其它状态。
 */
export class FavoritesController {
	constructor(private readonly deps: FavoritesDeps) {}

	async toggle(uri: string): Promise<void> {
		await mutateFavorites((d) => toggleFavorite(d, uri, Date.now()));
		await this.deps.pushAfterChange();
	}

	async move(uri: string, collectionId: string): Promise<void> {
		await mutateFavorites((d) => moveFavorite(d, uri, collectionId, Date.now()));
		await this.deps.pushAfterChange();
	}

	async setActive(collectionId: string): Promise<void> {
		await mutateFavorites((d) => setActiveCollection(d, collectionId));
		await this.deps.pushFavorites();
	}

	async create(): Promise<void> {
		// webview 禁用 window.prompt，统一用扩展宿主原生输入框取名
		const name = await vscode.window.showInputBox({
			prompt: '新收藏夹名称',
			placeHolder: '例如：产品主图',
			validateInput: collectionNameError,
		});
		if (name?.trim()) {
			await mutateFavorites((d) => createCollection(d, name, Date.now()));
			await this.deps.pushFavorites();
		}
	}

	async rename(id: string): Promise<void> {
		const col = (await readFavorites()).collections.find((c) => c.id === id);
		if (!col) {
			return;
		}
		const name = await vscode.window.showInputBox({
			prompt: '重命名收藏夹',
			value: col.name,
			validateInput: collectionNameError,
		});
		if (name?.trim() && name.trim() !== col.name) {
			await mutateFavorites((d) => renameCollection(d, id, name));
			await this.deps.pushFavorites();
		}
	}

	async delete(id: string): Promise<void> {
		const all = (await readFavorites()).collections;
		const col = all.find((c) => c.id === id);
		if (!col) {
			return;
		}
		if (all.length <= 1) {
			this.deps.post({ type: 'error', message: '至少保留一个收藏夹，无法删除最后一个。' });
			return;
		}
		let moveToDefault = false;
		if (col.items.length > 0) {
			// 归并目标：删后剩余夹中优先默认夹，否则第一个夹——与 deleteCollection 共用 mergeTargetId 保证一致
			const targetId = mergeTargetId(all, id);
			const target = all.find((c) => c.id === targetId)!;
			const moveLabel = `移到「${target.name}」并删除`;
			const pick = await vscode.window.showWarningMessage(
				`删除收藏夹「${col.name}」？内含 ${col.items.length} 张图。`,
				{ modal: true },
				moveLabel,
				'直接删除'
			);
			if (!pick) {
				return; // 用户取消
			}
			moveToDefault = pick === moveLabel;
		}
		await mutateFavorites((d) => deleteCollection(d, id, moveToDefault));
		await this.deps.pushAfterChange();
	}

	async export(collectionId: string): Promise<void> {
		const data = await readFavorites();
		const col = data.collections.find((c) => c.id === collectionId);
		if (!col || col.items.length === 0) {
			this.deps.post({ type: 'error', message: '该收藏夹没有图片可导出。' });
			return;
		}
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			// 该夹上次导出的父目录，没有则回落工作区根
			defaultUri: col.lastExportDir ? vscode.Uri.parse(col.lastExportDir) : workspaceRoot(),
			openLabel: '在此处新建收藏夹文件夹',
		});
		if (!picked?.length) {
			return;
		}
		// 记住本次选定的父目录，下次该夹导出默认回到这里（落 favorites.json，按夹各记一个）
		await mutateFavorites((d) => ({
			...d,
			collections: d.collections.map((c) =>
				c.id === collectionId ? { ...c, lastExportDir: picked[0].toString() } : c
			),
		}));
		// 在所选目录下新建以收藏夹命名的子文件夹（清洗 Windows 非法字符），图片导出其中
		const safeName = col.name.replace(/[\\/:*?"<>|]/g, '_').trim() || '收藏夹';
		const dest = vscode.Uri.joinPath(picked[0], safeName);
		await vscode.workspace.fs.createDirectory(dest);
		const used = new Set<string>();
		let ok = 0;
		let skipped = 0;
		for (const item of col.items) {
			const src = vscode.Uri.parse(item.uri);
			const name = dedupeName(used, uriBaseName(src));
			used.add(name);
			try {
				await vscode.workspace.fs.copy(src, vscode.Uri.joinPath(dest, name), { overwrite: false });
				ok++;
			} catch {
				skipped++; // 源缺失/复制失败
			}
		}
		void vscode.window.showInformationMessage(`已导出 ${ok} 张${skipped ? `，跳过 ${skipped} 张` : ''}。`);
	}
}
