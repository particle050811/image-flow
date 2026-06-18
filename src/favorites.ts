import * as vscode from 'vscode';
import { workspaceRoot } from './storage';
import type { FavoritesData, FavoriteCollection } from './shared';

/** 默认收藏夹固定 id：不可删、各处回落目标 */
export const DEFAULT_COLLECTION_ID = 'c_default';

/** 全新/空收藏：仅含一个默认夹且为当前 */
export function emptyFavorites(now: number): FavoritesData {
	return {
		version: 2,
		activeCollectionId: DEFAULT_COLLECTION_ID,
		collections: [{ id: DEFAULT_COLLECTION_ID, name: '默认收藏', createdAt: now, items: [] }],
	};
}

/** 把任意读到的内容规整为 v2；旧版 {items:[...]} 包成默认夹，坏数据回落空收藏 */
export function migrateFavorites(raw: unknown, now: number): FavoritesData {
	if (raw && typeof raw === 'object') {
		const obj = raw as Record<string, unknown>;
		if (obj.version === 2 && Array.isArray(obj.collections)) {
			const base = emptyFavorites(now);
			const data: FavoritesData = {
				version: 2,
				activeCollectionId: typeof obj.activeCollectionId === 'string'
					? obj.activeCollectionId
					: DEFAULT_COLLECTION_ID,
				collections: obj.collections as FavoriteCollection[],
			};
			if (!data.collections.some((c) => c.id === DEFAULT_COLLECTION_ID)) {
				data.collections.unshift(base.collections[0]);
			}
			return setActiveCollection(data, data.activeCollectionId);
		}
		if (Array.isArray(obj.items)) {
			const d = emptyFavorites(now);
			d.collections[0].items = (obj.items as { path?: string; uri?: string; note?: string; addedAt?: number }[])
				.map((i) => ({ uri: i.uri ?? i.path ?? '', note: i.note, addedAt: i.addedAt ?? now }))
				.filter((i) => i.uri);
			return d;
		}
	}
	return emptyFavorites(now);
}

/** 所有夹中被收藏的 uri 集合（用于星标回显 / 去重判断） */
export function favoriteUriSet(data: FavoritesData): Set<string> {
	const set = new Set<string>();
	for (const c of data.collections) {
		for (const it of c.items) {
			set.add(it.uri);
		}
	}
	return set;
}

/** 从所有夹移除某 uri（内部用） */
function removeUri(data: FavoritesData, uri: string): FavoritesData {
	return {
		...data,
		collections: data.collections.map((c) => ({ ...c, items: c.items.filter((i) => i.uri !== uri) })),
	};
}

/** 解析有效的当前夹 id；不存在则默认 */
function resolveActive(data: FavoritesData): string {
	return data.collections.some((c) => c.id === data.activeCollectionId)
		? data.activeCollectionId
		: DEFAULT_COLLECTION_ID;
}

/** 左键：已收藏则取消（从所有夹移除），否则加入当前夹 */
export function toggleFavorite(data: FavoritesData, uri: string, now: number): FavoritesData {
	if (favoriteUriSet(data).has(uri)) {
		return removeUri(data, uri);
	}
	const active = resolveActive(data);
	return {
		...data,
		collections: data.collections.map((c) =>
			c.id === active ? { ...c, items: [...c.items, { uri, addedAt: now }] } : c
		),
	};
}

/** 右键：移动到指定夹（先从所有夹移除再加入目标夹，保证一图归一组、不重复） */
export function moveFavorite(data: FavoritesData, uri: string, collectionId: string, now: number): FavoritesData {
	const removed = removeUri(data, uri);
	return {
		...removed,
		collections: removed.collections.map((c) =>
			c.id === collectionId ? { ...c, items: [...c.items, { uri, addedAt: now }] } : c
		),
	};
}

/** 新建夹：id = c_<毫秒时间戳>，追加在末尾，不改变当前夹 */
export function createCollection(data: FavoritesData, name: string, now: number): FavoritesData {
	return {
		...data,
		collections: [...data.collections, { id: `c_${now}`, name: name.trim() || '未命名', createdAt: now, items: [] }],
	};
}

/** 重命名：只改 name */
export function renameCollection(data: FavoritesData, id: string, name: string): FavoritesData {
	return {
		...data,
		collections: data.collections.map((c) => (c.id === id ? { ...c, name: name.trim() || c.name } : c)),
	};
}

/** 删除夹：拒删默认夹；moveToDefault 时把图并入默认夹；删当前夹则当前回落默认 */
export function deleteCollection(data: FavoritesData, id: string, moveToDefault: boolean): FavoritesData {
	if (id === DEFAULT_COLLECTION_ID) {
		return data;
	}
	const victim = data.collections.find((c) => c.id === id);
	if (!victim) {
		return data;
	}
	let collections = data.collections.filter((c) => c.id !== id);
	if (moveToDefault && victim.items.length) {
		collections = collections.map((c) =>
			c.id === DEFAULT_COLLECTION_ID
				? { ...c, items: [...c.items, ...victim.items.filter((vi) => !c.items.some((i) => i.uri === vi.uri))] }
				: c
		);
	}
	const activeCollectionId = data.activeCollectionId === id ? DEFAULT_COLLECTION_ID : data.activeCollectionId;
	return { ...data, collections, activeCollectionId };
}

/** 设为当前夹：不存在的 id 回落默认 */
export function setActiveCollection(data: FavoritesData, id: string): FavoritesData {
	return { ...data, activeCollectionId: data.collections.some((c) => c.id === id) ? id : DEFAULT_COLLECTION_ID };
}

/** 导出重名去重：a.png 占用则 a-1.png、a-2.png… */
export function dedupeName(used: Set<string>, name: string): string {
	if (!used.has(name)) {
		return name;
	}
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	let n = 1;
	while (used.has(`${stem}-${n}${ext}`)) {
		n++;
	}
	return `${stem}-${n}${ext}`;
}

/** favorites.json 的 Uri（无工作区返回 undefined） */
function favoritesFile(): vscode.Uri | undefined {
	const root = workspaceRoot();
	return root ? vscode.Uri.joinPath(root, '.image-flow', 'favorites.json') : undefined;
}

/** 读并迁移；文件不存在或解析失败回落空收藏 */
export async function readFavorites(): Promise<FavoritesData> {
	const file = favoritesFile();
	if (!file) {
		return emptyFavorites(Date.now());
	}
	try {
		const bytes = await vscode.workspace.fs.readFile(file);
		return migrateFavorites(JSON.parse(Buffer.from(bytes).toString('utf8')), Date.now());
	} catch {
		return emptyFavorites(Date.now());
	}
}

// 写串行链：连续 mutate 排队执行，避免并发读-改-写丢更新
let writeChain: Promise<FavoritesData> = Promise.resolve(emptyFavorites(Date.now()));

/** 串行地读 → 应用变换 → 写回，返回写入后的最新数据 */
export function mutateFavorites(fn: (d: FavoritesData) => FavoritesData): Promise<FavoritesData> {
	writeChain = writeChain.then(async () => {
		const file = favoritesFile();
		const next = fn(await readFavorites());
		if (file) {
			await vscode.workspace.fs.writeFile(
				file,
				Buffer.from(JSON.stringify(next, null, 2), 'utf8')
			);
		}
		return next;
	});
	return writeChain;
}

/** 悬空过滤（仅用于展示，不改盘）：去掉文件已不存在的收藏项 */
export async function pruneMissing(data: FavoritesData): Promise<FavoritesData> {
	const exists = async (uri: string) => {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
			return true;
		} catch {
			return false;
		}
	};
	const collections = await Promise.all(
		data.collections.map(async (c) => {
			const keep = await Promise.all(c.items.map((i) => exists(i.uri)));
			return { ...c, items: c.items.filter((_, idx) => keep[idx]) };
		})
	);
	return { ...data, collections };
}
