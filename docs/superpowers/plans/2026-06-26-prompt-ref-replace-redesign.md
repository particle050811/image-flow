# 提示词引用替换重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把提示词引用替换改为即梦 `【@图片N】` 格式，引入「命名引用」`[名字]`，并让编辑页复用同一套生成替换链路。

**Architecture:** 新增一套「媒体声明 + 命名引用」解析/替换（`parseMediaDecls` / `buildNameTable` / `replaceMediaRefs`），作用于发给模型的 prompt：`![alt](路径)` 声明被删除、按 alt 命名、按媒体类型（图片/音频/视频，扩展名区分）各自编号，正文里命中名字表的 `[名字]` 替换为 `【@图片N】`/`【@音频N】`/`【@视频N】`，未命中原样保留。参考图读盘与归档正文（`parseImageRefs`/`archiveImageRefs`）保持不变。编辑页提交时把编辑区全部图拼成顶部 `![名](文件名)` 声明，正文即工作台 MD 格式，复用 `replaceMediaRefs`，删除独立的 `buildEditPrompt`。

**Tech Stack:** TypeScript、VS Code 扩展、esbuild、mocha（vscode-test）。

---

## 设计约定（实现前先读）

- **媒体类型**：`type MediaType = 'image' | 'audio' | 'video'`。扩展名判定——音频集 → audio，视频集 → video，其余（含 png/jpg 等）→ image。
- **声明**：`![alt](路径)`，alt 即「名字」。三类各自从 1 起独立编号，按首次出现顺序。
- **同名校验**：任意两条声明 alt 相同 → 抛错中止（比 spec「同类型内禁止同名」更严，避免跨类型 `[名]` 歧义）。
- **标签**：`{ image: '图片', audio: '音频', video: '视频' }`，产物 `【@${标签}${序号}】`（阿拉伯数字）。
- **参考图读盘不变**：`buildPrompt` 仍用 `parseImageRefs` 的 `order`（按路径去重）读图、`archiveImageRefs` 归档。新替换只接管「发给模型的 prompt」那一行。
- **命名引用正则**：`/\[([^\[\]]+)\](?!\()/g`——声明已先删除，剩下的 `[名]` 命中名字表才替换；`(?!\()` 跳过 markdown 链接 `[文字](url)`。
- **共享正则不动**：`IMAGE_REGEX`（捕获组 1=尖括号路径、2=普通路径）被 `parseImageRefs`/`archiveImageRefs` 按组号取值，**不要新增捕获组**。alt 从整段匹配 `m[0]` 上用 `/^!\[([^\]]*)\]/` 单独提取。

---

## File Structure

- `src/images.ts` — 新增音频/视频扩展名与 MIME 表、`mediaTypeOf(ext)`；`mimeOf` 一并覆盖音视频。
- `src/command.ts` — 新增 `MediaType`/`MediaDecl` 类型、`parseMediaDecls`、`buildNameTable`、`replaceMediaRefs`；`buildPrompt` 改用之；删除已被孤立的 `replaceImageRefs`。
- `src/refs.ts` — 新增 `namedRefSnippet(fileName)`（webview 右键插入 `[名]`）、`mediaDeclSnippet(alt, name)`（编辑页拼声明行）。
- `src/edit.ts` — 删除 `buildEditPrompt`；`buildEditFinalPrompt` 改为「拼全部图声明行 + 复用 `replaceMediaRefs` + 注入句」。
- `src/webview/Edit.tsx` — 右键插入由 `imageRefSnippet` 改为 `namedRefSnippet`。
- `src/test/logic.test.ts` — 重写相关用例。

`src/tasks.ts`、`src/sidebarProvider.ts` **不改**：`buildEditFinalPrompt(base, rawPrompt, names)` 签名不变（声明在函数内部用 names 拼）。

---

## 命令速查

- 类型检查（扩展 + webview 两套）：`npm run check-types`
- 编译测试到 `out/`：`npm run compile-tests`
- 跑单组测试：`npx vscode-test --grep "组名"`（会启动 VS Code 实例，较慢）
- lint：`npm run lint`

> 运行 shell 前先 `export PATH="/d/Program Files/Git/usr/bin:/c/Program Files/nodejs:$PATH"`。

---

## Task 1: 媒体类型判定（images.ts）

**Files:**
- Modify: `src/images.ts`
- Test: `src/test/logic.test.ts`（新增 `suite('mediaTypeOf')`）

- [ ] **Step 1: 写失败测试**

在 `logic.test.ts` 顶部 import 处把 `from '../images'` 一行改为：

```ts
import { isImageExt, isImageFileName, mimeOf, mediaTypeOf } from '../images';
```

在 `suite('isImageExt'...)` 附近（任意已存在 suite 之后）新增：

```ts
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
```

- [ ] **Step 2: 编译跑测试，确认失败**

Run: `npm run compile-tests && npx vscode-test --grep "mediaTypeOf"`
Expected: FAIL（`mediaTypeOf` 未导出 / 编译报错）

- [ ] **Step 3: 实现**

在 `src/images.ts` 的 `MIME_BY_EXT` 之后、`isImageExt` 之前插入：

```ts
/** 音频扩展名 → MIME。与图片分表，类型判定与 data URI 拼接共用 */
const AUDIO_BY_EXT: Record<string, string> = {
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
};

/** 视频扩展名 → MIME */
const VIDEO_BY_EXT: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.mkv': 'video/x-matroska',
	'.avi': 'video/x-msvideo',
};

/** 媒体大类：图片 / 音频 / 视频。扩展名区分，未知回退图片（沿用旧行为：任意 ![](路径) 当图片处理） */
export type MediaType = 'image' | 'audio' | 'video';

/** 取扩展名（含点，大小写不敏感）所属的媒体大类 */
export function mediaTypeOf(ext: string): MediaType {
	const e = ext.toLowerCase();
	if (e in AUDIO_BY_EXT) {
		return 'audio';
	}
	if (e in VIDEO_BY_EXT) {
		return 'video';
	}
	return 'image';
}
```

并把 `mimeOf` 改为也查音视频表：

```ts
/** 取扩展名对应的 MIME，未知回退 image/png */
export function mimeOf(ext: string): string {
	const e = ext.toLowerCase();
	return MIME_BY_EXT[e] ?? AUDIO_BY_EXT[e] ?? VIDEO_BY_EXT[e] ?? 'image/png';
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm run compile-tests && npx vscode-test --grep "mediaTypeOf"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/images.ts src/test/logic.test.ts
git commit -m "feat(图片): 新增音视频扩展名判定 mediaTypeOf"
```

---

## Task 2: 媒体声明解析与名字表（command.ts）

**Files:**
- Modify: `src/command.ts`
- Test: `src/test/logic.test.ts`（新增 `suite('parseMediaDecls')`、`suite('buildNameTable')`）

- [ ] **Step 1: 写失败测试**

`logic.test.ts` 顶部把 `from '../command'` 那行改为（先加新导入，`replaceImageRefs` 在 Task 4 删）：

```ts
import { formatStamp, parseImageRefs, replaceImageRefs, archiveImageRefs, dedupeArchiveNames, parseMediaDecls, buildNameTable } from '../command';
```

新增两个 suite：

```ts
suite('parseMediaDecls', () => {
	test('提取 alt、路径、类型，按出现顺序', () => {
		const decls = parseMediaDecls('![传送石](./传送石.png) ![开场曲](./bgm.mp3)');
		assert.deepStrictEqual(decls, [
			{ alt: '传送石', path: './传送石.png', type: 'image' },
			{ alt: '开场曲', path: './bgm.mp3', type: 'audio' },
		]);
	});
	test('尖括号路径可解析', () => {
		const decls = parseMediaDecls('![猫](<../my image (1).png>)');
		assert.deepStrictEqual(decls, [{ alt: '猫', path: '../my image (1).png', type: 'image' }]);
	});
	test('无声明返回空', () => {
		assert.deepStrictEqual(parseMediaDecls('纯文本 [传送石]'), []);
	});
});

suite('buildNameTable', () => {
	test('三类各自独立从 1 编号', () => {
		const table = buildNameTable([
			{ alt: '传送石', path: 'a.png', type: 'image' },
			{ alt: '开场曲', path: 'b.mp3', type: 'audio' },
			{ alt: '李樱', path: 'c.png', type: 'image' },
		]);
		assert.deepStrictEqual(table.get('传送石'), { type: 'image', index: 1 });
		assert.deepStrictEqual(table.get('李樱'), { type: 'image', index: 2 });
		assert.deepStrictEqual(table.get('开场曲'), { type: 'audio', index: 1 });
	});
	test('重名声明抛错', () => {
		assert.throws(
			() => buildNameTable([
				{ alt: '传送石', path: 'a.png', type: 'image' },
				{ alt: '传送石', path: 'b.png', type: 'image' },
			]),
			/传送石/
		);
	});
});
```

- [ ] **Step 2: 编译跑测试，确认失败**

Run: `npm run compile-tests && npx vscode-test --grep "parseMediaDecls"`
Expected: FAIL（`parseMediaDecls` 未导出）

- [ ] **Step 3: 实现**

在 `src/command.ts` 顶部 import 区，把 `from './images'` 一行改为加入 `mediaTypeOf`、`MediaType`：

```ts
import { isImageExt, isImageFileName, mimeOf, mediaTypeOf, type MediaType } from './images';
```

在 `parseImageRefs` 函数之后插入：

```ts
/** 一条媒体声明：alt（命名引用用的名字）、原始路径、媒体大类 */
export interface MediaDecl {
	alt: string;
	path: string;
	type: MediaType;
}

/** 名字表条目：命名引用 [名] 替换成 【@${标签}${index}】 时取用 */
export interface NameEntry {
	type: MediaType;
	index: number;
}

/**
 * 解析正文里所有 `![alt](路径)` 媒体声明，按出现顺序返回。
 * alt 单独从整段匹配上提取（共享 IMAGE_REGEX 只捕获路径，不动其捕获组）。
 */
export function parseMediaDecls(content: string): MediaDecl[] {
	const decls: MediaDecl[] = [];
	for (const m of content.matchAll(IMAGE_REGEX)) {
		const relPath = refPath(m);
		if (!relPath) {
			continue;
		}
		const alt = (m[0].match(/^!\[([^\]]*)\]/)?.[1] ?? '').trim();
		decls.push({ alt, path: relPath, type: mediaTypeOf(path.extname(relPath)) });
	}
	return decls;
}

/**
 * 由声明列表构建名字表：每类从 1 起独立编号（按出现顺序）。
 * 任意两条声明 alt 相同即抛错——避免命名引用 [名] 歧义。
 */
export function buildNameTable(decls: MediaDecl[]): Map<string, NameEntry> {
	const counters: Record<MediaType, number> = { image: 0, audio: 0, video: 0 };
	const table = new Map<string, NameEntry>();
	for (const d of decls) {
		if (table.has(d.alt)) {
			throw new Error(`提示词存在重名引用：${d.alt}`);
		}
		counters[d.type] += 1;
		table.set(d.alt, { type: d.type, index: counters[d.type] });
	}
	return table;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm run compile-tests && npx vscode-test --grep "parseMediaDecls|buildNameTable"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/command.ts src/test/logic.test.ts
git commit -m "feat(命令): 新增媒体声明解析 parseMediaDecls 与名字表 buildNameTable"
```

---

## Task 3: 替换函数 replaceMediaRefs（command.ts）

**Files:**
- Modify: `src/command.ts`
- Test: `src/test/logic.test.ts`（新增 `suite('replaceMediaRefs')`）

- [ ] **Step 1: 写失败测试**

`logic.test.ts` 顶部 `from '../command'` 一行补上 `replaceMediaRefs`：

```ts
import { formatStamp, parseImageRefs, replaceImageRefs, archiveImageRefs, dedupeArchiveNames, parseMediaDecls, buildNameTable, replaceMediaRefs } from '../command';
```

新增：

```ts
suite('replaceMediaRefs', () => {
	const tableOf = (content: string) => buildNameTable(parseMediaDecls(content));
	test('删声明、命名引用替换为【@图片N】，未命中保留', () => {
		const src = '- [传送石] 传送道具。![传送石](./传送石.png)\n[李樱]一手持[传送石]，一手持[魂符]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, '- 【@图片1】 传送道具。\n[李樱]一手持【@图片1】，一手持[魂符]');
	});
	test('音频独立编号【@音频N】', () => {
		const src = '![开场曲](./bgm.mp3) 配乐用[开场曲]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, ' 配乐用【@音频1】');
	});
	test('只删语法本身，前后空格保留', () => {
		const src = 'A ![猫](a.png) B';
		assert.strictEqual(replaceMediaRefs(src, tableOf(src)), 'A  B');
	});
	test('markdown 链接 [文字](url) 不被替换', () => {
		const src = '![猫](a.png) 见[猫](http://x) 和[猫]';
		const out = replaceMediaRefs(src, tableOf(src));
		assert.strictEqual(out, ' 见[猫](http://x) 和【@图片1】');
	});
	test('无声明无命中原样返回', () => {
		assert.strictEqual(replaceMediaRefs('纯文本 [未知]', new Map()), '纯文本 [未知]');
	});
});
```

- [ ] **Step 2: 编译跑测试，确认失败**

Run: `npm run compile-tests && npx vscode-test --grep "replaceMediaRefs"`
Expected: FAIL（`replaceMediaRefs` 未导出）

- [ ] **Step 3: 实现**

在 `src/command.ts` 的 `buildNameTable` 之后插入：

```ts
/** 媒体大类 → 命名引用标签 */
const MEDIA_LABEL: Record<MediaType, string> = { image: '图片', audio: '音频', video: '视频' };

/** 命名引用正则：声明删除后剩下的 `[名]`，`(?!\()` 跳过 markdown 链接 `[文字](url)` */
const NAMED_REF_REGEX = /\[([^\[\]]+)\](?!\()/g;

/**
 * 生成发给模型的 prompt：先整体删除 `![...](...)` 声明（只删语法本身，前后空白保留），
 * 再把命中名字表的 `[名]` 替换为 `【@图片N】`/`【@音频N】`/`【@视频N】`，未命中原样保留。
 * 纯函数（不读盘），生成与编辑链路共用。
 */
export function replaceMediaRefs(content: string, table: Map<string, NameEntry>): string {
	const stripped = content.replace(IMAGE_REGEX, '');
	return stripped.replace(NAMED_REF_REGEX, (full, name: string) => {
		const hit = table.get(name.trim());
		return hit ? `【@${MEDIA_LABEL[hit.type]}${hit.index}】` : full;
	});
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm run compile-tests && npx vscode-test --grep "replaceMediaRefs"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/command.ts src/test/logic.test.ts
git commit -m "feat(命令): 新增 replaceMediaRefs——删声明+命名引用替换为即梦格式"
```

---

## Task 4: buildPrompt 改用新替换 + 删除孤立的 replaceImageRefs（command.ts）

**Files:**
- Modify: `src/command.ts:57-67`（删 `replaceImageRefs`）、`src/command.ts:102-131`（`buildPrompt`）
- Test: `src/test/logic.test.ts`（删 `suite('replaceImageRefs')`）

- [ ] **Step 1: 改 buildPrompt**

把 `buildPrompt` 内构造 `prompt` 的那两行（当前 `src/command.ts:124-125`）：

```ts
	// 第二遍：把图片语法替换为有序引用 [imageN](文件名)
	const prompt = replaceImageRefs(content, indexByPath);
```

替换为：

```ts
	// 发给模型的 prompt：删声明 + 命名引用替换为【@图片N】（同名声明会在此抛错）
	const prompt = replaceMediaRefs(content, buildNameTable(parseMediaDecls(content)));
```

> `parseImageRefs` 的 `order`/`indexByPath` 仍用于读参考图与归档正文，保持不变。

- [ ] **Step 2: 删除孤立的 replaceImageRefs**

删除 `src/command.ts` 中整个 `replaceImageRefs` 函数（含其上方 `/** ... */` 注释块，当前约 52-67 行）。

- [ ] **Step 3: 删除其测试**

删除 `logic.test.ts` 里整个 `suite('replaceImageRefs', ...)`（当前约 158-172 行）。并从顶部 `from '../command'` 导入里删掉 `replaceImageRefs`：

```ts
import { formatStamp, parseImageRefs, archiveImageRefs, dedupeArchiveNames, parseMediaDecls, buildNameTable, replaceMediaRefs } from '../command';
```

- [ ] **Step 4: 类型检查 + 编译跑生成相关测试**

Run: `npm run check-types && npm run compile-tests && npx vscode-test --grep "parseImageRefs|archiveImageRefs|replaceMediaRefs"`
Expected: PASS，且 `check-types` 无 `replaceImageRefs` 未使用 / 未定义报错。

> 若 `check-types` 报 `edit.ts` 仍引用 `replaceImageRefs`，正常——Task 5 会清理 `edit.ts`。可先继续 Task 5 再统一跑 `check-types`。

- [ ] **Step 5: 提交**

```bash
git add src/command.ts src/test/logic.test.ts
git commit -m "refactor(命令): buildPrompt 改用 replaceMediaRefs，删除孤立的 replaceImageRefs"
```

---

## Task 5: refs.ts 新增命名引用与声明片段

**Files:**
- Modify: `src/refs.ts`
- Test: `src/test/logic.test.ts`（新增 `suite('namedRefSnippet')`、`suite('mediaDeclSnippet')`）

- [ ] **Step 1: 写失败测试**

`logic.test.ts` 顶部 `from '../refs'` 一行改为：

```ts
import { imageRefSnippet, namedRefSnippet, mediaDeclSnippet } from '../refs';
```

新增：

```ts
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
```

- [ ] **Step 2: 编译跑测试，确认失败**

Run: `npm run compile-tests && npx vscode-test --grep "namedRefSnippet|mediaDeclSnippet"`
Expected: FAIL（两函数未导出）

- [ ] **Step 3: 实现**

在 `src/refs.ts` 的 `imageRefSnippet` 之后追加（禁止引入 vscode/node，主名靠正则去扩展）：

```ts
/** 右键插入的命名引用：`[主名]`（去掉扩展名）。命名引用替换链路按此名匹配声明 */
export function namedRefSnippet(fileName: string): string {
	const stem = fileName.replace(/\.[^.\\/]+$/, '');
	return `[${stem}]`;
}

/** 媒体声明片段：`![alt](文件名)`；含空格或半角括号的文件名用尖括号包裹，与解析端约定一致 */
export function mediaDeclSnippet(alt: string, name: string): string {
	const dest = /[ ()]/.test(name) ? `<${name}>` : name;
	return `![${alt}](${dest})`;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm run compile-tests && npx vscode-test --grep "namedRefSnippet|mediaDeclSnippet"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/refs.ts src/test/logic.test.ts
git commit -m "feat(refs): 新增 namedRefSnippet 与 mediaDeclSnippet"
```

---

## Task 6: 编辑链路复用生成替换（edit.ts）

**Files:**
- Modify: `src/edit.ts`
- Test: `src/test/logic.test.ts`（删 `suite('buildEditPrompt')`、重写 `suite('buildEditFinalPrompt')`）

- [ ] **Step 1: 改测试（先删旧、写新期望）**

`logic.test.ts` 顶部 `from '../edit'` 一行改为（删 `buildEditPrompt`）：

```ts
import { buildEditFinalPrompt, buildEditArchivePrompt } from '../edit';
```

删除整个 `suite('buildEditPrompt', ...)`（当前约 254-270 行）。

把 `suite('buildEditFinalPrompt', ...)` 整体替换为：

```ts
suite('buildEditFinalPrompt', () => {
	test('全部图拼成顶部声明，命名引用替换为【@图片N】，前置注入句', () => {
		const config = { ...baseConfig, modelInjections: { 'gpt-image-2': '注入句' } };
		// editConfigView 默认 model = gpt-image-2，取该注入句
		const out = buildEditFinalPrompt(config, '把[狗]放进[猫]的场景', ['猫.png', '狗.png']);
		assert.strictEqual(out, '注入句\n\n把【@图片2】放进【@图片1】的场景');
	});
	test('无注入句时只剩替换后的正文', () => {
		const out = buildEditFinalPrompt(baseConfig, '看[猫]', ['猫.png']);
		assert.strictEqual(out, '看【@图片1】');
	});
	test('未引用任何图片时声明被删，仅留正文', () => {
		assert.strictEqual(buildEditFinalPrompt(baseConfig, '纯文本', ['猫.png']), '纯文本');
	});
	test('含空格文件名的声明用尖括号包裹，引用按主名匹配', () => {
		const out = buildEditFinalPrompt(baseConfig, '看[狗 (1)]', ['狗 (1).png']);
		assert.strictEqual(out, '看【@图片1】');
	});
});
```

> 校验逻辑：`buildEditFinalPrompt` 内把 names 拼成声明行（`![主名](文件名)`）置于正文最前，`replaceMediaRefs` 会删掉这些声明行（留下的空白经 `joinPrompt` trim 掉），命名引用 `[主名]` 替换为 `【@图片N】`，编号按声明（= 编辑区）顺序。

- [ ] **Step 2: 编译跑测试，确认失败**

Run: `npm run compile-tests && npx vscode-test --grep "buildEditFinalPrompt"`
Expected: FAIL（实现仍是旧 `[imageN]` 格式）

- [ ] **Step 3: 重写 edit.ts**

把 `src/edit.ts` 完整替换为：

```ts
import { archiveImageRefs, parseMediaDecls, buildNameTable, replaceMediaRefs } from './command';
import { editConfigView } from './config';
import { joinPrompt, modelInjection } from './inject';
import { mediaDeclSnippet, namedRefSnippet } from './refs';
import type { ImageFlowConfig } from './shared';

/**
 * 编辑任务的最终提示词：把编辑区全部图拼成顶部 `![主名](文件名)` 声明（按编辑区顺序），
 * 正文即工作台 MD 格式，复用生成链路的 replaceMediaRefs——声明被删、命名引用 `[主名]`
 * 替换为 `【@图片N】`，编号按编辑区顺序。再前置编辑模型注入句（不拼 IMAGES.md）。
 * 提交（tasks.submitEdit）与预览（sidebarProvider.doEditPreview）共用，保证不漂移。
 */
export function buildEditFinalPrompt(base: ImageFlowConfig, rawPrompt: string, names: string[]): string {
	const config = editConfigView(base);
	const decls = names.map((n) => mediaDeclSnippet(stemOf(n), n)).join('\n');
	const content = decls ? `${decls}\n${rawPrompt.trim()}` : rawPrompt.trim();
	const replaced = replaceMediaRefs(content, buildNameTable(parseMediaDecls(content)));
	return joinPrompt([modelInjection(base, config.model), replaced]);
}

/**
 * 编辑任务的归档正文：把 `![](文件名)` 改写为指向任务 input/ 归档图的 `![](input/原名)`，
 * 不拼注入句——归档为可直接重新生成的正文。序号按编辑区 names 顺序，
 * fileNames 为去重后的归档落盘名（与 archiveInputs 一致），引用才能对上。
 */
export function buildEditArchivePrompt(rawPrompt: string, names: string[], fileNames: string[]): string {
	const indexByName = new Map(names.map((n, i) => [n, i + 1] as const));
	return archiveImageRefs(rawPrompt.trim(), indexByName, fileNames);
}

/** 文件名去扩展主名，与 namedRefSnippet 内部一致——声明 alt 与命名引用必须同名才能对上 */
function stemOf(name: string): string {
	return namedRefSnippet(name).slice(1, -1);
}
```

> 说明：`stemOf` 复用 `namedRefSnippet` 的去扩展逻辑（取 `[主名]` 去掉首尾中括号），保证「声明 alt」与「用户右键插入的命名引用」用同一套主名规则，绝不漂移。

⚠️ 注意：`buildEditArchivePrompt` 仍假定 `rawPrompt` 含 `![](文件名)` 语法才能归档。Task 7 会把右键插入改成 `[主名]`，归档正文将不再含图片语法——这是预期的（归档落盘只是文本留痕，参考图另由 `archiveInputs` 落 `input/`）。本任务不动 `buildEditArchivePrompt` 与 `tasks.ts`。

- [ ] **Step 4: 类型检查 + 跑测试**

Run: `npm run check-types && npm run compile-tests && npx vscode-test --grep "buildEditFinalPrompt|buildEditArchivePrompt"`
Expected: PASS，`check-types` 无 `buildEditPrompt`/`replaceImageRefs` 未定义报错。

- [ ] **Step 5: 提交**

```bash
git add src/edit.ts src/test/logic.test.ts
git commit -m "refactor(编辑): 删除 buildEditPrompt，buildEditFinalPrompt 复用生成替换链路"
```

---

## Task 7: 编辑页右键插入命名引用（Edit.tsx）

**Files:**
- Modify: `src/webview/Edit.tsx:13`（import）、`src/webview/Edit.tsx:157`（右键回调）

- [ ] **Step 1: 改 import**

`src/webview/Edit.tsx:13` 把：

```ts
import { imageRefSnippet } from '../refs';
```

改为：

```ts
import { namedRefSnippet } from '../refs';
```

- [ ] **Step 2: 改右键回调**

`src/webview/Edit.tsx:157` 把：

```ts
											insertAtCursor(imageRefSnippet(img.name));
```

改为：

```ts
											insertAtCursor(namedRefSnippet(img.name));
```

- [ ] **Step 3: 改空态提示文案（可选但建议同步）**

`src/webview/Edit.tsx:146` 与 `:153` 的提示语「插入引用」语义不变，无需改动文案。跳过。

- [ ] **Step 4: 类型检查（webview 套）**

Run: `npm run check-types`
Expected: PASS（webview tsconfig 无 `imageRefSnippet` 未使用报错）

- [ ] **Step 5: 提交**

```bash
git add src/webview/Edit.tsx
git commit -m "feat(编辑页): 右键图片改为插入命名引用 [主名]"
```

---

## Task 8: 全量验证

- [ ] **Step 1: 完整编译 + lint + 打包**

Run: `npm run compile`
Expected: `check-types`（两套 tsconfig）、`lint`（无 warning）、esbuild 打包全部通过。

- [ ] **Step 2: 跑全部逻辑测试**

Run: `npm run compile-tests && npx vscode-test --grep "parseMediaDecls|buildNameTable|replaceMediaRefs|parseImageRefs|archiveImageRefs|mediaTypeOf|namedRefSnippet|mediaDeclSnippet|buildEditFinalPrompt|buildEditArchivePrompt"`
Expected: 全部 PASS。

- [ ] **Step 3: 手动冒烟（F5 调试窗口）**

1. 右键一个含 `![传送石](./传送石.png)` 声明 + 正文 `[传送石]` 的 MD → 执行「请求预览」→ 预览里 prompt 段应为 `【@图片1】`，声明语法已删除，`[魂符]` 类未声明名保留。
2. 编辑页上传两张图 → 右键各插入一次（得到 `[主名]`）→ 写「把[狗]放进[猫]」→ 预览 → 应见 `把【@图片2】放进【@图片1】`，参考图两张按编辑区顺序。

- [ ] **Step 4: 提交（如冒烟暴露文案/小修）**

```bash
git add -A
git commit -m "test(提示词): 引用替换重构全量验证"
```

---

## Self-Review 记录

- **Spec 覆盖**：即梦格式（Task 3）、命名引用（Task 2/3）、声明删除（Task 3）、三类独立编号（Task 2）、同名报错（Task 2）、编辑页复用生成链路 + 删 buildEditPrompt（Task 6）、右键插命名引用（Task 7）、归档不动（Task 6 保留 buildEditArchivePrompt）、tasks/sidebarProvider 不动（签名未变）——均有任务对应。
- **类型一致**：`MediaType`/`MediaDecl`/`NameEntry` 在 Task 1/2 定义，Task 3/4/6 引用一致；`namedRefSnippet`/`mediaDeclSnippet`（Task 5）被 Task 6/7 引用，名称一致；`buildEditFinalPrompt(base, rawPrompt, names)` 签名贯穿不变，故 tasks.ts/sidebarProvider.ts 无需改。
- **已知取舍**：跨类型混排（音频声明在图片之前）时，参考图 `images[]` 仍按 `parseImageRefs` 路径顺序上传，与 `【@音频N】/【@图片N】` 文字标签为位置对应——纯图片场景完全对齐，混排是 spec 标注的「未来展望」范畴，本次不专门处理。
- **占位符扫描**：无 TBD/TODO，每个改代码步骤均含完整代码。
