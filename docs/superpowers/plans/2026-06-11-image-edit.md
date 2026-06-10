# 图片编辑功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 image-flow 侧栏新增「编辑」标签页（上传/拖入参考图 + 预设提示词模板 + 独立模型参数），并把所有任务统一存储到工作区根 `.image-flow/tasks/`，任务卡片支持查看提示词与一键送编辑。

**Architecture:** 复用现有 `TaskManager` 异步任务链路（提交/轮询/下载/续拉），抽出与来源无关的 `start()` 公共流程；编辑区图片由扩展主进程的 `EditSession` 以 base64 驻内存持有；提示词图片引用沿用 `![](文件名)` 语法，复用 `parseImageRefs`/`replaceImageRefs` 管线。

**Tech Stack:** VS Code Extension API、TypeScript、React（webview）、esbuild、mocha（vscode-test）。

**规格文档：** `docs/superpowers/specs/2026-06-10-image-edit-design.md`（实现时先通读）。

**验证命令（每个任务收尾都要跑）：**

```bash
export PATH="/d/Program Files/Git/usr/bin:/c/Program Files/nodejs:$PATH"
npm run compile        # 类型检查 + lint + 打包，必须零 error 零 warning
npm test               # vscode-test 跑 out/ 下测试（test 脚本自带编译）
```

**项目约定：** 缩进用 Tab；注释中文；ESLint `curly` 必须带花括号；不留未用 import。

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/storage.ts` | 新建 | `.image-flow/` 统一存储路径推导（tasksRoot / promptsRoot） |
| `src/refs.ts` | 新建 | 图片引用片段纯函数（webview 与扩展共用，禁 vscode/node 依赖） |
| `src/edit.ts` | 新建 | 编辑提示词替换与校验（buildEditPrompt） |
| `src/taskFiles.ts` | 新建 | 提示词文件内容/写入、data URI 解析、input/ 归档 |
| `src/prompts.ts` | 新建 | 扫描 `.image-flow/prompts/` 模板 |
| `src/editSession.ts` | 新建 | 编辑区图片列表（内存 base64、重名拒绝） |
| `src/shared.ts` | 修改 | Config 编辑字段、PendingTask kind/prefix、消息协议增量 |
| `src/config.ts` | 修改 | DEFAULTS 编辑字段、editConfigView |
| `src/command.ts` | 修改 | formatStamp 毫秒化、createTaskFolder/downloadImages/listHistory 迁址、buildPrompt 返回 names、openTextPreview 抽取 |
| `src/tasks.ts` | 修改 | start() 公共流程、submitEdit、提示词文件 + 归档、legacy 过滤 |
| `src/sidebarProvider.ts` | 修改 | 编辑消息处理、模板/编辑图推送、pushHistory 全局化 |
| `src/webview/Edit.tsx` | 新建 | 编辑标签页组件 |
| `src/webview/App.tsx` | 修改 | 第 4 个 tab、编辑状态、生成冷却 |
| `src/webview/Tasks.tsx` | 修改 | ✎ 送编辑、查看提示词、缩略图可拖 |
| `src/webview/Materials.tsx` | 修改 | 素材缩略图可拖 |
| `media/sidebar.css` | 修改 | 编辑页与缩略图角标样式 |
| `src/test/logic.test.ts` | 修改 | baseConfig 补字段、formatStamp 毫秒断言、新增纯函数测试 |

---

### Task 1: formatStamp 毫秒化

**Files:**
- Modify: `src/command.ts:92-103`
- Test: `src/test/logic.test.ts:73-77`

- [ ] **Step 1: 改测试为毫秒断言（先失败）**

把 `src/test/logic.test.ts` 中的 `suite('formatStamp', ...)` 整段替换为：

```ts
suite('formatStamp', () => {
	test('补零到 yyMMddHHmmssSSS（毫秒级）', () => {
		assert.strictEqual(formatStamp(new Date(2026, 0, 2, 3, 4, 5, 6)), '260102030405006');
		assert.strictEqual(formatStamp(new Date(2026, 11, 31, 23, 59, 59, 999)), '261231235959999');
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

预期：formatStamp 用例 FAIL（实际值少 3 位毫秒）。

- [ ] **Step 3: 改实现**

把 `src/command.ts` 的 `formatStamp` 替换为：

```ts
/** 把 Date 格式化为 yyMMddHHmmssSSS（毫秒级，任务文件夹名唯一性依赖它） */
export function formatStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		String(d.getFullYear()).slice(2) +
		p(d.getMonth() + 1) +
		p(d.getDate()) +
		p(d.getHours()) +
		p(d.getMinutes()) +
		p(d.getSeconds()) +
		String(d.getMilliseconds()).padStart(3, '0')
	);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/command.ts src/test/logic.test.ts
git commit -m "feat: 任务时间戳精确到毫秒"
```

---

### Task 2: 统一存储路径模块 storage.ts

**Files:**
- Create: `src/storage.ts`

- [ ] **Step 1: 新建 `src/storage.ts`**

```ts
import * as vscode from 'vscode';

/** 第一个工作区文件夹的 Uri；无工作区返回 undefined */
export function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** 取工作区根，没有则抛出友好错误（生成/编辑入口统一靠它拦截无工作区场景） */
function requireRoot(): vscode.Uri {
	const root = workspaceRoot();
	if (!root) {
		throw new Error('未打开工作区文件夹，无法使用 .image-flow 存储目录。');
	}
	return root;
}

/** 所有任务（生成 + 编辑）的统一存放目录：<工作区根>/.image-flow/tasks */
export function tasksRoot(): vscode.Uri {
	return vscode.Uri.joinPath(requireRoot(), '.image-flow', 'tasks');
}

/** 预设提示词模板目录：<工作区根>/.image-flow/prompts */
export function promptsRoot(): vscode.Uri {
	return vscode.Uri.joinPath(requireRoot(), '.image-flow', 'prompts');
}
```

依赖 vscode workspace 状态，不写单测（路径拼接无分支逻辑，靠后续任务的集成行为覆盖）。

- [ ] **Step 2: 编译验证**

```bash
npm run compile
```

预期：成功（新文件暂无人引用，仅验证语法与 lint）。

- [ ] **Step 3: 提交**

```bash
git add src/storage.ts
git commit -m "feat: 新增 .image-flow 统一存储路径模块"
```

---

### Task 3: 配置扩展——编辑专属字段与 editConfigView

**Files:**
- Modify: `src/shared.ts:6-19`
- Modify: `src/config.ts:32-41`（DEFAULTS）+ 文件末尾追加 editConfigView
- Test: `src/test/logic.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/test/logic.test.ts` 顶部 import 区加：

```ts
import { editConfigView } from '../config';
```

把 `baseConfig` 替换为（补 4 个编辑字段）：

```ts
const baseConfig: ImageFlowConfig = {
	apiKey: 'k',
	baseUrl: 'https://example.com',
	model: 'nano-banana-2',
	aspectRatio: '3:4',
	imageSize: '1K',
	concurrency: 1,
	workbenchCols: 4,
	tasksCols: 2,
	modelInjections: {},
	editModel: 'gpt-image-2',
	editAspectRatio: '16:9',
	editImageSize: '2K',
	editConcurrency: 3,
};
```

文件末尾追加：

```ts
suite('editConfigView', () => {
	test('用编辑专属参数覆盖主参数，其余字段保留', () => {
		const view = editConfigView(baseConfig);
		assert.strictEqual(view.model, 'gpt-image-2');
		assert.strictEqual(view.aspectRatio, '16:9');
		assert.strictEqual(view.imageSize, '2K');
		assert.strictEqual(view.concurrency, 3);
		assert.strictEqual(view.apiKey, 'k');
		assert.strictEqual(view.baseUrl, 'https://example.com');
	});
});
```

- [ ] **Step 2: 运行测试确认编译失败**

```bash
npm test
```

预期：编译错误（`editModel` 不在 `ImageFlowConfig`、`editConfigView` 不存在）。

- [ ] **Step 3: 改 shared.ts 与 config.ts**

`src/shared.ts` 的 `ImageFlowConfig` 在 `modelInjections` 字段后追加：

```ts
	/** 编辑页专属模型（与主生成界面互不影响） */
	editModel: string;
	/** 编辑页专属比例 */
	editAspectRatio: string;
	/** 编辑页专属分辨率 */
	editImageSize: string;
	/** 编辑页专属并发数 */
	editConcurrency: number;
```

`src/config.ts` 的 `DEFAULTS` 追加（与主字段默认值一致）：

```ts
	editModel: 'nano-banana-2',
	editAspectRatio: '3:4',
	editImageSize: '1K',
	editConcurrency: 1,
```

`src/config.ts` 文件末尾追加：

```ts
/** 用编辑页专属参数覆盖主参数，得到可直接喂给 api/预览层的配置视图 */
export function editConfigView(config: ImageFlowConfig): ImageFlowConfig {
	return {
		...config,
		model: config.editModel,
		imageSize: config.editImageSize,
		aspectRatio: config.editAspectRatio,
		concurrency: config.editConcurrency,
	};
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test
```

预期：全部 PASS。`npm run compile` 也须通过（DEFAULTS 类型为 `StoredConfig`，新字段已在 Config 中，自动满足）。

- [ ] **Step 5: 提交**

```bash
git add src/shared.ts src/config.ts src/test/logic.test.ts
git commit -m "feat: 配置新增编辑页专属模型/分辨率/比例/并发字段"
```

---

### Task 4: 引用纯函数——refs.ts 与 edit.ts

**Files:**
- Create: `src/refs.ts`
- Create: `src/edit.ts`
- Test: `src/test/logic.test.ts`

- [ ] **Step 1: 写失败测试**

`src/test/logic.test.ts` import 区加：

```ts
import { imageRefSnippet } from '../refs';
import { buildEditPrompt } from '../edit';
```

文件末尾追加：

```ts
suite('imageRefSnippet', () => {
	test('普通文件名直接拼接', () => {
		assert.strictEqual(imageRefSnippet('猫.png'), '![](猫.png)');
	});
	test('含空格或半角括号用尖括号包裹', () => {
		assert.strictEqual(imageRefSnippet('my cat (1).png'), '![](<my cat (1).png>)');
	});
});

suite('buildEditPrompt', () => {
	const names = ['猫.png', '狗 (1).png'];
	test('按编辑区顺序替换为 [imageN](名去扩展)', () => {
		const out = buildEditPrompt('把 ![](狗 (1).png) 放进 ![](猫.png) 的场景', names);
		// 序号按编辑区顺序：猫=1、狗=2，与文本出现顺序无关
		assert.strictEqual(out, '把 [image2](狗 (1)) 放进 [image1](猫) 的场景');
	});
	test('尖括号包裹的引用同样可解析', () => {
		assert.strictEqual(buildEditPrompt('看 ![](<狗 (1).png>)', names), '看 [image2](狗 (1))');
	});
	test('未引用任何图片时原文返回', () => {
		assert.strictEqual(buildEditPrompt('纯文本', names), '纯文本');
	});
	test('引用了编辑区不存在的图片名则报错', () => {
		assert.throws(() => buildEditPrompt('看 ![](不存在.png)', names), /不存在\.png/);
	});
});
```

注意：`buildEditPrompt('把 ![](狗 (1).png) …')` 这种**不带尖括号**且名字含半角括号的写法，`IMAGE_REGEX` 的非尖括号分支取「非 `)`」字符，会在第一个 `)` 截断、匹配不到完整名字——所以第一个用例实际匹配的是 `狗 (1`，校验会报「不存在」。**第一个用例改用尖括号形式书写**（插入端 `imageRefSnippet` 本来就会对这类名字加尖括号，两端一致）：

```ts
	test('按编辑区顺序替换为 [imageN](名去扩展)', () => {
		const out = buildEditPrompt('把 ![](<狗 (1).png>) 放进 ![](猫.png) 的场景', names);
		assert.strictEqual(out, '把 [image2](狗 (1)) 放进 [image1](猫) 的场景');
	});
```

（上方第一段用例代码以此修正版为准，不要写入截断版本。）

- [ ] **Step 2: 运行测试确认编译失败**

```bash
npm test
```

预期：模块 `../refs`、`../edit` 不存在。

- [ ] **Step 3: 新建 `src/refs.ts`**

```ts
// 编辑提示词中的图片引用片段。webview 与扩展两端共用，
// 禁止引入 vscode / node 内置模块（webview bundle 是浏览器环境）。

/** 点击编辑区图片时插入的引用：`![](文件名)`；含空格或半角括号时用尖括号包裹，与解析端约定一致 */
export function imageRefSnippet(name: string): string {
	const dest = /[ ()]/.test(name) ? `<${name}>` : name;
	return `![](${dest})`;
}
```

- [ ] **Step 4: 新建 `src/edit.ts`**

```ts
import { parseImageRefs, replaceImageRefs } from './command';

/**
 * 编辑提示词的引用替换：`![](文件名)` → `[imageN](文件名去扩展)`。
 * 序号按编辑区图片顺序（names 的下标 + 1），与文本出现顺序无关——
 * 参考图按编辑区顺序整体发送，删图/调序后无需改写提示词文本。
 * 引用了编辑区不存在的名字则报错中止（通常是图已删除）。
 */
export function buildEditPrompt(content: string, names: string[]): string {
	const { order } = parseImageRefs(content);
	const known = new Set(names);
	const unknown = order.filter((n) => !known.has(n));
	if (unknown.length) {
		throw new Error(`提示词引用了不存在的图片：${unknown.join('、')}`);
	}
	const indexByName = new Map(names.map((n, i) => [n, i + 1] as const));
	return replaceImageRefs(content, indexByName);
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npm test
```

预期：全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/refs.ts src/edit.ts src/test/logic.test.ts
git commit -m "feat: 编辑提示词引用片段与按序替换纯函数"
```

---

### Task 5: 提示词文件与参考图归档 taskFiles.ts

**Files:**
- Create: `src/taskFiles.ts`
- Test: `src/test/logic.test.ts`

- [ ] **Step 1: 写失败测试**

`src/test/logic.test.ts` import 区加：

```ts
import { buildPromptFileContent, dataUriBytes } from '../taskFiles';
```

文件末尾追加：

```ts
suite('buildPromptFileContent', () => {
	test('frontmatter 记来源，正文为提示词', () => {
		assert.strictEqual(
			buildPromptFileContent('角色/角色设定.md', '画一只猫'),
			'---\nsource: 角色/角色设定.md\n---\n\n画一只猫\n'
		);
	});
});

suite('dataUriBytes', () => {
	test('解析 base64 data URI 为字节', () => {
		const data = `data:image/png;base64,${Buffer.from('abc').toString('base64')}`;
		assert.deepStrictEqual(Array.from(dataUriBytes(data)), [97, 98, 99]);
	});
	test('非 data URI 抛错', () => {
		assert.throws(() => dataUriBytes('https://x/y.png'), /data URI/);
	});
});
```

- [ ] **Step 2: 运行测试确认编译失败**

```bash
npm test
```

预期：模块 `../taskFiles` 不存在。

- [ ] **Step 3: 新建 `src/taskFiles.ts`**

```ts
import * as vscode from 'vscode';

/** 提示词文件内容：frontmatter 记来源（md 工作区相对路径 / （编辑任务）），正文为最终提示词 */
export function buildPromptFileContent(source: string, prompt: string): string {
	return `---\nsource: ${source}\n---\n\n${prompt}\n`;
}

/** 把提示词文件写进任务文件夹 */
export async function writePromptFile(
	taskDir: vscode.Uri,
	fileName: string,
	content: string
): Promise<void> {
	await vscode.workspace.fs.writeFile(
		vscode.Uri.joinPath(taskDir, fileName),
		Buffer.from(content, 'utf8')
	);
}

/** 解析 base64 data URI 为字节；格式异常抛错 */
export function dataUriBytes(dataUri: string): Uint8Array {
	const comma = dataUri.indexOf(',');
	if (!dataUri.startsWith('data:') || comma < 0) {
		throw new Error('参考图数据格式异常（非 data URI）');
	}
	return new Uint8Array(Buffer.from(dataUri.slice(comma + 1), 'base64'));
}

/**
 * 归档参考图到任务文件夹 input/ 子目录：image<N>-<原名>，
 * 与提示词文件中的 [imageN] 一一对应。无参考图则不建目录。
 */
export async function archiveInputs(
	taskDir: vscode.Uri,
	refs: { name: string; data: string }[]
): Promise<void> {
	if (!refs.length) {
		return;
	}
	const dir = vscode.Uri.joinPath(taskDir, 'input');
	await vscode.workspace.fs.createDirectory(dir);
	for (let i = 0; i < refs.length; i++) {
		const file = vscode.Uri.joinPath(dir, `image${i + 1}-${refs[i].name}`);
		await vscode.workspace.fs.writeFile(file, dataUriBytes(refs[i].data));
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test
```

- [ ] **Step 5: 提交**

```bash
git add src/taskFiles.ts src/test/logic.test.ts
git commit -m "feat: 任务提示词文件与 input 参考图归档"
```

---

### Task 6: 任务迁址——提交链路改造（核心任务）

**Files:**
- Modify: `src/shared.ts:41-101`（PendingTask）
- Modify: `src/command.ts`（buildPrompt / createTaskFolder / downloadImages / listHistory / openTextPreview）
- Modify: `src/tasks.ts`（start 公共流程、cleanup、pollJob、resume、constructor）
- Modify: `src/sidebarProvider.ts:275-280`（pushHistory）、`:84-96`（syncActiveMd）
- Test: `src/test/logic.test.ts`（isTaskActive 的 cast 不受影响，无需改）

- [ ] **Step 1: shared.ts 的 PendingTask 增加 kind/prefix、mdUri 改可选**

把 `PendingTask` 接口替换为：

```ts
/**
 * 一个进行中的任务（一次点击 = N 个并发 job，落到 .image-flow/tasks/<folder>）。
 * 持久化进 globalState，重启后据此续拉。
 */
export interface PendingTask {
	id: string;
	/** 任务来源：generate = Markdown 生成；edit = 编辑页 */
	kind: 'generate' | 'edit';
	/** 任务文件夹名（毫秒级时间戳），位于 .image-flow/tasks/ 下 */
	folder: string;
	/** 产出图片文件名前缀：生成任务为 md 名，编辑任务为 edit */
	prefix: string;
	/** 来源 md 的 Uri 字符串（仅 generate，用于追溯） */
	mdUri?: string;
	model: string;
	jobs: PendingJob[];
	/** 已成功下载到文件夹的图片，随 job 完成累加 */
	images: TaskImage[];
	/** 创建时间（ms），用于超时兜底。注意 resume() 会按会话起算重置它，不代表真实墙钟年龄 */
	createdAt: number;
	/** 任务首次提交时间（ms），仅用于显示已进行时间；resume() 不重置，保留真实墙钟年龄 */
	startedAt: number;
}
```

- [ ] **Step 2: command.ts 迁址改造**

(a) 顶部 import 加：

```ts
import { tasksRoot } from './storage';
```

(b) `buildPrompt` 的返回结构补参考图原名（归档要用）。`PromptResult` 与读取循环改为：

```ts
/** 解析后的提示词：替换图片语法后的正文、按序参考图 base64、参考图原文件名（与 images 等长，归档用） */
interface PromptResult {
	prompt: string;
	images: string[];
	names: string[];
}
```

读取循环里 `images.push(...)` 之后加一行：

```ts
			names.push(path.basename(relPath));
```

并在循环前声明 `const names: string[] = [];`，`return { prompt, images, names };`。

(c) `createTaskFolder` 替换为（不再接收 mdUri/seq）：

```ts
/**
 * 在 .image-flow/tasks/ 下创建任务文件夹，返回 [文件夹名, 目录 Uri]。
 * 文件夹名 = 毫秒级时间戳；createDirectory 会递归补建父目录。
 */
export async function createTaskFolder(): Promise<[string, vscode.Uri]> {
	const folder = formatStamp(new Date());
	const dir = vscode.Uri.joinPath(tasksRoot(), folder);
	await vscode.workspace.fs.createDirectory(dir);
	return [folder, dir];
}
```

(d) `downloadImages` 改为按目录 Uri + 前缀工作：

```ts
/**
 * 下载一批图片 URL 到任务文件夹，文件名为 {前缀}-{起始序号..}，返回新增的图片引用。
 * @param startIndex 已有图片数，用于接续编号，避免不同 job 的图片重名
 */
export async function downloadImages(
	taskDir: vscode.Uri,
	prefix: string,
	urls: string[],
	startIndex: number
): Promise<TaskImage[]> {
	const images: TaskImage[] = [];
	for (let i = 0; i < urls.length; i++) {
		const res = await fetchWithTimeout(urls[i]);
		if (!res.ok) {
			throw new Error(`下载图片失败（HTTP ${res.status}）`);
		}
		const data = new Uint8Array(await res.arrayBuffer());
		// 从 URL 取扩展名，校验落在图片白名单内，否则回退 png——避免畸形 URL 落地怪扩展名
		const rawExt = '.' + (urls[i].split('?')[0].split('.').pop()?.toLowerCase() || 'png');
		const ext = isImageExt(rawExt) ? rawExt.slice(1) : 'png';
		const name = `${prefix}-${startIndex + i + 1}.${ext}`;
		const fileUri = vscode.Uri.joinPath(taskDir, name);
		await vscode.workspace.fs.writeFile(fileUri, data);
		images.push({ name, uri: fileUri.toString() });
	}
	return images;
}
```

(e) `listHistory` 改为全局扫描（签名去掉 mdUri）：

```ts
/**
 * 扫描 .image-flow/tasks/ 下所有任务文件夹，读取其中图片为缩略图，
 * 按文件夹名（毫秒时间戳）倒序返回——较新的任务在前。
 * 非递归、仅收图片文件：提示词 .md 与 input/ 归档子目录天然被忽略。
 * @param exclude 进行中任务的文件夹名集合，这些由顶部待办卡片实时展示，历史里跳过避免重复。
 */
export async function listHistory(exclude?: Set<string>): Promise<Task[]> {
	let root: vscode.Uri;
	try {
		root = tasksRoot();
	} catch {
		return []; // 无工作区：无历史可言
	}
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(root);
	} catch {
		return [];
	}

	const folders = entries
		.filter(([, type]) => type === vscode.FileType.Directory)
		.map(([name]) => name)
		.filter((name) => !exclude?.has(name))
		.sort()
		.reverse();

	const tasks: Task[] = [];
	for (const folder of folders) {
		const dir = vscode.Uri.joinPath(root, folder);
		let files: [string, vscode.FileType][];
		try {
			files = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			continue;
		}
		const images: TaskImage[] = [];
		for (const [name, type] of files.sort()) {
			if (type !== vscode.FileType.File || !isImageFileName(name)) {
				continue;
			}
			const fileUri = vscode.Uri.joinPath(dir, name);
			images.push({ name, uri: fileUri.toString() });
		}
		if (images.length) {
			tasks.push({ folder, images });
		}
	}
	return tasks;
}
```

(f) 从 `openRequestPreview` 抽出文档打开逻辑（编辑页预览复用）：

```ts
/** 把文本打开成 markdown 预览文档（不落盘） */
export async function openTextPreview(text: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
	await vscode.window.showTextDocument(doc, { preview: true });
}
```

`openRequestPreview` 末尾两行改为 `await openTextPreview(text);`。

- [ ] **Step 3: tasks.ts 提交链路改造**

(a) import 调整：

```ts
import { submitGeneration, queryResult, TransientError } from './api';
import { buildPrompt, createTaskFolder, downloadImages, mdBaseName } from './command';
import { readConfig } from './config';
import { buildInjectedPrompt } from './inject';
import { tasksRoot } from './storage';
import { archiveInputs, buildPromptFileContent, writePromptFile } from './taskFiles';
import type { ImageFlowConfig, PendingTask, PendingJob } from './shared';
```

（`formatStamp` 不再需要——id 直接用文件夹名。）

(b) 删除 `private seq = 0;` 字段。constructor 里过滤旧版记录：

```ts
	constructor(private readonly context: vscode.ExtensionContext) {
		// 旧版（任务建在 md 同级）持久化记录无 kind 字段，目录定位已失效，直接丢弃不续拉
		this.tasks = context.globalState
			.get<PendingTask[]>(PENDING_KEY, [])
			.filter((t) => t.kind === 'generate' || t.kind === 'edit');
	}
```

(c) `cleanupEmptyFolder` 改为从 tasksRoot 定位：

```ts
	/** 删除任务的空文件夹：submit 时已建夹，若任务无任何成图就移除（含提示词文件与 input/ 归档） */
	private async cleanupEmptyFolder(task: PendingTask): Promise<void> {
		if (task.images.length) {
			return;
		}
		try {
			const dir = vscode.Uri.joinPath(tasksRoot(), task.folder);
			await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
		} catch {
			// 目录不存在或删除失败不影响主流程
		}
	}
```

(d) `submit` 重构 + 抽出 `start` 公共流程（替换原 `submit` 整个方法）：

```ts
	/**
	 * 提交一次 Markdown 生成：读文件 → 解析提示词 → 走公共提交流程。
	 */
	async submit(mdUri: vscode.Uri): Promise<void> {
		const config = await readConfig(this.context);
		const bytes = await vscode.workspace.fs.readFile(mdUri);
		const content = Buffer.from(bytes).toString('utf8').trim();
		if (!content) {
			throw new Error('Markdown 文件内容为空，无法生成。');
		}

		const { prompt: basePrompt, images, names } = await buildPrompt(mdUri, content);
		const prompt = await buildInjectedPrompt(config, basePrompt);
		const prefix = mdBaseName(mdUri);
		await this.start({
			kind: 'generate',
			prefix,
			mdUri: mdUri.toString(),
			promptFileName: `${prefix}.md`,
			source: vscode.workspace.asRelativePath(mdUri),
			config,
			prompt,
			images,
			names,
		});
	}

	/**
	 * 公共提交流程：建任务文件夹 → 写提示词文件 + 归档参考图 → 建卡入列 →
	 * 后台并发提交（不 await，调用方立即返回）。
	 */
	private async start(opts: StartOptions): Promise<void> {
		const [folder, dir] = await createTaskFolder();
		await writePromptFile(dir, opts.promptFileName, buildPromptFileContent(opts.source, opts.prompt));
		await archiveInputs(dir, opts.names.map((name, i) => ({ name, data: opts.images[i] })));

		const count = Math.max(1, opts.config.concurrency);
		const task: PendingTask = {
			id: folder,
			kind: opts.kind,
			folder,
			prefix: opts.prefix,
			mdUri: opts.mdUri,
			model: opts.config.model,
			jobs: Array.from({ length: count }, () => ({ status: 'submitting' as const })),
			images: [],
			createdAt: Date.now(),
			startedAt: Date.now(),
		};
		this.tasks.unshift(task);
		await this.persist();
		this.emit();

		void this.submitJobs(opts.config, task, opts.prompt, opts.images);
	}
```

模块级（class 外、import 后）声明参数类型：

```ts
/** TaskManager.start 的参数：与任务来源（生成/编辑）无关的公共提交要素 */
interface StartOptions {
	kind: 'generate' | 'edit';
	/** 产出图片文件名前缀 */
	prefix: string;
	/** 来源 md（仅 generate） */
	mdUri?: string;
	/** 任务文件夹内提示词文件名（生成 = <md名>.md，编辑 = edit.md） */
	promptFileName: string;
	/** 提示词文件 frontmatter 的 source 值 */
	source: string;
	/** 本次生效的配置（编辑任务传入 editConfigView 结果） */
	config: ImageFlowConfig;
	/** 注入后的最终提示词 */
	prompt: string;
	/** 参考图 data URI（按序） */
	images: string[];
	/** 参考图原文件名（与 images 等长，归档用） */
	names: string[];
}
```

(e) `pollJob` 里下载一段改为：

```ts
		// succeeded：下载到任务文件夹，接续已有图片编号避免重名
		const taskDir = vscode.Uri.joinPath(tasksRoot(), task.folder);
		const saved = await downloadImages(taskDir, task.prefix, result.urls, task.images.length);
```

（删除原 `const mdUri = vscode.Uri.parse(task.mdUri);` 行。）

- [ ] **Step 4: sidebarProvider.ts 适配**

(a) `pushHistory` 改为全局（不再依赖 currentMd）：

```ts
	private async pushHistory(): Promise<void> {
		const tasks: Task[] = await listHistory(this.tasks.activeFolders());
		this.post({ type: 'history', tasks: tasks.map((t) => this.toWebviewTask(t)) });
	}
```

(b) `syncActiveMd` 里历史不再随 MD 变化，删掉 `void this.pushHistory();` 那一行（保留 `pushAutoLibraries`）：

```ts
		if (changed) {
			void this.pushAutoLibraries();
		}
```

- [ ] **Step 5: 编译 + 测试**

```bash
npm run compile
npm test
```

预期：全部通过。若有遗漏调用点（如 extension.test.ts 引用旧签名），按新签名修正。

- [ ] **Step 6: 提交**

```bash
git add src/shared.ts src/command.ts src/tasks.ts src/sidebarProvider.ts
git commit -m "feat: 任务统一存储到 .image-flow/tasks 并归档提示词与参考图"
```

---

### Task 7: 模板扫描、编辑会话与扩展侧消息处理

**Files:**
- Create: `src/prompts.ts`
- Create: `src/editSession.ts`
- Modify: `src/shared.ts`（消息协议增量 + PromptTemplate + WebviewEditImage + navigate）
- Modify: `src/tasks.ts`（submitEdit）
- Modify: `src/sidebarProvider.ts`（消息分发 + 推送）
- Modify: `src/webview/vscode.ts`（导出新类型）
- Test: `src/test/logic.test.ts`（EditSession 纯逻辑）

- [ ] **Step 1: 写 EditSession 失败测试**

`src/test/logic.test.ts` import 区加：

```ts
import { EditSession } from '../editSession';
```

文件末尾追加：

```ts
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
	test('remove 按名移除', () => {
		const s = new EditSession();
		s.addData('a.png', png);
		s.addData('b.png', png);
		s.remove('a.png');
		assert.deepStrictEqual(s.list().map((i) => i.name), ['b.png']);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

- [ ] **Step 3: 新建 `src/editSession.ts`**

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import { isImageFileName, mimeOf } from './images';
import { uriBaseName } from './paths';

/** 编辑区一张图：name 为引用名（文件名），data 为 base64 data URI（统一驻内存，提交直接用） */
export interface EditImage {
	name: string;
	data: string;
}

/**
 * 编辑区图片列表：扩展主进程持有（webview 重建不丢）。
 * 统一存 data URI——绕开 localResourceRoots 限制（图片可能来自任意目录），
 * 也顺带覆盖系统拖入拿不到路径的二进制；提交时本就要转 base64，无重复开销。
 * 重名直接拒绝（引用按文件名，重名会产生歧义）。
 */
export class EditSession {
	private images: EditImage[] = [];

	list(): EditImage[] {
		return this.images;
	}

	/** 按文件 Uri 添加：读文件转 data URI。返回错误消息，null 表示成功 */
	async addUri(uriStr: string): Promise<string | null> {
		const uri = vscode.Uri.parse(uriStr);
		const name = uriBaseName(uri);
		const invalid = this.validate(name);
		if (invalid) {
			return invalid;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const data = `data:${mimeOf(path.extname(name))};base64,${Buffer.from(bytes).toString('base64')}`;
			this.images.push({ name, data });
			return null;
		} catch {
			return `图片读取失败：${name}`;
		}
	}

	/** 添加内存图（系统拖入的二进制，前端已转 data URI）。返回错误消息，null 表示成功 */
	addData(name: string, data: string): string | null {
		const invalid = this.validate(name);
		if (invalid) {
			return invalid;
		}
		if (!data.startsWith('data:image/')) {
			return `图片数据异常：${name}`;
		}
		this.images.push({ name, data });
		return null;
	}

	remove(name: string): void {
		this.images = this.images.filter((i) => i.name !== name);
	}

	private validate(name: string): string | null {
		if (!isImageFileName(name)) {
			return `不支持的图片格式：${name}`;
		}
		if (this.images.some((i) => i.name === name)) {
			return `已存在同名图片，请改名后再添加：${name}`;
		}
		return null;
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test
```

- [ ] **Step 5: shared.ts 消息协议增量**

(a) 类型定义区（`WebviewLibrary` 之后）追加：

```ts
/** 预设提示词模板：name 为文件名去扩展名，content 为全文 */
export interface PromptTemplate {
	name: string;
	content: string;
}

/** 编辑区图片（发往 webview）：src 为 data URI 缩略图 */
export interface WebviewEditImage {
	name: string;
	src: string;
}
```

(b) `InboundMessage` 联合追加两个成员，并把 navigate 的 tab 联合扩为含 `'edit'`：

```ts
	| { type: 'navigate'; tab: 'workbench' | 'edit' | 'tasks' | 'api' }
	| { type: 'promptTemplates'; templates: PromptTemplate[] }
	| { type: 'editImages'; images: WebviewEditImage[] }
```

(c) `OutboundMessage` 联合追加：

```ts
	| { type: 'editUpload' }
	| { type: 'editAddImages'; uris: string[] }
	| { type: 'editAddImageData'; name: string; data: string }
	| { type: 'editRemoveImage'; name: string }
	| { type: 'editGenerate'; prompt: string }
	| { type: 'editPreviewRequest'; prompt: string }
	| { type: 'openPrompt'; folder: string }
	| { type: 'refreshTemplates' }
```

(d) `src/webview/vscode.ts` 的 re-export 列表加 `PromptTemplate, WebviewEditImage`。

- [ ] **Step 6: 新建 `src/prompts.ts`**

```ts
import * as vscode from 'vscode';
import { promptsRoot } from './storage';
import type { PromptTemplate } from './shared';

/**
 * 扫描 .image-flow/prompts/ 下的 .md 模板：文件名（去扩展名）为模板名，全文为内容。
 * 目录不存在 / 无工作区 / 单文件读取失败均静默跳过——模板是可选增强，不阻断编辑页。
 */
export async function listPromptTemplates(): Promise<PromptTemplate[]> {
	let dir: vscode.Uri;
	try {
		dir = promptsRoot();
	} catch {
		return [];
	}
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return [];
	}
	const templates: PromptTemplate[] = [];
	for (const [name, type] of entries.sort()) {
		if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.md')) {
			continue;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
			templates.push({ name: name.slice(0, -3), content: Buffer.from(bytes).toString('utf8') });
		} catch {
			// 单个模板读取失败不影响其余
		}
	}
	return templates;
}
```

- [ ] **Step 7: tasks.ts 增加 submitEdit**

import 区加：

```ts
import { editConfigView } from './config';
import { buildEditPrompt } from './edit';
import { joinPrompt, modelInjection } from './inject';
import type { EditImage } from './editSession';
```

`submit` 方法之后追加：

```ts
	/**
	 * 提交一次编辑任务：用编辑专属配置，引用按编辑区顺序替换为 [imageN]。
	 * 注入仅拼模型注入句（按编辑模型取），不拼工作区 IMAGES.md——编辑场景与图册说明无关。
	 */
	async submitEdit(rawPrompt: string, refs: EditImage[]): Promise<void> {
		const base = await readConfig(this.context);
		const config = editConfigView(base);
		const content = rawPrompt.trim();
		if (!content) {
			throw new Error('提示词为空，无法生成。');
		}
		const basePrompt = buildEditPrompt(content, refs.map((r) => r.name));
		const prompt = joinPrompt([modelInjection(base, config.model), basePrompt]);
		await this.start({
			kind: 'edit',
			prefix: 'edit',
			promptFileName: 'edit.md',
			source: '（编辑任务）',
			config,
			prompt,
			images: refs.map((r) => r.data),
			names: refs.map((r) => r.name),
		});
	}
```

- [ ] **Step 8: sidebarProvider.ts 消息处理与推送**

(a) import 区加：

```ts
import { EditSession } from './editSession';
import { listPromptTemplates } from './prompts';
import { tasksRoot } from './storage';
import { editConfigView } from './config';
import { buildEditPrompt } from './edit';
import { joinPrompt, modelInjection } from './inject';
import { buildPreviewText, openTextPreview } from './command';
```

（`buildPreviewText`/`openTextPreview` 与已有 `listHistory, openRequestPreview` 合并进同一 import。`readConfig, writeConfig` 已有。）

(b) 类成员加：

```ts
	/** 编辑区图片列表：扩展侧持有，webview 重建不丢 */
	private readonly edit = new EditSession();
```

(c) `onMessage` 的 switch 追加 case：

```ts
			case 'editUpload':
				await this.pickEditImages();
				break;
			case 'editAddImages':
				await this.addEditImages(msg.uris);
				break;
			case 'editAddImageData': {
				const err = this.edit.addData(msg.name, msg.data);
				if (err) {
					this.post({ type: 'error', message: err });
				}
				this.pushEditImages();
				break;
			}
			case 'editRemoveImage':
				this.edit.remove(msg.name);
				this.pushEditImages();
				break;
			case 'editGenerate':
				await this.doEditGenerate(msg.prompt);
				break;
			case 'editPreviewRequest':
				await this.doEditPreview(msg.prompt);
				break;
			case 'openPrompt':
				await this.openTaskPrompt(msg.folder);
				break;
			case 'refreshTemplates':
				await this.pushTemplates();
				break;
```

(d) `init` case 末尾（`pushAutoLibraries` 之后）追加：

```ts
				this.pushEditImages();
				await this.pushTemplates();
```

(e) 类内新增方法（放在 `pickAndAddLibrary` 附近）：

```ts
	/** 弹出文件选择器，把选中图片加入编辑区 */
	private async pickEditImages(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			openLabel: '加入编辑区',
			filters: { 图片: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
		});
		if (!picked?.length) {
			return;
		}
		await this.addEditImages(picked.map((u) => u.toString()));
	}

	/** 批量按 uri 加入编辑区：逐张收集错误（重名/非图/读取失败），一次性提示 */
	private async addEditImages(uris: string[]): Promise<void> {
		const errors: string[] = [];
		for (const uri of uris) {
			const err = await this.edit.addUri(uri);
			if (err) {
				errors.push(err);
			}
		}
		if (errors.length) {
			this.post({ type: 'error', message: errors.join('；') });
		}
		this.pushEditImages();
	}

	private pushEditImages(): void {
		this.post({
			type: 'editImages',
			images: this.edit.list().map((i) => ({ name: i.name, src: i.data })),
		});
	}

	private async pushTemplates(): Promise<void> {
		this.post({ type: 'promptTemplates', templates: await listPromptTemplates() });
	}

	/** 编辑页生成：校验 Key → submitEdit 提交异步任务 */
	private async doEditGenerate(prompt: string): Promise<void> {
		const config = await readConfig(this.context);
		if (!config.apiKey) {
			this.post({ type: 'error', message: '尚未配置 API Key，请在设置页填写。' });
			return;
		}
		this.post({ type: 'busy', busy: true });
		try {
			await this.tasks.submitEdit(prompt, this.edit.list());
			this.post({ type: 'status', message: '已提交编辑任务，正在后台生成…' });
			this.post({ type: 'navigate', tab: 'tasks' });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		} finally {
			this.post({ type: 'busy', busy: false });
		}
	}

	/** 编辑页预览请求：与 submitEdit 同一套替换/注入，打开成预览文档（不调 API） */
	private async doEditPreview(prompt: string): Promise<void> {
		try {
			const base = await readConfig(this.context);
			const config = editConfigView(base);
			const refs = this.edit.list();
			const basePrompt = buildEditPrompt(prompt.trim(), refs.map((r) => r.name));
			const finalPrompt = joinPrompt([modelInjection(base, config.model), basePrompt]);
			await openTextPreview(buildPreviewText(config, finalPrompt, refs.map((r) => r.data)));
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		}
	}

	/** 打开任务文件夹内的提示词 .md 文件（文件名不固定，按扩展名找第一个） */
	private async openTaskPrompt(folder: string): Promise<void> {
		try {
			const dir = vscode.Uri.joinPath(tasksRoot(), folder);
			const entries = await vscode.workspace.fs.readDirectory(dir);
			const md = entries.find(
				([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.md')
			);
			if (!md) {
				this.post({ type: 'error', message: '该任务没有保存提示词文件。' });
				return;
			}
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(dir, md[0]));
		} catch {
			this.post({ type: 'error', message: '提示词文件打开失败。' });
		}
	}
```

- [ ] **Step 9: 编译 + 测试**

```bash
npm run compile
npm test
```

- [ ] **Step 10: 提交**

```bash
git add src/prompts.ts src/editSession.ts src/shared.ts src/tasks.ts src/sidebarProvider.ts src/webview/vscode.ts src/test/logic.test.ts
git commit -m "feat: 编辑会话、模板扫描与扩展侧编辑消息链路"
```

---

### Task 8: 编辑标签页前端

**Files:**
- Create: `src/webview/Edit.tsx`
- Modify: `src/webview/App.tsx`
- Modify: `media/sidebar.css`（追加样式）

- [ ] **Step 1: 新建 `src/webview/Edit.tsx`**

```tsx
import { useRef, useState } from 'react';
import {
	vscode,
	type Config,
	type ConfigOptions,
	type WebviewEditImage,
	type PromptTemplate,
} from './vscode';
import { Select, Stepper, Field } from './fields';
import { imageRefSnippet } from '../refs';

/** 编辑页：图片区（上传/拖入/点击插入引用）+ 模板 + 提示词 + 编辑专属参数 + 生成 */
export function Edit({
	hidden,
	config,
	options,
	images,
	templates,
	busy,
	status,
	onChange,
}: {
	hidden: boolean;
	config: Config;
	options: ConfigOptions;
	images: WebviewEditImage[];
	templates: PromptTemplate[];
	busy: boolean;
	status: { text: string; error: boolean };
	onChange: <K extends keyof Config>(key: K, value: Config[K]) => void;
}) {
	const [prompt, setPrompt] = useState('');
	const [cooling, setCooling] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const taRef = useRef<HTMLTextAreaElement>(null);

	// 在光标处插入文本并把光标移到插入末尾；textarea 未挂载时退化为追加
	const insertAtCursor = (text: string) => {
		const ta = taRef.current;
		if (!ta) {
			setPrompt((p) => p + text);
			return;
		}
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		setPrompt((p) => p.slice(0, start) + text + p.slice(end));
		requestAnimationFrame(() => {
			ta.focus();
			ta.selectionStart = ta.selectionEnd = start + text.length;
		});
	};

	// 拖入：侧栏内自定义类型 > uri-list（VS Code 资源管理器/系统）> File 二进制兜底（转 data URI 由扩展存内存）
	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(false);
		const custom = e.dataTransfer.getData('application/x-imageflow-uri');
		if (custom) {
			vscode.postMessage({ type: 'editAddImages', uris: [custom] });
			return;
		}
		const uriList = e.dataTransfer.getData('text/uri-list');
		const uris = uriList
			? uriList.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
			: [];
		if (uris.length) {
			vscode.postMessage({ type: 'editAddImages', uris });
			return;
		}
		for (const file of Array.from(e.dataTransfer.files)) {
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result === 'string') {
					vscode.postMessage({ type: 'editAddImageData', name: file.name, data: reader.result });
				}
			};
			reader.readAsDataURL(file);
		}
	};

	// 选中模板：追加到提示词末尾（不覆盖已有内容）
	const applyTemplate = (name: string) => {
		const t = templates.find((x) => x.name === name);
		if (!t) {
			return;
		}
		setPrompt((p) => (p.trim() ? `${p.replace(/\s+$/, '')}\n\n${t.content.trim()}` : t.content.trim()));
	};

	// 生成：0.5s 冷却防连点
	const generate = () => {
		if (busy || cooling) {
			return;
		}
		setCooling(true);
		setTimeout(() => setCooling(false), 500);
		vscode.postMessage({ type: 'editGenerate', prompt });
	};

	return (
		<div className="page" data-page="edit" hidden={hidden}>
			<div
				className={`edit-drop${dragOver ? ' over' : ''}`}
				onDragOver={(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={onDrop}
			>
				{images.length === 0 ? (
					<div className="empty">拖入图片，或点击下方「上传」。点击图片可在提示词中插入引用。</div>
				) : (
					<div className="thumbs" style={{ ['--cols' as string]: config.workbenchCols }}>
						{images.map((img, i) => (
							<div className="thumb-wrap" key={img.name}>
								<img
									src={img.src}
									title={`${img.name}（点击插入引用）`}
									onClick={() => insertAtCursor(imageRefSnippet(img.name))}
								/>
								<span className="thumb-index">{i + 1}</span>
								<button
									className="thumb-action thumb-remove"
									title="移除"
									onClick={() => vscode.postMessage({ type: 'editRemoveImage', name: img.name })}
								>
									×
								</button>
							</div>
						))}
					</div>
				)}
				<button className="lib-add" onClick={() => vscode.postMessage({ type: 'editUpload' })}>
					+ 上传
				</button>
			</div>

			<Field label="预设模板（.image-flow/prompts/ 下的 .md 文件，选中追加到提示词）">
				<select
					className="tpl-select"
					value=""
					onChange={(e) => applyTemplate(e.target.value)}
				>
					<option value="">{templates.length ? '插入模板…' : '暂无模板'}</option>
					{templates.map((t) => (
						<option key={t.name} value={t.name}>
							{t.name}
						</option>
					))}
				</select>
			</Field>

			<Field label="提示词">
				<textarea
					ref={taRef}
					rows={8}
					value={prompt}
					placeholder="选择模板或直接输入；点击上方图片插入引用"
					onChange={(e) => setPrompt(e.target.value)}
				/>
			</Field>

			<div className="row">
				<Select
					label="模型"
					value={config.editModel}
					options={options.model}
					onChange={(v) => onChange('editModel', v)}
				/>
				<Select
					label="分辨率"
					value={config.editImageSize}
					options={options.imageSize}
					onChange={(v) => onChange('editImageSize', v)}
				/>
				<Select
					label="比例"
					value={config.editAspectRatio}
					options={options.aspectRatio}
					onChange={(v) => onChange('editAspectRatio', v)}
				/>
				<Stepper
					label="并发数"
					value={config.editConcurrency}
					min={1}
					max={10}
					onChange={(v) => onChange('editConcurrency', v)}
				/>
			</div>

			<div className="gen-row">
				<button
					className="preview-btn"
					onClick={() => vscode.postMessage({ type: 'editPreviewRequest', prompt })}
				>
					预览请求
				</button>
				<button className="gen-btn" disabled={busy || cooling} onClick={generate}>
					{busy ? '生成中…' : '生成'}
				</button>
			</div>

			<div className={`status${status.error ? ' error' : ''}`}>{status.text}</div>
		</div>
	);
}
```

- [ ] **Step 2: App.tsx 接入编辑页与生成冷却**

整文件替换为：

```tsx
import { useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import {
	vscode,
	type Config,
	type ConfigOptions,
	type InboundMessage,
	type WebviewTask,
	type WebviewPendingTask,
	type WebviewLibrary,
	type WebviewEditImage,
	type PromptTemplate,
} from './vscode';
import { Workbench } from './Workbench';
import { Tasks } from './Tasks';
import { ApiConfig } from './ApiConfig';
import { Edit } from './Edit';

type TabId = 'workbench' | 'edit' | 'tasks' | 'api';

const TABS: { id: TabId; label: string }[] = [
	{ id: 'workbench', label: '工作台' },
	{ id: 'edit', label: '编辑' },
	{ id: 'tasks', label: '任务' },
	{ id: 'api', label: '设置' },
];

export function App() {
	const [tab, setTab] = useState<TabId>('workbench');
	const [config, setConfig] = useState<Config | null>(null);
	const [options, setOptions] = useState<ConfigOptions | null>(null);
	const [activeMd, setActiveMd] = useState<string | null>(null);
	const [tasks, setTasks] = useState<WebviewTask[]>([]);
	const [pendingTasks, setPendingTasks] = useState<WebviewPendingTask[]>([]);
	const [libraries, setLibraries] = useState<WebviewLibrary[]>([]);
	const [autoLibraries, setAutoLibraries] = useState<WebviewLibrary[]>([]);
	const [editImages, setEditImages] = useState<WebviewEditImage[]>([]);
	const [templates, setTemplates] = useState<PromptTemplate[]>([]);
	const [busy, setBusy] = useState(false);
	const [genCooling, setGenCooling] = useState(false);
	const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false });

	// 订阅扩展消息，挂载后发 init 拉取配置与历史
	useEffect(() => {
		const onMessage = (e: MessageEvent<InboundMessage>) => {
			const msg = e.data;
			switch (msg.type) {
				case 'config':
					setConfig(msg.config);
					setOptions(msg.options);
					break;
				case 'activeMd':
					setActiveMd(msg.name);
					break;
				case 'history':
					setTasks(msg.tasks);
					break;
				case 'pendingTasks':
					setPendingTasks(msg.tasks);
					break;
				case 'libraries':
					setLibraries(msg.libraries);
					break;
				case 'autoLibraries':
					setAutoLibraries(msg.libraries);
					break;
				case 'editImages':
					setEditImages(msg.images);
					break;
				case 'promptTemplates':
					setTemplates(msg.templates);
					break;
				case 'status':
					setStatus({ text: msg.message, error: false });
					break;
				case 'error':
					setStatus({ text: msg.message, error: true });
					break;
				case 'busy':
					setBusy(msg.busy);
					break;
				case 'navigate':
					setTab(msg.tab);
					break;
			}
		};
		window.addEventListener('message', onMessage);
		vscode.postMessage({ type: 'init' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	// 单字段即时保存（无保存按钮）
	const saveField = <K extends keyof Config>(key: K, value: Config[K]) => {
		setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
		vscode.postMessage({ type: 'saveConfig', patch: { [key]: value } });
	};

	const switchTab = (id: TabId) => {
		setTab(id);
		if (id === 'tasks') {
			vscode.postMessage({ type: 'refreshHistory' });
		}
		if (id === 'edit') {
			vscode.postMessage({ type: 'refreshTemplates' });
		}
	};

	// 生成：0.5s 冷却防连点（冷却期间按钮禁用，借 busy 视觉态）
	const generate = () => {
		if (genCooling) {
			return;
		}
		setGenCooling(true);
		setTimeout(() => setGenCooling(false), 500);
		setStatus({ text: '', error: false });
		vscode.postMessage({ type: 'generate' });
	};

	const previewRequest = () => {
		setStatus({ text: '', error: false });
		vscode.postMessage({ type: 'previewRequest' });
	};

	const addLibrary = () => vscode.postMessage({ type: 'addLibrary' });
	const removeLibrary = (folder: string) =>
		vscode.postMessage({ type: 'removeLibrary', folder });

	// 任务页 ✎：把图加入编辑区并切到编辑页
	const sendToEdit = (uri: string) => {
		vscode.postMessage({ type: 'editAddImages', uris: [uri] });
		setTab('edit');
	};

	if (!config || !options) {
		return <div className="page">加载中…</div>;
	}

	return (
		<Tabs.Root
			className="tabs-root"
			value={tab}
			onValueChange={(v) => switchTab(v as TabId)}
		>
			<Tabs.List className="tabs" aria-label="功能切换">
				{TABS.map((t) => (
					<Tabs.Trigger key={t.id} value={t.id} className="tab">
						{t.label}
					</Tabs.Trigger>
				))}
			</Tabs.List>

			{/* 各页用 Tabs.Content + forceMount 承载：补全 tabpanel 语义与 aria-controls 关联，
			    forceMount 保留未激活页的组件内部状态（展开态等）。.tabpanel 用 display:contents
			    令包裹层对 #app 的 flex 布局透明，不破坏工作台撑满。子组件仍各自按 hidden 渲染。 */}
			<Tabs.Content value="workbench" forceMount className="tabpanel">
				<Workbench
					hidden={tab !== 'workbench'}
					config={config}
					options={options}
					activeMd={activeMd}
					busy={busy || genCooling}
					status={status}
					libraries={libraries}
					autoLibraries={autoLibraries}
					cols={config.workbenchCols}
					onChange={saveField}
					onGenerate={generate}
					onPreview={previewRequest}
					onAddLibrary={addLibrary}
					onRemoveLibrary={removeLibrary}
				/>
			</Tabs.Content>
			<Tabs.Content value="edit" forceMount className="tabpanel">
				<Edit
					hidden={tab !== 'edit'}
					config={config}
					options={options}
					images={editImages}
					templates={templates}
					busy={busy}
					status={status}
					onChange={saveField}
				/>
			</Tabs.Content>
			<Tabs.Content value="tasks" forceMount className="tabpanel">
				<Tasks
					hidden={tab !== 'tasks'}
					tasks={tasks}
					pendingTasks={pendingTasks}
					cols={config.tasksCols}
					onSendToEdit={sendToEdit}
				/>
			</Tabs.Content>
			<Tabs.Content value="api" forceMount className="tabpanel">
				<ApiConfig
					hidden={tab !== 'api'}
					config={config}
					options={options}
					onChange={saveField}
				/>
			</Tabs.Content>
		</Tabs.Root>
	);
}
```

注意：`Tasks` 的 `onSendToEdit` prop 在 Task 9 才加入——**Task 8 编译会报错**。两个任务必须连续执行；若需要 Task 8 单独可编译，可临时不传该 prop（Task 9 再补）。推荐做法：Task 8 先不加 `onSendToEdit={sendToEdit}` 这一行与 `sendToEdit` 函数，Task 9 一并补上。

- [ ] **Step 3: 追加 CSS（`media/sidebar.css` 文件末尾）**

```css
/* ---------- 编辑页 ---------- */
.edit-drop {
	border: 1px dashed var(--hair);
	border-radius: var(--radius-sm);
	padding: var(--sp-2);
	margin-bottom: var(--sp-2);
}

.edit-drop.over {
	border-color: var(--vscode-focusBorder);
	background: var(--vscode-list-hoverBackground);
}

.edit-drop .lib-add {
	margin-top: var(--sp-1);
}

.tpl-select {
	width: 100%;
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, var(--hair));
	border-radius: var(--radius-sm);
	padding: 4px 6px;
}

/* ---------- 缩略图包裹层与角标（编辑区 + 任务页共用） ---------- */
.thumb-wrap {
	position: relative;
	min-width: 0;
}

.thumb-index {
	position: absolute;
	top: 2px;
	left: 2px;
	font-size: 11px;
	line-height: 1;
	padding: 2px 5px;
	border-radius: var(--radius-sm);
	background: rgba(0, 0, 0, 0.6);
	color: #fff;
	pointer-events: none;
}

.thumb-action {
	position: absolute;
	top: 2px;
	right: 2px;
	display: none;
	width: 20px;
	height: 20px;
	padding: 0;
	line-height: 18px;
	text-align: center;
	border-radius: var(--radius-sm);
	background: rgba(0, 0, 0, 0.6);
	color: #fff;
	border: none;
	cursor: pointer;
}

.thumb-wrap:hover .thumb-action {
	display: block;
}

.task-actions {
	margin: var(--sp-1) 0;
}
```

注意：若 `--hair` / `--radius-sm` / `--sp-1` / `--sp-2` 等变量名与 `media/sidebar.css` 现有定义不符，以现有文件实际变量为准调整（写代码前先看该文件头部的 `:root` 定义）。

- [ ] **Step 4: 编译**

```bash
npm run compile
```

预期：通过（若按推荐做法暂未接 `onSendToEdit`）。

- [ ] **Step 5: 提交**

```bash
git add src/webview/Edit.tsx src/webview/App.tsx media/sidebar.css
git commit -m "feat: 侧栏新增编辑标签页（上传/拖入/模板/独立参数/冷却）"
```

---

### Task 9: 任务页送编辑 + 查看提示词 + 缩略图可拖

**Files:**
- Modify: `src/webview/Tasks.tsx`
- Modify: `src/webview/Materials.tsx:43-53`
- Modify: `src/webview/App.tsx`（补 `sendToEdit` 与 prop，若 Task 8 按推荐做法留空）

- [ ] **Step 1: Tasks.tsx 整文件替换**

```tsx
import { useEffect, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { vscode, type WebviewTask, type WebviewPendingTask } from './vscode';

/** 缩略图网格：点击打开原图；可拖拽（送编辑区）；hover 右上角 ✎ 一键送编辑 */
function Thumbs({
	images,
	onSendToEdit,
}: {
	images: { uri: string; src: string; name: string }[];
	onSendToEdit: (uri: string) => void;
}) {
	return (
		<div className="thumbs thumbs-lg">
			{images.map((img) => (
				<div className="thumb-wrap" key={img.uri}>
					<img
						src={img.src}
						title={img.name}
						draggable
						onDragStart={(e) => e.dataTransfer.setData('application/x-imageflow-uri', img.uri)}
						onClick={() => vscode.postMessage({ type: 'openImage', uri: img.uri })}
					/>
					<button
						className="thumb-action"
						title="送入编辑"
						onClick={() => onSendToEdit(img.uri)}
					>
						✎
					</button>
				</div>
			))}
		</div>
	);
}

/** 查看本任务提交的提示词（打开任务文件夹内的 .md 文件） */
function PromptButton({ folder }: { folder: string }) {
	return (
		<div className="task-actions">
			<button
				className="link"
				onClick={() => vscode.postMessage({ type: 'openPrompt', folder })}
			>
				查看提示词
			</button>
		</div>
	);
}

/** 把毫秒时长格式化为 mm:ss（超过一小时则 h:mm:ss） */
function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const pad = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 已进行时间：每秒自增，从任务 createdAt 起算 */
function useElapsed(createdAt: number): string {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return formatElapsed(now - createdAt);
}

/** 进行中任务卡片：标题可展开/收起，展开后显示进度条 + 已存缩略图 + 进度/失败提示 */
function PendingCard({
	task,
	onSendToEdit,
}: {
	task: WebviewPendingTask;
	onSendToEdit: (uri: string) => void;
}) {
	const [open, setOpen] = useState(true);
	const elapsed = useElapsed(task.startedAt);
	const running = task.total - task.done - task.failed - task.submitting;
	// 提交阶段（尚无 job id）显示「提交中」，其余显示生成进度
	const headline =
		task.submitting > 0
			? `提交中 ${task.submitting}/${task.total}`
			: `生成中 ${task.done}/${task.total}`;
	return (
		<Collapsible.Root className="task pending" open={open} onOpenChange={setOpen}>
			<Collapsible.Trigger asChild>
				<div className="folder">
					<span className="task-caret" data-open={open}>
						▸
					</span>
					{task.folder}（{task.model}） · {headline}
					{task.failed > 0 ? ` · 失败 ${task.failed}` : ''} · {elapsed}
				</div>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div className="progress-row">
					<div className="progress-bar">
						<div className="progress-fill" style={{ width: `${task.progress}%` }} />
					</div>
					<span className="progress-pct">{task.progress}%</span>
				</div>
				<PromptButton folder={task.folder} />
				{task.images.length > 0 && <Thumbs images={task.images} onSendToEdit={onSendToEdit} />}
				{task.submitting > 0 && (
					<div className="pending-hint">正在提交 {task.submitting} 个请求…</div>
				)}
				{running > 0 && <div className="pending-hint">还有 {running} 张正在生成…</div>}
				{task.errors.length > 0 && <div className="pending-err">{task.errors.join('；')}</div>}
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** 历史任务卡片：标题可展开/收起，默认收起 */
function HistoryCard({
	task,
	onSendToEdit,
}: {
	task: WebviewTask;
	onSendToEdit: (uri: string) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible.Root className="task" open={open} onOpenChange={setOpen}>
			<Collapsible.Trigger asChild>
				<div className="folder">
					<span className="task-caret" data-open={open}>
						▸
					</span>
					{task.folder}（{task.images.length} 张）
				</div>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<PromptButton folder={task.folder} />
				<Thumbs images={task.images} onSendToEdit={onSendToEdit} />
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** 任务页：进行中与历史合并为一条按时间倒序的列表，点击标题展开/收起 */
export function Tasks({
	hidden,
	tasks,
	pendingTasks,
	cols,
	onSendToEdit,
}: {
	hidden: boolean;
	tasks: WebviewTask[];
	pendingTasks: WebviewPendingTask[];
	cols: number;
	onSendToEdit: (uri: string) => void;
}) {
	const empty = tasks.length === 0 && pendingTasks.length === 0;
	// 进行中与历史按文件夹名（毫秒时间戳）倒序合并，新任务在前
	const items = [
		...pendingTasks.map((t) => ({ folder: t.folder, kind: 'pending' as const, task: t })),
		...tasks.map((t) => ({ folder: t.folder, kind: 'history' as const, task: t })),
	].sort((a, b) => (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0));
	return (
		<div
			className="page"
			data-page="tasks"
			hidden={hidden}
			style={{ ['--cols' as string]: cols }}
		>
			{empty ? (
				<div className="empty">暂无生成记录。</div>
			) : (
				items.map((item) =>
					item.kind === 'pending' ? (
						<PendingCard key={item.task.id} task={item.task} onSendToEdit={onSendToEdit} />
					) : (
						<HistoryCard key={item.task.folder} task={item.task} onSendToEdit={onSendToEdit} />
					)
				)
			)}
		</div>
	);
}
```

- [ ] **Step 2: Materials.tsx 缩略图可拖**

`LibRow` 内 `<img ...>` 加 draggable 两个属性（其余不动）：

```tsx
						<img
							key={img.uri}
							src={img.src}
							title={`${img.name}（左键打开 · 右键插入引用 · 可拖入编辑区）`}
							draggable
							onDragStart={(e) =>
								e.dataTransfer.setData('application/x-imageflow-uri', img.uri)
							}
							onClick={() => vscode.postMessage({ type: 'openImage', uri: img.uri })}
							onContextMenu={(e) => {
								e.preventDefault();
								vscode.postMessage({ type: 'insertImage', uri: img.uri });
							}}
						/>
```

- [ ] **Step 3: App.tsx 补 sendToEdit（若 Task 8 留空）**

按 Task 8 Step 2 中的代码补上 `sendToEdit` 函数与 `<Tasks ... onSendToEdit={sendToEdit} />`。

- [ ] **Step 4: 编译 + 测试**

```bash
npm run compile
npm test
```

- [ ] **Step 5: 提交**

```bash
git add src/webview/Tasks.tsx src/webview/Materials.tsx src/webview/App.tsx
git commit -m "feat: 任务页一键送编辑与查看提示词，缩略图支持拖入编辑区"
```

---

### Task 10: 全量验证与收尾

- [ ] **Step 1: 全量编译与测试**

```bash
npm run compile
npm test
```

预期：零 error 零 warning、测试全绿。

- [ ] **Step 2: 手动冒烟（F5 启动扩展开发宿主）**

按以下清单逐项验证：

1. 打开含 Markdown 的工作区 → 工作台点「生成」→ 任务落在 `<工作区>/.image-flow/tasks/<毫秒时间戳>/`，内有 `<md名>.md`（frontmatter 带 source 相对路径）、`input/imageN-*`（若正文有参考图）、产出图。
2. 任务页卡片展开 →「查看提示词」打开提示词文件；缩略图 hover 出现 ✎，点击切到编辑页且图已入列。
3. 编辑页：「上传」多选图片；从素材库/任务页拖图入编辑区；从 VS Code 资源管理器拖图（按住 Shift）；重名图片被拒并报错。
4. 在 `.image-flow/prompts/` 放两个 .md → 切到编辑页 → 下拉出现模板，选中追加到提示词框。
5. 点击编辑区图片 → 光标处插入 `![](文件名)`；「预览请求」展示 `[imageN]` 替换后的最终提示词与编辑专属参数。
6. 编辑页「生成」→ 任务进任务页，文件夹内有 `edit.md` + `input/` + `edit-N.png`。
7. 连点生成按钮 → 0.5 秒内第二次点击无效。
8. 不打开工作区文件夹 → 生成/编辑生成报「未打开工作区文件夹」。

- [ ] **Step 3: 代码审查**

按项目工作流执行 `/requesting-code-review`，按意见修复后再验证。

- [ ] **Step 4: 最终提交**

若审查修复产生改动：

```bash
git add -A
git commit -m "fix: 图片编辑功能审查意见修复"
```

---

## 已知取舍（实现时不要"顺手修"）

- 同一毫秒双提交理论上撞文件夹：前端冷却 + 毫秒时间戳已把概率压到可忽略，不加重试。
- 旧版散落的 `task-*` 文件夹与无 `kind` 的持久化任务直接放弃，不迁移不展示。
- 内存图（系统拖入无路径）在扩展重启后从编辑区消失。
- 删除编辑区图片不改写提示词文本，提交时校验报错兜底。
