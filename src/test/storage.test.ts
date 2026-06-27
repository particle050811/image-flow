import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { thumbKeyOf } from '../storage/thumbs';
import { mdStems, imageStem, sortDescFirst, readImageDesc, aliasFromDesc } from '../storage/materials';

suite('thumbKeyOf', () => {
	test('同输入稳定，uri/mtime/size 任一变化即换 key', () => {
		const k = thumbKeyOf('file:///a.png', 100, 200);
		assert.strictEqual(k, thumbKeyOf('file:///a.png', 100, 200));
		assert.match(k, /^[0-9a-f]{40}$/);
		assert.notStrictEqual(k, thumbKeyOf('file:///b.png', 100, 200));
		assert.notStrictEqual(k, thumbKeyOf('file:///a.png', 101, 200));
		assert.notStrictEqual(k, thumbKeyOf('file:///a.png', 100, 201));
	});
});

suite('materials 同名 MD 描述', () => {
	const file = vscode.FileType.File;
	const dir = vscode.FileType.Directory;
	test('mdStems 收集 .md 主名，大小写不敏感，忽略目录与非 md', () => {
		const stems = mdStems([
			['Foo.MD', file],
			['bar.md', file],
			['baz.png', file],
			['sub.md', dir],
		]);
		assert.deepStrictEqual([...stems].sort(), ['bar', 'foo']);
	});
	test('imageStem 去扩展名并小写，无扩展名/点开头不误切', () => {
		assert.strictEqual(imageStem('Foo.PNG'), 'foo');
		assert.strictEqual(imageStem('a.b.png'), 'a.b');
		assert.strictEqual(imageStem('noext'), 'noext');
		assert.strictEqual(imageStem('.hidden'), '.hidden');
	});
	test('sortDescFirst 有描述的排前面，组内保持原序', () => {
		const sorted = sortDescFirst([
			{ name: 'a.png', uri: 'a' },
			{ name: 'b.png', uri: 'b', hasDesc: true },
			{ name: 'c.png', uri: 'c' },
			{ name: 'd.png', uri: 'd', hasDesc: true },
		]);
		assert.deepStrictEqual(
			sorted.map((i) => i.name),
			['b.png', 'd.png', 'a.png', 'c.png']
		);
	});
	test('aliasFromDesc 取首个方括号别名，无方括号返回空串', () => {
		assert.strictEqual(aliasFromDesc('- [九胡] 酒狐女仆，狐耳少女。'), '九胡');
		assert.strictEqual(aliasFromDesc('[李樱] 一手持[传送石]'), '李樱');
		assert.strictEqual(aliasFromDesc('一张没有别名的描述'), '');
		assert.strictEqual(aliasFromDesc(''), '');
	});
	test('readImageDesc 大小写不匹配也能读到，缺失返回空串', async () => {
		const tmp = vscode.Uri.file(
			path.join(os.tmpdir(), `imageflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		);
		await vscode.workspace.fs.createDirectory(tmp);
		try {
			const img = vscode.Uri.joinPath(tmp, 'Foo.PNG');
			await vscode.workspace.fs.writeFile(img, new Uint8Array([0]));
			// 与图片主名大小写不一致的描述文件，仍按小写口径匹配（与 hasDesc 打标一致）
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(tmp, 'foo.md'),
				Buffer.from('  一张测试图\n', 'utf8')
			);
			assert.strictEqual(await readImageDesc(img.toString()), '一张测试图');

			const noDesc = vscode.Uri.joinPath(tmp, 'bare.png');
			await vscode.workspace.fs.writeFile(noDesc, new Uint8Array([0]));
			assert.strictEqual(await readImageDesc(noDesc.toString()), '');
		} finally {
			await vscode.workspace.fs.delete(tmp, { recursive: true });
		}
	});
});
