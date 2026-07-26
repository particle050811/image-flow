import * as assert from 'assert';
import { buildEditFinalPrompt, buildEditArchivePrompt } from '../prompt/edit';
import { EditSession } from '../prompt/editSession';
import { dedupeArchiveNames } from '../prompt/buildPrompt';
import { editConfigView } from '../ui/config';
import { baseConfig } from './fixtures';

suite('buildEditFinalPrompt', () => {
	test('全部图拼成顶部声明，命名引用替换为【@图片N】，前置注入句', () => {
		const config = { ...baseConfig, modelInjections: { 'gpt-image-2': '注入句' } };
		// 入参须为编辑视图（editModel = gpt-image-2），注入句按其中生效的模型取
		const out = buildEditFinalPrompt(editConfigView(config), '把[狗]放进[猫]的场景', ['猫.png', '狗.png']);
		assert.strictEqual(out, '注入句\n\n把【@图片2】放进【@图片1】的场景');
	});
	test('CLI 按次覆盖模型后，注入句跟着切到覆盖后的模型', () => {
		const config = {
			...baseConfig,
			modelInjections: { 'gpt-image-2': '编辑页模型注入句', 'nano-banana-2': '覆盖后模型注入句' },
		};
		// 模拟 tasks.submitEdit 的合成：编辑视图（editModel = gpt-image-2）再叠 CLI 的 --model 覆盖
		const overridden = { ...editConfigView(config), model: 'nano-banana-2' };
		const out = buildEditFinalPrompt(overridden, '看[猫]', ['猫.png']);
		assert.strictEqual(out, '覆盖后模型注入句\n\n看【@图片1】');
		// 不覆盖时仍取编辑页模型的注入句
		assert.strictEqual(
			buildEditFinalPrompt(editConfigView(config), '看[猫]', ['猫.png']),
			'编辑页模型注入句\n\n看【@图片1】'
		);
	});
	test('无注入句时只剩替换后的正文', () => {
		const out = buildEditFinalPrompt(editConfigView(baseConfig), '看[猫]', ['猫.png']);
		assert.strictEqual(out, '看【@图片1】');
	});
	test('编辑区有图但正文一次都没引用 → 不拦截，声明被删后仅剩正文', () => {
		const out = buildEditFinalPrompt(editConfigView(baseConfig), '纯文本', ['猫.png']);
		assert.strictEqual(out, '纯文本');
	});
	test('含空格文件名的声明用尖括号包裹，引用按主名匹配', () => {
		const out = buildEditFinalPrompt(editConfigView(baseConfig), '看[狗 (1)]', ['狗 (1).png']);
		assert.strictEqual(out, '看【@图片1】');
	});
});

suite('buildEditArchivePrompt', () => {
	test('前置全部图声明 ![名](input/原名) + 命名引用正文，供右键重生成', () => {
		const names = ['猫.png', '狗.png'];
		const fileNames = dedupeArchiveNames(names);
		const out = buildEditArchivePrompt('把[狗]放进[猫]', names, fileNames);
		assert.strictEqual(out, '![猫](input/猫.png)\n![狗](input/狗.png)\n把[狗]放进[猫]');
	});
	test('含空格文件名声明用尖括号包裹', () => {
		const out = buildEditArchivePrompt('看[狗 (1)]', ['狗 (1).png'], ['狗 (1).png']);
		assert.strictEqual(out, '![狗 (1)](<input/狗 (1).png>)\n看[狗 (1)]');
	});
	test('无图时仅正文', () => {
		assert.strictEqual(buildEditArchivePrompt('纯文本', [], []), '纯文本');
	});
});

suite('EditSession', () => {
	const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
	test('addData 正常添加并保持顺序', () => {
		const s = new EditSession();
		assert.strictEqual(s.addData('a.png', png), null);
		assert.strictEqual(s.addData('b.png', png), null);
		assert.deepStrictEqual(s.list().map((i) => i.name), ['a.png', 'b.png']);
	});
	test('重名拒绝并返回错误消息', () => {
		const s = new EditSession();
		s.addData('a.png', png);
		const err = s.addData('a.png', png);
		assert.ok(err && /a\.png/.test(err));
		assert.strictEqual(s.list().length, 1);
	});
	test('非图片扩展名拒绝', () => {
		const s = new EditSession();
		assert.ok(s.addData('a.txt', png));
	});
	test('非图片 data URI 拒绝', () => {
		const s = new EditSession();
		assert.ok(s.addData('a.png', 'data:text/plain;base64,eA=='));
	});
	test('同主名异扩展拒绝（命名引用会冲突）', () => {
		const s = new EditSession();
		assert.strictEqual(s.addData('logo.png', png), null);
		const err = s.addData('logo.jpg', png);
		assert.ok(err && /logo/.test(err));
		assert.strictEqual(s.list().length, 1);
	});
	test('remove 按名移除', () => {
		const s = new EditSession();
		s.addData('a.png', png);
		s.addData('b.png', png);
		s.remove('a.png');
		assert.deepStrictEqual(s.list().map((i) => i.name), ['b.png']);
	});
	test('needsDisplay：大图需要、小图/gif/已有展示图不需要', () => {
		const s = new EditSession();
		const big = `data:image/png;base64,${'A'.repeat(200 * 1024)}`;
		const bigGif = `data:image/gif;base64,${'A'.repeat(200 * 1024)}`;
		s.addData('big.png', big);
		s.addData('small.png', png);
		s.addData('anim.gif', bigGif);
		const [bigImg, smallImg, gifImg] = s.list();
		assert.strictEqual(s.needsDisplay(bigImg), true);
		assert.strictEqual(s.needsDisplay(smallImg), false);
		assert.strictEqual(s.needsDisplay(gifImg), false);
		s.setDisplay('big.png', big.length, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.needsDisplay(bigImg), false);
	});
	test('setDisplay 只接受 webp data URI 且校验原图指纹，不动原图 data', () => {
		const s = new EditSession();
		s.addData('a.png', png);
		s.setDisplay('a.png', png.length, 'data:image/png;base64,eA==');
		assert.strictEqual(s.list()[0].display, undefined);
		// 指纹（原图长度）不匹配：同名换图后的过期回传应被丢弃
		s.setDisplay('a.png', png.length + 1, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.list()[0].display, undefined);
		s.setDisplay('a.png', png.length, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.list()[0].display, 'data:image/webp;base64,eA==');
		assert.strictEqual(s.list()[0].data, png);
		// 不存在的名字静默忽略
		s.setDisplay('ghost.png', 1, 'data:image/webp;base64,eA==');
	});
});
