# image-flow

在 VS Code 中构建和管理 AI 绘图。右键 Markdown 文件，即可把文件内容作为提示词调用 nano-banana / gpt-image-2 接口生成图片，并自动下载到本地。

## 功能

- 在资源管理器或编辑器里右键 `.md` 文件 → **Image Flow: 生成 AI 图片**
- 读取整个 Markdown 正文作为提示词（prompt）调用接口
- 解析正文中的 `![alt](相对路径)` 作为参考图（图生图），并把图片语法替换为模型可理解的有序引用 `[imageN](文件名)`
- 生成的图片自动下载到 Markdown 同级、以本次生成时间命名的 `task-yyMMddHHmmSS` 文件夹
- 另提供 **Image Flow: 预览替换后的提示词** 命令，不调用接口即可查看替换结果，便于调试

## 使用步骤

1. 打开 VS Code 设置，搜索 `image-flow`，填入 `image-flow.apiKey`
   （从 https://grsai.ai/zh/dashboard/api-keys 获取）
2. 在任意 `.md` 文件上右键，选择 **Image Flow: 生成 AI 图片**
3. 等待生成完成，图片会保存到该 Markdown 同级的 `task-yyMMddHHmmSS` 文件夹（每次生成新建一个）

## 扩展设置

本扩展提供以下设置项（前缀 `image-flow`）：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | `""` | grsai API Key（Bearer token） |
| `baseUrl` | `https://grsai.dakka.com.cn` | API 节点地址（国内 / 全球） |
| `model` | `nano-banana-2` | 使用的模型（nano-banana-2 / nano-banana-pro / gpt-image-2 / gpt-image-2-vip） |
| `aspectRatio` | `3:4` | 图像比例（1:1 / 16:9 / 9:16 / 4:3 / 3:4） |
| `imageSize` | `1K` | 分辨率（1K / 2K / 4K），仅 nano-banana 系列与 gpt-image-2-vip 生效 |

> 注意：`apiKey` 以明文形式存储在 VS Code 设置中。

> 不同模型的参数处理：nano-banana 系列用比例 + 分辨率；gpt-image-2 用比例（忽略分辨率）；gpt-image-2-vip 只接受像素值，扩展会按所选比例 + 分辨率自动换算。

## 已知限制

- 仅支持 `replyType: json` 同步返回模式（未接入 `async` 异步轮询）。
- 参考图通过正文 `![alt](相对路径)` 解析；带 `"title"` 的图片语法或无扩展名的相对路径暂未特殊处理。
