# Grsai API 文档

本文档整理 image-flow 可用的 Grsai 接口，来源于官方 Apifox 文档。

## 通用约定

**基础节点（baseUrl）**

| 节点 | 地址 |
|------|------|
| 国内 | `https://grsai.dakka.com.cn` |
| 全球 | `https://grsaiapi.com` |

**鉴权**：所有接口通过请求头 `Authorization: Bearer sk-xxxxxxxxxxx` 传递 API Key。
获取地址：https://grsai.ai/zh/dashboard/api-keys

**任务状态（status）**：`running`（进行中）、`violation`（违规）、`succeeded`（成功）、`failed`（失败）。

## 接口一览

| 接口 | 方法 | 路径 | 用途 |
|------|------|------|------|
| nano-banana 生成 | POST | `/v1/api/generate` | 文生图 / 图生图（nano-banana 系列） |
| gpt-image-2 生成 | POST | `/v1/api/generate` | 文生图 / 图生图（gpt-image-2 系列） |
| 异步结果查询 | GET | `/v1/api/result` | 查询 `replyType: async` 任务结果 |
| OpenAI 对话 | POST | `/v1/chat/completions` | 多模态对话（含图片理解） |
| OpenAI 图片生成 | POST | `/v1/images/generations` | OpenAI 兼容的图片生成 |

---

## 1. nano-banana 生成接口

- **方法 / 路径**：`POST /v1/api/generate`

**请求体**

| 字段 | 类型 | 必填 | 说明 / 可选值 |
|------|------|------|----------------|
| model | string | 是 | `nano-banana`、`nano-banana-fast`、`nano-banana-2`、`nano-banana-2-cl`、`nano-banana-2-4k-cl`、`nano-banana-pro`、`nano-banana-pro-cl`、`nano-banana-pro-vip`、`nano-banana-pro-4k-vip` |
| prompt | string | 是 | 提示词 |
| images | array[string] | 否 | 参考图，支持 base64 与 url 链接 |
| aspectRatio | string | 否 | `auto`、`1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3`、`5:4`、`4:5`、`21:9`；nano-banana-2 系列额外支持 `1:4`、`4:1`、`1:8`、`8:1` |
| imageSize | string | 否 | `1K`、`2K`、`4K` |
| replyType | string | 否 | `json`（返回 json）、`stream`（流式）、`async`（异步轮询） |

**请求示例**

```json
{
  "model": "nano-banana-2",
  "prompt": "生成一张边牧与古牧正在抖音直播间直播带货截图",
  "images": [],
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "replyType": "json"
}
```

**返回（200）**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 任务 id |
| status | string | 是 | `running` / `violation` / `succeeded` / `failed` |
| results | array[object] | 否 | 每项含 `url`（图片/视频链接） |
| progress | integer | 否 | 进度 0~100 |
| error | string | 否 | 报错信息 |

```json
{
  "id": "14-5f3cf761-a4bb-486a-8016-77f490998f80",
  "status": "succeeded",
  "results": [{ "url": "https://file1.aitohumanize.com/file/xxx.png" }]
}
```

**返回（400）**：`{ id, status: violation|failed, error }`
**异步返回**：`{ id, status: running }`，凭 `id` 调用结果查询接口。

---

## 2. gpt-image-2 生成接口

- **方法 / 路径**：`POST /v1/api/generate`（与 nano-banana 同路径，靠 `model` 区分）

**请求体**

| 字段 | 类型 | 必填 | 说明 / 可选值 |
|------|------|------|----------------|
| model | string | 是 | `gpt-image-2`、`gpt-image-2-vip` |
| prompt | string | 是 | 提示词 |
| images | array[string] | 否 | 参考图，支持 base64 与 url 链接 |
| aspectRatio | string | 否 | 比例或像素值（见下） |
| replyType | string | 否 | `json`、`stream`、`async` |

**aspectRatio 说明**
- `gpt-image-2`：支持比例（如 `16:9`）或 1K 像素值（如 `1024x1024`）
- `gpt-image-2-vip`：支持 1–4K 像素值（如 `2048x2048`），**不支持比例**
- vip 自定义像素约束：最大边长 ≤ 3840px；两边均为 16 的倍数；长短边之比 ≤ 3:1；总像素数在 655,360 ~ 8,294,400 之间

**请求示例**

```json
{
  "model": "gpt-image-2",
  "prompt": "生成一张边牧与古牧正在抖音直播间直播带货截图",
  "images": [],
  "aspectRatio": "1024x1024",
  "replyType": "json"
}
```

**返回**：结构与 nano-banana 接口完全一致（`id` / `status` / `results[].url` / `progress` / `error`）。

---

## 3. 异步结果查询接口

- **方法 / 路径**：`GET /v1/api/result`
- 用于查询 `replyType: async` 提交的任务。

**Query 参数**

| 名称 | 类型 | 必填 | 示例 |
|------|------|------|------|
| id | string | 否 | `1-6634fd9a-3086-4d92-9436-69e86fd23bf8` |

**返回（200）**：`{ id, status, progress?, results?[].url, error? }`，与生成接口一致。
**返回（400）**：`{ id, status: violation|failed, error }`

---

## 4. OpenAI 对话接口（/v1/chat/completions）

- **方法 / 路径**：`POST /v1/chat/completions`
- 用途：多模态对话，可传图片让模型理解。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 支持所有模型 |
| stream | boolean | 是 | 是否流式输出，默认 `true` |
| messages | array | 是 | 消息数组 |
| messages[].role | string | — | 角色，如 `user` |
| messages[].content | string \| array | — | 文本，或多模态数组 |

多模态 `content` 数组元素：
- `{ "type": "text", "text": "..." }`
- `{ "type": "image_url", "image_url": { "url": "https://xxx.png" } }`

**请求示例（图片理解）**

```json
{
  "model": "gemini-3.1-pro",
  "stream": false,
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "这张图片内容是什么" },
      { "type": "image_url", "image_url": { "url": "https://xxxxxxx.png" } }
    ]
  }]
}
```

**返回（非流式）**：标准 OpenAI 结构 `{ id, object, created, model, choices[], usage }`。
- `choices[].message.content` 为回复文本，`choices[].finish_reason` 结束时为 `stop`。
- `usage`：`prompt_tokens` / `completion_tokens` / `total_tokens`。

**流式（stream=true）**：多段 `data:` 开头的 chunk，`choices[].delta.content` 为增量文本，最后一个 chunk 附带 `usage`。

**错误（400）**：`{ "error": { "message": "..." } }`

---

## 5. OpenAI 图片生成接口（/v1/images/generations）

- **方法 / 路径**：`POST /v1/images/generations`
- 用途：OpenAI 兼容的图片生成。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 支持所有图片生成模型 |
| prompt | string | 是 | 提示词 |
| image | array[string] | 否 | 参考图，支持 base64 与 url 链接（注意字段名是 `image`，非 `images`） |
| size | string | 否 | 比例或像素值，规则同 gpt-image-2 的 aspectRatio |
| response_format | string | 否 | 如 `url` |

**请求示例**

```json
{
  "model": "gpt-image-2",
  "prompt": "生成一张边牧与古牧正在抖音直播间直播带货截图",
  "image": [],
  "size": "1024x1024",
  "response_format": "url"
}
```

**返回（200）**

```json
{
  "created": 1777689832,
  "data": [{ "url": "https://file4.aitohumanize.com/file/xxx.png" }],
  "usage": {
    "total_tokens": 6267,
    "input_tokens": 17,
    "output_tokens": 6250,
    "input_tokens_details": {}
  }
}
```

**错误（400）**：`{ "error": { "message": "..." } }`

