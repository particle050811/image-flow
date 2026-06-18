# 功能一：AI 命名 edit 任务 — 设计

> 状态：**设计稿，待审阅**。本文只给设计与数据模型，不含实现代码。
> 日期：2026-06-19 ｜ 路线图索引见 `2026-06-19-三功能路线图-design.md`

## 现状锚点（代码事实）

- 任务落盘在工作区根 `.image-flow/tasks/<毫秒时间戳>/`，文件夹名即任务 id 与排序键，**不可改名**。
- 编辑任务 `prefix` 与 `promptName` 一律为 `edit`（`src/tasks.ts:194` `submitEdit`）；提示词归档进 `edit.md`，frontmatter 由 `buildPromptFileContent`（`src/taskFiles.ts`）写入（含 `source`）。
- 全失败 / 无成图任务当前会被静默删除：`cleanupEmptyFolder`、`submitJobs` 全失败分支移除任务、`pollOnce` 终结清理（`src/tasks.ts`）；`listHistory` 仅收录「有图」的文件夹。
- 任务卡片标题现显示「可读时间 + 来源 md 名」。
- grsai 已提供 OpenAI 兼容接口 `/v1/chat/completions`（多模态对话），见 `docs/grsai-api.md` 第 4 节。

## 目标
编辑任务在任务栏显示一个简短的可读短名（概括编辑意图，如「换背景为雪山」，长度由 `max_tokens` 卡住），替代清一色的 `edit`。

## 方案
编辑任务**提交时**（提示词此刻已知）后台**非阻塞**调一次 grsai `/v1/chat/completions`，让快速模型据原始编辑提示词生成短名，返回后写入任务并刷新卡片。

- **命名时机**：提交即触发，异步、不阻塞生成主流程。卡片可尽早显示名字；命名未回来前先显示占位（`edit` + 时间）。
- **存储位置**：**不再往 `edit.md` frontmatter 塞字段**。每个任务文件夹内新建一个独立的元数据文件 `meta.json`，集中存放任务级元信息（详见下「任务元数据文件」）。提示词 `.md` 回归纯提示词正文。**不改文件夹名**。
- **类型字段**：`title` 要同时挂到「进行中」与「历史」两条链路上——`PendingTask` / `WebviewPendingTask`（命名是提交即触发，此刻任务在进行中列表）与 `Task` / `WebviewTask` 都增 `title?`，卡片优先显示它。`model` 已在 `PendingTask`/`WebviewPendingTask`；`requested`/`succeeded` 也一并补到这两类（进行中卡片即可显示计数）。
- **配置新增**：
  - `namingModel`：命名所用模型，**默认 `gemini-3.5-flash`**（grsai 无 `latest` 别名，用确切 id）。
  - `autoNameEdit`：开关，默认开。
- **提示词**：给模型一段系统/用户指令，要求「只输出简短中文短名，不带标点/解释」，输入为用户的原始编辑提示词（不含模型注入句）。**用 `max_tokens` 硬性卡输出长度**（如 `max_tokens: 16`），而非仅靠提示词约束字数；返回后再 trim 兜底。
- **失败处理**：调用失败 / 超时 / 返回空，静默回退到占位名，绝不影响任务本身。
- **范围**：只命名 edit 任务（生成任务已有来源 md 名）。

## 任务元数据文件 `meta.json`

每个任务文件夹（生成与编辑都建）内写一个 `meta.json`，集中存任务级元信息，取代原先散落在提示词 md frontmatter 的 `source`：

| 字段 | 含义 |
|---|---|
| `source` | 来源（生成 = 来源 md 相对路径；编辑 = `（编辑任务）`）。从提示词 md frontmatter 迁出到这里。 |
| `title` | AI 生成的可读短名（编辑任务）；生成任务可置来源 md 名或留空。命名返回后写入。 |
| `model` | 本次调用的模型名（如 `nano-banana-pro`、`gpt-image-2`）。 |
| `aspectRatio` | 比例（如 `3:4`；gpt-image-2-vip 为换算后的像素值）。 |
| `imageSize` | 分辨率（`1K` / `2K` / `4K`）。 |
| `requested` | 本次总申请生成的图片数（即并发量 / job 数，二者同一含义，只存这一个字段）。 |
| `succeeded` | 成功产出的图片数。随 job 完成累加，任务终结时定稿。 |

> 前提：当前 `buildRequestBody` 不传 `n`/数量参数，**1 个 job 返回 1 张图**，故 `succeeded ≤ requested`，成功率比值不会超 100%。若日后引入多图 `n` 参数，需重新定义分母。

> `aspectRatio` / `imageSize` / `requested` 等生成参数提交时即写入；编辑任务取编辑专属参数（`editConfigView` 结果）。如后续还有其他常用参数（如 provider/baseUrl），同样收进 `meta.json` 这一处。

- **格式**：JSON（原生 `JSON.parse/stringify`，零依赖、解析最快）。全项目统一用 JSON，不引 yaml。
- **写入时机**：建任务文件夹时先写入 `source`/`model`/`requested`（`succeeded:0`）；命名返回写 `title`；每张图下载成功更新 `succeeded`。
- `WebviewTask` / 历史读取改为以 `meta.json` 为准。**测试版不考虑旧任务兼容**：无 `meta.json` 的历史任务不做按文件名推断的回退（可不展示或按缺省占位处理，实现时定）。
- 提示词 `.md` 文件**仍保留**（去掉 frontmatter 后是纯正文归档，文件名仍为来源名 / `edit`）。但 `listHistory` 现靠 `.md` 文件名推断 `promptName` 做展示（`command.ts:197`）的逻辑**作废**——展示字段一律以 `meta.json` 为准，文件名不再用于展示。

**任务卡片展示**：卡片直接呈现 `meta.json` 里的字段——
- `title`（AI 命名短名，编辑任务）作为主标题，配合现有的可读时间；
- `model`（选用模型，如 `nano-banana-pro` / `gpt-image-2`）；
- 生成图片数量，形如 `succeeded/requested`（如 `3/4`），**不带「成功」字样**。前端按成功率 `succeeded/requested` 渲染颜色：**≥75% 绿、≤25% 红、中间黄**。（以 4 图为例：3、4 绿；2 黄；0、1 红。）

**`meta.json` 示例**（编辑任务，路径 `.image-flow/tasks/1750300000000/meta.json`）：

```json
{
  "source": "（编辑任务）",
  "title": "换背景为雪山",
  "model": "nano-banana-pro",
  "aspectRatio": "3:4",
  "imageSize": "1K",
  "requested": 4,
  "succeeded": 3
}
```

生成任务示例（`source` 为来源 md 相对路径，`title` 可置 md 名或留空）：

```json
{
  "source": "docs/产品图.md",
  "title": "产品图",
  "model": "gpt-image-2",
  "aspectRatio": "16:9",
  "imageSize": "2K",
  "requested": 2,
  "succeeded": 2
}
```

**卡片展示示意**：

```
┌──────────────────────────────────────────────┐
│  换背景为雪山                    06-19 14:32   │   ← title + 可读时间
│  nano-banana-pro · 3:4 · 1K          3/4 🟡    │   ← 模型·比例·分辨率 + 成功/申请数（按成功率上色）
│  ┌────┐ ┌────┐ ┌────┐                          │
│  │ img│ │ img│ │ img│   （3 张缩略图）          │
│  └────┘ └────┘ └────┘                          │
└──────────────────────────────────────────────┘

失败任务（0 张成图，保留留痕）：
┌──────────────────────────────────────────────┐
│  换背景为雪山                    06-19 14:32   │
│  nano-banana-pro · 3:4 · 1K          0/4 🔴 ⚠  │   ← 成功率 0 红色，附错误原因
└──────────────────────────────────────────────┘

（🟢/🟡/🔴 仅示意颜色，实际由前端按成功率给 `succeeded/requested` 文本上色，不显示 emoji）
```

## 任务生命周期调整：不再静默删除失败任务

当前「全部 job 提交失败」或「无成图」的任务会被从列表移除、空文件夹被删除（`src/tasks.ts` 的 `cleanupEmptyFolder`、`submitJobs` 全失败分支、`pollOnce` 终结清理）。这会让用户误以为任务根本没创建。改为：

- **保留任务文件夹与 `meta.json`**，即使一张图都没成。不再调用 `cleanupEmptyFolder` 删空夹。
- 失败任务从「进行中」列表移出后，**进入历史并显示失败态**（0/N + 错误原因）。
- `listHistory` 改为以 `meta.json` 存在为准收录任务，而非「有图才收录」，这样零成图的失败任务也能在任务栏留痕。
- 仍保留失败通知（现有 `notifyFinished` 行为不变）。

## 数据流
`submitEdit` → 写 `meta.json`（占位）→ 建任务卡（占位名）→ 后台并发提交生成 job（现有流程）→ **并行**发起命名 chat 调用 → 命名返回后更新 `meta.json` 的 `title` + 内存任务对象 → emit 刷新侧栏。

## API 文档
已齐：`docs/grsai-api.md` 第 4 节 `/v1/chat/completions`（非流式取 `choices[].message.content`）。

命名调用固定走**现有 grsai 全局配置**的 baseUrl/apiKey。与功能三多厂商的交互（命名模型是否随当前厂商切换）暂不在本功能范围。

**命名可用对话模型**（默认 `gemini-3.5-flash`，无 `latest` 别名）：
`gpt-5.5`、`gpt-5.4`、`gemini-3.5-flash`、`gemini-3.1-pro`、`gemini-3.1-flash-lite`、`gemini-3-pro`、`gemini-3-flash`、`gemini-2.5-pro`、`gemini-2.5-flash`。
