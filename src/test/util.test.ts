import * as assert from 'assert';
import { isImageExt, isImageFileName, mimeOf, mediaTypeOf, isMediaExt, isMediaFileName, mediaTypeOfFileName } from '../util/images';
import { namedRefSnippet, mediaDeclSnippet } from '../refs';

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
