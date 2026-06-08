# 自动注入提示词 — 设计文档

日期：2026-06-08

## 背景与目标

当前生成图片时，提示词完全等于 Markdown 正文（`buildPrompt` 仅把正文里的 `![](路径)`
解析为有序参考图、替换成 `[imageN]` 引用）。这导致两类文本要反复手写：

1. **模型相关的固定句**：如 gpt-image 系列生成非真实图片易出噪点，需要「整体画面弱化微小
   细节，避免过度刻画。」来抑制；而 nano-banana 系列不需要。这是**模型的属性**，与项目无关。
2. **项目风格句**：如 MC 漫画风需要固定写画风、构图（留边距）等描述。这是**项目级**约定。

目标：把这两类文本从正文里抽走，自动注入到发给后端的 prompt 中，避免重复手写。

## 关键决策

- **两层分开**：模型级注入与项目级风格作用域不同，分别管理，最终拼接。
  避免换项目时重抄模型相关的句子。
- **模型级注入**：代码内置默认表兜底 + 侧栏可按模型覆盖。
- **项目级风格**：放工作区根的单一 `IMAGES.md`，全文注入。
- **拼接顺序**：所有注入在前、正文在后 —— `模型注入句` + `IMAGES.md` + `正文`。
- **注入发生在 `buildPrompt` 之后**：先完成图片语法解析与 `[imageN]` 编号，再把注入文本
  （不含图片语法）拼到替换后正文之前，不干扰编号顺序。

## 数据流

```
生成/预览触发
  → buildPrompt(mdUri, content)        // 现有：图片语法 → [imageN] + 参考图 base64
  → buildInjectedPrompt(config, base)  // 新增：模型注入句 + IMAGES.md + 正文 拼接
  → submitGeneration / buildPreviewText
```

最终 prompt 结构：

```
<模型注入句>
<IMAGES.md 全文>
<替换后的正文>
```

各段之间以空行分隔；某段为空（banana 无注入句、或工作区根无 IMAGES.md）则整段连同空行
一并省略，不留多余空白。注入文本不含图片语法，因此不影响 `[imageN]` 编号。

## 新模块 `src/inject.ts`

```ts
// 模型 → 内置注入句的兜底表（如 gpt-image-2 / gpt-image-2-vip 配抑噪句，banana 系列留空）
const MODEL_INJECTION_DEFAULTS: Record<string, string>;

// 取某模型的注入句：config.modelInjections 覆盖优先，否则回退内置表，都没有则空串
function modelInjection(config: ImageFlowConfig, model: string): string;

// 读工作区根的 IMAGES.md 全文（找不到 / 空 / 无工作区 → 空串）
async function readImagesMd(): Promise<string>;

// 纯函数：把 [模型句, IMAGES.md, 正文] 中的非空段用空行连接
export function joinPrompt(parts: string[]): string;

// 对外主入口：组装最终 prompt
export async function buildInjectedPrompt(
  config: ImageFlowConfig,
  basePrompt: string
): Promise<string>;
```

`joinPrompt` 与 `modelInjection` 为纯逻辑，可脱离 VS Code 实例单测。

## 配置存储

`src/shared.ts` 的 `ImageFlowConfig` 增加字段：

```ts
/** 模型 → 用户自定义注入句的覆盖表；缺省回退内置默认表 */
modelInjections: Record<string, string>;
```

- 存入 `globalState`（非敏感），`config.ts` 的 `DEFAULTS` 给 `{}`。
- 侧栏针对**当前选中模型**显示一个多行输入框，占位符提示「留空则用内置默认」。
- 改动经现有 `saveConfig` 消息写回，无需新增消息类型。

## IMAGES.md 查找

- 位置：工作区根 `vscode.workspace.workspaceFolders?.[0]` 下的 `IMAGES.md`。
- 读不到 / 内容为空 / 无工作区 → 返回空串，**不报错**：注入是可选增强，不应阻断生成。

## 接入点

共 2 处，各加一行调用 `buildInjectedPrompt`，共用 `inject.ts`：

- `src/tasks.ts`（提交生成）：`buildPrompt` 之后注入。
- `src/command.ts`（预览请求 `openRequestPreview`）：同样注入，使预览展示的 prompt
  与真实提交完全一致（所见即所发）。

## 测试

补充纯逻辑单测（对应现有技术债「核心逻辑零测试」）：

- `joinPrompt`：空段省略、空行分隔、全空返回空串。
- `modelInjection`：覆盖优先 / 回退内置 / 二者皆无返回空串。

## 不做（YAGNI）

- 不做 IMAGES.md 的逐级向上查找与多层叠加（仅工作区根单文件）。
- 不做按子目录 / 按文件的差异化风格。
- 不在正文中间插入注入（固定前置）。
