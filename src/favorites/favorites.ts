import * as vscode from 'vscode';
import { workspaceRoot } from '../storage/storage';
import type { FavoritesData, FavoriteCollection, FavoriteItem } from '../shared';

/** 初始默认收藏夹的固定 id（全新用户的第一个夹、删除时的优先归并目标）。可被删除，不再是不可删锚点 */
export const DEFAULT_COLLECTION_ID = 'c_default';

/** 全新/空收藏：仅含一个默认夹且为当前 */
export function emptyFavorites(now: number): FavoritesData {
	return {
		version: 2,
		activeCollectionId: DEFAULT_COLLECTION_ID,
		collections: [{ id: DEFAULT_COLLECTION_ID, name: '默认收藏', createdAt: now, items: [] }],
	};
}

/** 规整一条收藏项：缺 uri 视为坏数据（由调用方过滤掉），note/addedAt 补默认 */
function normalizeItem(raw: unknown, now: number): FavoriteItem | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const i = raw as Record<string, unknown>;
	const uri = typeof i.uri === 'string' ? i.uri : typeof i.path === 'string' ? i.path : '';
	if (!uri) {
		return undefined;
	}
	return {
		uri,
		note: typeof i.note === 'string' ? i.note : undefined,
		addedAt: typeof i.addedAt === 'number' ? i.addedAt : now,
	};
}

/** 规整一个收藏夹：缺 id 视为坏数据（由调用方过滤掉），name/createdAt 补默认，items 逐项规整 */
function normalizeCollection(raw: unknown, now: number): FavoriteCollection | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const c = raw as Record<string, unknown>;
	if (typeof c.id !== 'string' || !c.id) {
		return undefined;
	}
	return {
		id: c.id,
		name: typeof c.name === 'string' && c.name ? c.name : '未命名',
		createdAt: typeof c.createdAt === 'number' ? c.createdAt : now,
		items: (Array.isArray(c.items) ? c.items : [])
			.map((i) => normalizeItem(i, now))
			.filter((i): i is FavoriteItem => i !== undefined),
		lastExportDir: typeof c.lastExportDir === 'string' ? c.lastExportDir : undefined,
	};
}

/** 把任意读到的内容规整为 v2；旧版 {items:[...]} 包成默认夹，坏数据回落空收藏 */
export function migrateFavorites(raw: unknown, now: number): FavoritesData {
	if (raw && typeof raw === 'object') {
		const obj = raw as Record<string, unknown>;
		if (obj.version === 2 && Array.isArray(obj.collections)) {
			// 逐项规整：手改 json / 跨版本可能留下缺 id、items 非数组等半坏数据，不能强转后直接遍历
			const collections = obj.collections
				.map((c) => normalizeCollection(c, now))
				.filter((c): c is FavoriteCollection => c !== undefined);
			const data: FavoritesData = {
				version: 2,
				activeCollectionId: typeof obj.activeCollectionId === 'string'
					? obj.activeCollectionId
					: DEFAULT_COLLECTION_ID,
				collections,
			};
			// 只保证"至少有一个夹"：全被过滤光了才补一个默认夹；不强行恢复用户已删的默认夹
			if (data.collections.length === 0) {
				data.collections.push(emptyFavorites(now).collections[0]);
			}
			return setActiveCollection(data, data.activeCollectionId);
		}
		if (Array.isArray(obj.items)) {
			const d = emptyFavorites(now);
			d.collections[0].items = obj.items
				.map((i) => normalizeItem(i, now))
				.filter((i): i is FavoriteItem => i !== undefined);
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

/** 解析有效的当前夹 id；失效时回落到第一个存在的夹（默认夹可能已被删，故不能固定回落 c_default） */
function resolveActive(data: FavoritesData): string {
	return data.collections.some((c) => c.id === data.activeCollectionId)
		? data.activeCollectionId
		: data.collections[0]?.id ?? DEFAULT_COLLECTION_ID;
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

/** 图片文件被重命名后：把所有夹中等于 oldUri 的项改写为 newUri（保留 note/addedAt） */
export function renameFavoriteUri(data: FavoritesData, oldUri: string, newUri: string): FavoritesData {
	return {
		...data,
		collections: data.collections.map((c) => ({
			...c,
			items: c.items.map((i) => (i.uri === oldUri ? { ...i, uri: newUri } : i)),
		})),
	};
}

/** 重命名：只改 name */
export function renameCollection(data: FavoritesData, id: string, name: string): FavoritesData {
	return {
		...data,
		collections: data.collections.map((c) => (c.id === id ? { ...c, name: name.trim() || c.name } : c)),
	};
}

/**
 * 删除 victimId 后，剩余夹中的归并目标 id：优先默认夹，否则剩余第一个夹。
 * provider 的删除确认弹窗（取目标夹名做标签）与 deleteCollection（实际归并）共用，保证两处一致。
 * 前提：删除后至少还剩一个夹（调用方已保证），故 rest[0] 必存在。
 */
export function mergeTargetId(collections: FavoriteCollection[], victimId: string): string {
	const rest = collections.filter((c) => c.id !== victimId);
	return rest.some((c) => c.id === DEFAULT_COLLECTION_ID) ? DEFAULT_COLLECTION_ID : rest[0].id;
}

/**
 * 删除夹：至少保留一个夹（只剩一个时拒删）；moveToDefault 时把图并入归并目标
 * （优先剩余的默认夹，删的就是默认夹/无默认夹时落到剩余第一个夹）；删当前夹则当前回落第一个夹。
 */
export function deleteCollection(data: FavoritesData, id: string, moveToDefault: boolean): FavoritesData {
	if (data.collections.length <= 1) {
		return data;
	}
	const victim = data.collections.find((c) => c.id === id);
	if (!victim) {
		return data;
	}
	let collections = data.collections.filter((c) => c.id !== id);
	if (moveToDefault && victim.items.length) {
		const targetId = mergeTargetId(data.collections, id);
		collections = collections.map((c) =>
			c.id === targetId
				? { ...c, items: [...c.items, ...victim.items.filter((vi) => !c.items.some((i) => i.uri === vi.uri))] }
				: c
		);
	}
	const next = { ...data, collections };
	return data.activeCollectionId === id ? setActiveCollection(next, collections[0].id) : next;
}

/** 设为当前夹：不存在的 id 回落到第一个存在的夹 */
export function setActiveCollection(data: FavoritesData, id: string): FavoritesData {
	return { ...data, activeCollectionId: data.collections.some((c) => c.id === id) ? id : resolveActive(data) };
}

/** 文件夹名非法字符（Windows 保留 + 控制字符）；收藏夹要作导出文件夹名，取名时据此拦截 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;

/**
 * 校验收藏夹名能否安全用作导出文件夹名：空、含非法字符、纯点（. / ..）均拒绝。
 * 合法返回 null，非法返回错误文案（供 showInputBox 的 validateInput 直接展示）。
 */
export function collectionNameError(name: string): string | null {
	const trimmed = name.trim();
	if (!trimmed) {
		return '名称不能为空。';
	}
	if (ILLEGAL_NAME_CHARS.test(trimmed)) {
		return '名称不能包含 \\ / : * ? " < > | 等字符。';
	}
	if (/^\.+$/.test(trimmed)) {
		return '名称不能只由点组成。';
	}
	return null;
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

// 写串行链：连续 mutate 排队执行，避免并发读-改-写丢更新。
// 链本身始终保持 resolved（末尾 catch 兜底），单次 IO 失败不会毒化后续写入。
let writeChain: Promise<unknown> = Promise.resolve();

/** 串行地读 → 应用变换 → 写回，返回写入后的最新数据；本次写失败会 reject 给调用方，但不阻断后续 mutate */
export function mutateFavorites(fn: (d: FavoritesData) => FavoritesData): Promise<FavoritesData> {
	const run = async (): Promise<FavoritesData> => {
		const file = favoritesFile();
		const next = fn(await readFavorites());
		if (file) {
			await vscode.workspace.fs.writeFile(
				file,
				Buffer.from(JSON.stringify(next, null, 2), 'utf8')
			);
		}
		return next;
	};
	// .then(run, run)：无论上一次成功或失败都接着执行本次；writeChain 用 catch 收尾保证恒 resolved
	const result = writeChain.then(run, run);
	writeChain = result.catch(() => undefined);
	return result;
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
