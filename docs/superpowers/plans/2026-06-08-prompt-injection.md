# 自动注入提示词 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成图片时自动把「模型注入句 + 工作区根 IMAGES.md + 正文」拼成最终 prompt，免去重复手写。

**Architecture:** 新增 `src/inject.ts` 专管注入：内置模型注入兜底表 + 侧栏按模型覆盖 + 读工作区根 IMAGES.md + 纯函数拼接。`buildPrompt` 完成图片解析后，提交（tasks.ts）与预览（command.ts）两处各调一次 `buildInjectedPrompt`。

**Tech Stack:** TypeScript、VS Code Extension API、React（webview 配置 UI）、mocha + vscode-test（测试）。

---

## 文件结构

- 修改 `src/shared.ts` — `ImageFlowConfig` 增 `modelInjections` 字段
- 修改 `src/config.ts` — `DEFAULTS` 补 `modelInjections: {}`
- 新建 `src/inject.ts` — 注入逻辑（`modelInjection` / `readImagesMd` / `joinPrompt` / `buildInjectedPrompt`）
- 新建 `src/test/inject.test.ts` — 纯逻辑单测
- 修改 `src/tasks.ts` — 提交前注入
- 修改 `src/command.ts` — 预览前注入
- 修改 `src/webview/fields.tsx` — 新增 `TextArea` 组件
- 修改 `src/webview/ApiConfig.tsx` — 当前模型的注入编辑框

---

> 本机 bash 跑命令前先：`export PATH="/d/Program Files/Git/usr/bin:/c/Program Files/nodejs:$PATH"`

### Task 1: 配置字段 `modelInjections`

**Files:**
- Modify: `src/shared.ts:6-17`
- Modify: `src/config.ts:22-30`

- [ ] **Step 1: shared.ts 增字段**

在 `ImageFlowConfig` 接口 `tasksThumbSize` 行后加：

```ts
	/** 任务栏缩略图边长（px） */
	tasksThumbSize: number;
	/** 模型 → 用户自定义注入句的覆盖表；缺省回退内置默认表 */
	modelInjections: Record<string, string>;
```

- [ ] **Step 2: config.ts DEFAULTS 补默认值**

在 `DEFAULTS` 的 `tasksThumbSize: 140,` 行后加：

```ts
	tasksThumbSize: 140,
	modelInjections: {},
```

- [ ] **Step 3: 类型检查**

Run: `npm run check-types`
Expected: PASS（无类型错误）

- [ ] **Step 4: Commit**

```bash
git add src/shared.ts src/config.ts
git commit -m "feat: 配置增加 modelInjections 字段"
```

---

### Task 2: inject.ts 纯函数 `joinPrompt` + `modelInjection`（TDD）

**Files:**
- Create: `src/inject.ts`
- Test: `src/test/inject.test.ts`

> 测试经 `npm run compile-tests` 编译到 `out/` 后由 vscode-test 运行。`inject.ts` 顶部会 import `vscode`，但本任务只测两个纯函数，不触发 vscode 调用。

- [ ] **Step 1: 写失败测试**

创建 `src/test/inject.test.ts`：

```ts
import * as assert from 'assert';
import { joinPrompt, modelInjection } from '../inject';
import type { ImageFlowConfig } from '../shared';

const baseConfig = { modelInjections: {} } as ImageFlowConfig;

suite('inject', () => {
	test('joinPrompt 用空行连接非空段', () => {
		assert.strictEqual(joinPrompt(['a', 'b']), 'a\n\nb');
	});
	test('joinPrompt 省略空段', () => {
		assert.strictEqual(joinPrompt(['', 'b', '']), 'b');
	});
	test('joinPrompt 全空返回空串', () => {
		assert.strictEqual(joinPrompt(['', '  ', '']), '');
	});
	test('modelInjection 覆盖优先于内置', () => {
		const cfg = { modelInjections: { 'gpt-image-2': '自定义' } } as unknown as ImageFlowConfig;
		assert.strictEqual(modelInjection(cfg, 'gpt-image-2'), '自定义');
	});
	test('modelInjection 无覆盖时回退内置', () => {
		assert.ok(modelInjection(baseConfig, 'gpt-image-2').includes('微小细节'));
	});
	test('modelInjection 无覆盖无内置返回空串', () => {
		assert.strictEqual(modelInjection(baseConfig, 'nano-banana-2'), '');
	});
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile-tests` 然后 `npx vscode-test --grep "inject"`
Expected: FAIL（`Cannot find module '../inject'` 或编译报错）

- [ ] **Step 3: 创建 inject.ts（含两个纯函数）**

创建 `src/inject.ts`：

```ts
import * as vscode from 'vscode';
import type { ImageFlowConfig } from './shared';

/**
 * 模型 → 内置注入句的兜底表。
 * gpt-image 系列生成非真实图片易出噪点，注入抑噪句；nano-banana 系列不需要，不在表内即空。
 */
const MODEL_INJECTION_DEFAULTS: Record<string, string> = {
	'gpt-image-2': '整体画面弱化微小细节，避免过度刻画。',
	'gpt-image-2-vip': '整体画面弱化微小细节，避免过度刻画。',
};

/** 取某模型的注入句：用户覆盖优先，否则回退内置表，都没有则空串 */
export function modelInjection(config: ImageFlowConfig, model: string): string {
	const override = config.modelInjections?.[model];
	if (override !== undefined && override.trim()) {
		return override.trim();
	}
	return MODEL_INJECTION_DEFAULTS[model] ?? '';
}

/** 把多段文本中的非空段（trim 后）用空行连接 */
export function joinPrompt(parts: string[]): string {
	return parts.map((p) => p.trim()).filter((p) => p).join('\n\n');
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile-tests` 然后 `npx vscode-test --grep "inject"`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add src/inject.ts src/test/inject.test.ts
git commit -m "feat: inject 纯函数 joinPrompt 与 modelInjection"
```

---

### Task 3: `readImagesMd` + `buildInjectedPrompt`

**Files:**
- Modify: `src/inject.ts`

> 这两个函数依赖 `vscode.workspace`，单测需起 VS Code 实例且 fixture 复杂，本任务不写单测——核心拼接逻辑已在 `joinPrompt`/`modelInjection` 覆盖。验证靠类型检查 + Task 5 的手动预览。

- [ ] **Step 1: 追加 readImagesMd**

在 `src/inject.ts` 末尾追加：

```ts
/** 读工作区根的 IMAGES.md 全文；找不到 / 空 / 无工作区 → 空串（注入可选，不阻断生成） */
async function readImagesMd(): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		return '';
	}
	try {
		const uri = vscode.Uri.joinPath(root.uri, 'IMAGES.md');
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('utf8').trim();
	} catch {
		return '';
	}
}
```

- [ ] **Step 2: 追加 buildInjectedPrompt**

在 `src/inject.ts` 末尾追加：

```ts
/**
 * 组装最终 prompt：模型注入句 + IMAGES.md + 正文，顺序固定前置，空段省略。
 * 注入文本不含图片语法，不影响 basePrompt 里 [imageN] 的编号。
 */
export async function buildInjectedPrompt(
	config: ImageFlowConfig,
	basePrompt: string
): Promise<string> {
	const injection = modelInjection(config, config.model);
	const imagesMd = await readImagesMd();
	return joinPrompt([injection, imagesMd, basePrompt]);
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run check-types`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/inject.ts
git commit -m "feat: readImagesMd 与 buildInjectedPrompt 拼装最终提示词"
```

---

### Task 4: 接入提交与预览

**Files:**
- Modify: `src/tasks.ts:104`
- Modify: `src/command.ts:232`

- [ ] **Step 1: tasks.ts 注入**

`src/tasks.ts` 顶部 import 区加：

```ts
import { buildInjectedPrompt } from './inject';
```

把 `submit` 中（约 104 行）：

```ts
		const { prompt, images } = await buildPrompt(mdUri, content);
```

改为：

```ts
		const { prompt: basePrompt, images } = await buildPrompt(mdUri, content);
		const prompt = await buildInjectedPrompt(config, basePrompt);
```

- [ ] **Step 2: command.ts 预览注入**

`src/command.ts` 顶部 import 区加：

```ts
import { buildInjectedPrompt } from './inject';
```

把 `openRequestPreview` 中（约 232 行）：

```ts
	const { prompt, images } = await buildPrompt(mdUri, content);
	const text = buildPreviewText(config, prompt, images);
```

改为：

```ts
	const { prompt: basePrompt, images } = await buildPrompt(mdUri, content);
	const prompt = await buildInjectedPrompt(config, basePrompt);
	const text = buildPreviewText(config, prompt, images);
```

- [ ] **Step 3: 编译 + lint + 类型检查**

Run: `npm run compile`
Expected: PASS（check-types + lint 无 warning，esbuild 打包成功）

- [ ] **Step 4: Commit**

```bash
git add src/tasks.ts src/command.ts
git commit -m "feat: 提交与预览接入提示词注入"
```

---

### Task 5: 侧栏当前模型注入编辑框

**Files:**
- Modify: `src/webview/fields.tsx`（新增 `TextArea`）
- Modify: `src/webview/ApiConfig.tsx`

> 在设置页加一个多行输入框，编辑**当前选中模型**的注入句。留空提交 `''`，运行时回退内置默认（见 `modelInjection`）。

- [ ] **Step 1: fields.tsx 新增 TextArea**

在 `src/webview/fields.tsx` 的 `TextField` 组件之后追加：

```tsx
/** 多行文本输入 */
export function TextArea({
	label,
	value,
	placeholder,
	onChange,
}: {
	label: string;
	value: string;
	placeholder?: string;
	onChange: (value: string) => void;
}) {
	return (
		<Field label={label}>
			<textarea
				rows={3}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
			/>
		</Field>
	);
}
```

- [ ] **Step 2: ApiConfig.tsx 引入并渲染编辑框**

`src/webview/ApiConfig.tsx` 第 2 行 import 改为：

```ts
import { Select, TextField, NumberField, TextArea } from './fields';
```

在「任务栏缩略图」`NumberField`（约 50-56 行）之后、`<div className="preview-row">` 之前插入：

```tsx
				<TextArea
					label={`模型注入提示词（${config.model}）`}
					value={config.modelInjections[config.model] ?? ''}
					placeholder="留空则用内置默认"
					onChange={(v) =>
						onChange('modelInjections', { ...config.modelInjections, [config.model]: v })
					}
				/>
```

- [ ] **Step 3: 类型检查（含 webview）**

Run: `npm run check-types`
Expected: PASS（两套 tsconfig 均通过）

- [ ] **Step 4: 完整编译**

Run: `npm run compile`
Expected: PASS（dist/extension.js 与 media/sidebar.js 均产出）

- [ ] **Step 5: 手动验证**

按 `F5` 启动调试窗口：
1. 工作区根放一个 `IMAGES.md`，内容随便写两行风格描述。
2. 设置页选模型 `gpt-image-2`，注入框留空，点「预览请求」。
   Expected：预览首段为内置抑噪句「整体画面弱化微小细节，避免过度刻画。」，接着是 IMAGES.md 全文，最后是正文。
3. 在注入框填「自定义句」，再预览。
   Expected：首段变为「自定义句」。
4. 切到 `nano-banana-2`，注入框留空，预览。
   Expected：无模型注入句，直接 IMAGES.md + 正文。

- [ ] **Step 6: Commit**

```bash
git add src/webview/fields.tsx src/webview/ApiConfig.tsx
git commit -m "feat: 侧栏按模型编辑注入提示词"
```

---

### Task 6: 文档对齐

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新架构说明**

在 `CLAUDE.md` 的「前后端通信与异步任务」节，`buildPrompt` 描述句后补一句：

```
提示词注入在 `src/inject.ts`（`buildInjectedPrompt` 把「模型注入句 + 工作区根 IMAGES.md + 正文」拼成最终 prompt，模型注入句按模型内置兜底、可在侧栏覆盖），提交（tasks.ts）与预览（command.ts）两处在 `buildPrompt` 之后各调一次。
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 补充提示词注入说明"
```




