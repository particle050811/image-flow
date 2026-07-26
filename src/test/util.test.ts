import * as assert from 'assert';
import { isImageExt, isImageFileName, mimeOf, mediaTypeOf, isMediaExt, isMediaFileName, mediaTypeOfFileName } from '../util/images';
import { namedRefSnippet, mediaDeclSnippet } from '../refs';
import { checkMediaBytes, checkMediaCount, approxDataUriBytes, CLI_EDIT_LIMITS, REF_MEDIA_LIMITS } from '../util/mediaBytes';

suite('images', () => {
	test('isImageExt 大小写不敏感、白名单内外', () => {
		assert.ok(isImageExt('.png'));
		assert.ok(isImageExt('.JPG'));
		assert.ok(!isImageExt('.txt'));
		assert.ok(!isImageExt(''));
	});
	test('mimeOf 已知映射与未知回退', () => {
		assert.strictEqual(mimeOf('.jpeg'), 'image/jpeg');
		assert.strictEqual(mimeOf('.bmp'), 'image/png');
	});
	test('isImageFileName 按文件名扩展名判断', () => {
		assert.ok(isImageFileName('a.png'));
		assert.ok(isImageFileName('封面.JPEG'));
		assert.ok(!isImageFileName('readme.md'));
		assert.ok(!isImageFileName('noext'));
	});
	test('isMediaExt 放行图/音/视、拒非媒体', () => {
		assert.ok(isMediaExt('.png'));
		assert.ok(isMediaExt('.MP3'));
		assert.ok(isMediaExt('.mp4'));
		assert.ok(!isMediaExt('.txt'));
		assert.ok(!isMediaExt(''));
	});
	test('isMediaFileName 按文件名判断（含大小写）', () => {
		assert.ok(isMediaFileName('a.png'));
		assert.ok(isMediaFileName('酒狐示例音声.MP3'));
		assert.ok(isMediaFileName('clip.MP4'));
		assert.ok(!isMediaFileName('readme.md'));
		assert.ok(!isMediaFileName('noext'));
	});
	test('mediaTypeOfFileName 按文件名归类、未知回退 image', () => {
		assert.strictEqual(mediaTypeOfFileName('a.PNG'), 'image');
		assert.strictEqual(mediaTypeOfFileName('bgm.mp3'), 'audio');
		assert.strictEqual(mediaTypeOfFileName('clip.MOV'), 'video');
		assert.strictEqual(mediaTypeOfFileName('noext'), 'image');
	});
});

suite('mediaTypeOf', () => {
	test('图片扩展名归 image', () => {
		assert.strictEqual(mediaTypeOf('.png'), 'image');
		assert.strictEqual(mediaTypeOf('.JPG'), 'image');
	});
	test('音频扩展名归 audio', () => {
		assert.strictEqual(mediaTypeOf('.mp3'), 'audio');
		assert.strictEqual(mediaTypeOf('.wav'), 'audio');
	});
	test('视频扩展名归 video', () => {
		assert.strictEqual(mediaTypeOf('.mp4'), 'video');
		assert.strictEqual(mediaTypeOf('.mov'), 'video');
	});
	test('未知扩展名回退 image', () => {
		assert.strictEqual(mediaTypeOf('.txt'), 'image');
	});
});

suite('namedRefSnippet', () => {
	test('去扩展名后用中括号包裹', () => {
		assert.strictEqual(namedRefSnippet('传送石.png'), '[传送石]');
	});
	test('含空格的文件名取主名', () => {
		assert.strictEqual(namedRefSnippet('my cat (1).png'), '[my cat (1)]');
	});
	test('无扩展名原样', () => {
		assert.strictEqual(namedRefSnippet('李樱'), '[李樱]');
	});
});

suite('mediaDeclSnippet', () => {
	test('普通文件名直接拼接', () => {
		assert.strictEqual(mediaDeclSnippet('猫', '猫.png'), '![猫](猫.png)');
	});
	test('含空格或半角括号的路径用尖括号包裹', () => {
		assert.strictEqual(mediaDeclSnippet('猫', 'my cat (1).png'), '![猫](<my cat (1).png>)');
	});
});

suite('checkMediaBytes', () => {
	const MB = 1024 * 1024;
	test('都在上限内返回 null', () => {
		assert.strictEqual(checkMediaBytes([{ name: 'a.png', size: 5 * MB }], CLI_EDIT_LIMITS), null);
		assert.strictEqual(checkMediaBytes([], CLI_EDIT_LIMITS), null);
	});
	test('超张数上限（仅严格档设了 maxCount）', () => {
		const items = Array.from({ length: 21 }, (_, i) => ({ name: `${i}.png`, size: 1 }));
		assert.match(checkMediaBytes(items, CLI_EDIT_LIMITS) ?? '', /最多 20 张，收到 21 张/);
		assert.strictEqual(checkMediaBytes(items, REF_MEDIA_LIMITS), null);
	});
	test('恰好等于上限放行，超 1 字节即拦（文案不与上限同数）', () => {
		assert.strictEqual(checkMediaBytes([{ name: 'a.png', size: 30 * MB }], CLI_EDIT_LIMITS), null);
		const msg = checkMediaBytes([{ name: 'a.png', size: 200 * MB + 1 }], REF_MEDIA_LIMITS) ?? '';
		assert.match(msg, /单个上限 200MB（200\.1MB）/);
	});
	test('宽松档合计 300MB：恰好等于放行，超出拦下', () => {
		const two = [
			{ name: 'a.mp4', size: 200 * MB },
			{ name: 'b.mp4', size: 100 * MB },
		];
		assert.strictEqual(checkMediaBytes(two, REF_MEDIA_LIMITS), null);
		assert.match(checkMediaBytes([...two, { name: 'c.mp3', size: 1 }], REF_MEDIA_LIMITS) ?? '', /合计超过 300MB/);
	});
	test('baseBytes 只计入合计、不参与单个上限复检', () => {
		// 编辑区已入列的图走这条路：基数远超单个上限也不该报老图的错，只在压爆合计时拦新图
		const base = 250 * MB;
		assert.strictEqual(checkMediaBytes([{ name: 'new.png', size: 40 * MB }], REF_MEDIA_LIMITS, base), null);
		const msg = checkMediaBytes([{ name: 'new.png', size: 60 * MB }], REF_MEDIA_LIMITS, base) ?? '';
		assert.match(msg, /合计超过 300MB/);
	});
	test('超单个上限报出文件名与实际大小', () => {
		const msg = checkMediaBytes([{ name: 'big.png', size: 31 * MB }], CLI_EDIT_LIMITS) ?? '';
		assert.match(msg, /单个上限 30MB（31MB）：big\.png/);
	});
	test('超合计上限', () => {
		const items = Array.from({ length: 3 }, (_, i) => ({ name: `${i}.png`, size: 25 * MB }));
		assert.match(checkMediaBytes(items, CLI_EDIT_LIMITS) ?? '', /合计超过 60MB/);
	});
	test('宽松档放行严格档拦掉的数十 MB 音视频参考', () => {
		const items = [
			{ name: 'clip.mp4', size: 80 * MB },
			{ name: 'bgm.mp3', size: 40 * MB },
		];
		assert.strictEqual(checkMediaBytes(items, REF_MEDIA_LIMITS), null);
		assert.ok(checkMediaBytes(items, CLI_EDIT_LIMITS));
	});
	test('宽松档仍拦明显传错的超大文件', () => {
		assert.match(checkMediaBytes([{ name: 'iso.mp4', size: 250 * MB }], REF_MEDIA_LIMITS) ?? '', /单个上限 200MB/);
	});
});

suite('checkMediaCount', () => {
	test('严格档按张数拦（CLI 预检据此在 stat 之前短路）', () => {
		assert.strictEqual(checkMediaCount(20, CLI_EDIT_LIMITS), null);
		assert.match(checkMediaCount(21, CLI_EDIT_LIMITS) ?? '', /最多 20 张，收到 21 张/);
	});
	test('无 maxCount 的宽松档恒放行', () => {
		assert.strictEqual(checkMediaCount(999, REF_MEDIA_LIMITS), null);
	});
});

suite('approxDataUriBytes', () => {
	test('按 base64 段折算近似字节数', () => {
		const raw = Buffer.from('x'.repeat(3000));
		const uri = `data:image/png;base64,${raw.toString('base64')}`;
		const bytes = approxDataUriBytes(uri);
		assert.ok(Math.abs(bytes - raw.length) <= 3, `折算值 ${bytes} 应接近 ${raw.length}`);
	});
});
