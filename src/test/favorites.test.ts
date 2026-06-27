import * as assert from 'assert';
import {
	DEFAULT_COLLECTION_ID,
	emptyFavorites,
	migrateFavorites,
	favoriteUriSet,
	toggleFavorite,
	moveFavorite,
	renameFavoriteUri,
	createCollection,
	renameCollection,
	deleteCollection,
	setActiveCollection,
	dedupeName,
	collectionNameError,
} from '../favorites/favorites';

suite('favorites', () => {
	const now = 1750000000000;
	const u = (n: string) => `file:///d%3A/proj/.image-flow/tasks/1/${n}.png`;

	test('emptyFavorites 含默认夹且为当前', () => {
		const d = emptyFavorites(now);
		assert.strictEqual(d.version, 2);
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].id, DEFAULT_COLLECTION_ID);
		assert.deepStrictEqual(d.collections[0].items, []);
	});

	test('migrateFavorites 旧版 items 包成默认夹', () => {
		const raw = { items: [{ path: 'x', addedAt: 1 }] };
		const d = migrateFavorites(raw, now);
		assert.strictEqual(d.version, 2);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].id, DEFAULT_COLLECTION_ID);
	});

	test('migrateFavorites 已是 v2 原样保留', () => {
		const v2 = emptyFavorites(now);
		v2.collections[0].items.push({ uri: u('a'), addedAt: 1 });
		const d = migrateFavorites(v2, now);
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('migrateFavorites 空/坏输入回落空收藏', () => {
		assert.strictEqual(migrateFavorites(undefined, now).collections.length, 1);
		assert.strictEqual(migrateFavorites('garbage', now).collections.length, 1);
	});

	test('migrateFavorites v2 半坏数据：丢弃无 id 的夹、items 非数组置空、丢弃无 uri 的项', () => {
		const raw = {
			version: 2,
			activeCollectionId: DEFAULT_COLLECTION_ID,
			collections: [
				{ id: DEFAULT_COLLECTION_ID, name: '默认收藏', createdAt: 1, items: 'oops' },
				{ name: '无id', items: [] },
				{ id: 'c_x', name: 'X', items: [{ uri: u('a') }, { note: '无uri' }] },
			],
		};
		const d = migrateFavorites(raw, now);
		assert.strictEqual(d.collections.length, 2); // 无 id 的夹被丢弃
		const def = d.collections.find((c) => c.id === DEFAULT_COLLECTION_ID)!;
		assert.deepStrictEqual(def.items, []); // items 非数组 → []
		const cx = d.collections.find((c) => c.id === 'c_x')!;
		assert.strictEqual(cx.items.length, 1); // 无 uri 的项被丢弃
		assert.strictEqual(cx.items[0].addedAt, now); // addedAt 缺失补默认
	});

	test('toggleFavorite 未收藏则加入当前夹', () => {
		const d = toggleFavorite(emptyFavorites(now), u('a'), now);
		assert.ok(favoriteUriSet(d).has(u('a')));
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('toggleFavorite 已收藏则从所有夹移除', () => {
		let d = toggleFavorite(emptyFavorites(now), u('a'), now);
		d = toggleFavorite(d, u('a'), now);
		assert.ok(!favoriteUriSet(d).has(u('a')));
	});

	test('moveFavorite 从原夹移到目标夹（一图归一组）', () => {
		let d = createCollection(emptyFavorites(now), '产品图', now);
		const target = d.collections[1].id;
		d = toggleFavorite(d, u('a'), now); // 进默认夹
		d = moveFavorite(d, u('a'), target, now);
		assert.strictEqual(d.collections[0].items.length, 0);
		assert.strictEqual(d.collections[1].items.length, 1);
		// 不重复：移到同一图两次仍只在目标夹一份
		d = moveFavorite(d, u('a'), target, now);
		assert.strictEqual(d.collections[1].items.length, 1);
	});

	test('createCollection 用 c_<时间戳> id 且不设为当前', () => {
		const d = createCollection(emptyFavorites(now), '新夹', now);
		assert.strictEqual(d.collections.length, 2);
		assert.strictEqual(d.collections[1].id, `c_${now}`);
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
	});

	test('renameCollection 只改 name 不改 id', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = renameCollection(d, id, 'B');
		assert.strictEqual(d.collections[1].id, id);
		assert.strictEqual(d.collections[1].name, 'B');
	});

	test('renameFavoriteUri 改写所有夹中的旧 uri 并保留收藏信息', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = moveFavorite(d, u('old'), id, now);
		d = renameFavoriteUri(d, u('old'), u('new'));
		assert.ok(!favoriteUriSet(d).has(u('old')));
		assert.ok(favoriteUriSet(d).has(u('new')));
		assert.strictEqual(d.collections[1].items[0].addedAt, now);
	});

	test('deleteCollection 只剩一个夹时拒删', () => {
		const d = deleteCollection(emptyFavorites(now), DEFAULT_COLLECTION_ID, false);
		assert.strictEqual(d.collections.length, 1);
	});

	test('deleteCollection 仍有其它夹时可删默认夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		d = deleteCollection(d, DEFAULT_COLLECTION_ID, false);
		assert.strictEqual(d.collections.length, 1);
		assert.ok(!d.collections.some((c) => c.id === DEFAULT_COLLECTION_ID));
	});

	test('deleteCollection moveToDefault 把图并入默认夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = moveFavorite(d, u('a'), id, now);
		d = deleteCollection(d, id, true);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('deleteCollection 删默认夹时图并入剩余第一个夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		d = toggleFavorite(d, u('a'), now); // 进默认夹
		d = deleteCollection(d, DEFAULT_COLLECTION_ID, true);
		assert.strictEqual(d.collections.length, 1);
		assert.strictEqual(d.collections[0].name, 'A');
		assert.strictEqual(d.collections[0].items.length, 1);
	});

	test('deleteCollection 删当前夹后当前回落剩余第一个夹', () => {
		let d = createCollection(emptyFavorites(now), 'A', now);
		const id = d.collections[1].id;
		d = setActiveCollection(d, id);
		d = deleteCollection(d, id, false);
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
	});

	test('setActiveCollection 不存在的 id 回落第一个夹', () => {
		const d = setActiveCollection(emptyFavorites(now), 'c_nope');
		assert.strictEqual(d.activeCollectionId, DEFAULT_COLLECTION_ID);
	});

	test('migrateFavorites v2 缺默认夹不强行恢复（尊重用户删除）', () => {
		const raw = {
			version: 2,
			activeCollectionId: 'c_x',
			collections: [{ id: 'c_x', name: 'X', createdAt: 1, items: [] }],
		};
		const d = migrateFavorites(raw, now);
		assert.strictEqual(d.collections.length, 1);
		assert.ok(!d.collections.some((c) => c.id === DEFAULT_COLLECTION_ID));
		assert.strictEqual(d.activeCollectionId, 'c_x');
	});

	test('dedupeName 重名追加序号', () => {
		const used = new Set(['a.png']);
		assert.strictEqual(dedupeName(used, 'a.png'), 'a-1.png');
		used.add('a-1.png');
		assert.strictEqual(dedupeName(used, 'a.png'), 'a-2.png');
		assert.strictEqual(dedupeName(used, 'b.png'), 'b.png');
	});

	test('collectionNameError 拦截空名与非法文件夹字符', () => {
		assert.strictEqual(collectionNameError('产品主图'), null);
		assert.ok(collectionNameError(''));
		assert.ok(collectionNameError('   '));
		assert.ok(collectionNameError('a/b'));
		assert.ok(collectionNameError('a:b'));
		assert.ok(collectionNameError('a*?"<>|b'));
		assert.ok(collectionNameError('..'));
	});
});
