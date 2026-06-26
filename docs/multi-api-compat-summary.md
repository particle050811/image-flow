# 多 API 兼容 / 自定义配置文件改造 · 变更与教训总结

> 本文档汇总「多 API 兼容 + 配置文件化 + 自定义 Provider」整段改造的目标、最终架构、
> 全部关键设计决策，以及本轮实现中踩的坑与返工原因。该整段改动已被 **git 回滚**（回滚到
> `18dd1c6` 之前的状态），本文档保留下来，作为日后**干净重做**的依据。
>
> 回滚范围：`c592f0c`（设计计划）—— `30d5d19`（最新），共 22 个提交。回滚点 `18dd1c6`
> （任务 MD 改造，与本功能无关，保留）。

---

## 1. 目标（要解决什么）

把后端从写死的 Grsai 解耦，让扩展能兼容任意图片生成 API：

1. 删掉「节点」下拉，grsai 默认直连国内。
2. 设置页新增「API」选择器：内置 grsai + 用户自定义 Provider。
3. 自定义 Provider 用本地 JSON 描述，放用户主目录 `~/.image-flow/`。
4. 原存 VS Code `globalState` 的配置迁到本地文件 `~/.image-flow/config.json`。
5. JSON 可定义模型名、调用方式、支持的比例/分辨率、自定义参数（如 quality）。

---

## 2. 最终架构（三层解耦）

**Adapter（调用方式，代码内置）+ Provider（提供商，JSON）+ ParamSet（参数集，JSON）**

### 2.1 Adapter —— 代码内置，有限集合

每个 adapter 封装一种 HTTP 协议（怎么拼请求体、同步/异步、怎么落盘）。模型用 `adapter:"<id>"` 引用。
新协议=加一个 adapter；加模型/换 baseUrl/调参数全靠改 JSON。

| Adapter id | 协议 | 同步/异步 | 参考图入参 | 结果 |
|---|---|---|---|---|
| `grsai-async` | `POST /v1/api/generate` → 轮询 `GET /v1/api/result` | 异步轮询 | `images[]`(base64/url) | `results[].url`，需下载 |
| `openai-images` | `POST /v1/images/generations` | 同步一次返回 | `image[]`(字段名是 `image`) | `data[].url` 或 `b64_json` |
| `gemini-generate` | `POST /v1beta/models/<model>:generateContent` | 同步一次返回 | `contents[].parts[].inline_data`(base64) | `candidates[]...inlineData.data`(base64)，直接解码落盘 |

鉴权统一假设 `Authorization: Bearer <apiKey>`。

Adapter 接口（`src/adapters/types.ts`）要点：
- `kind: 'async' | 'sync'`；`supportsBatch: boolean`（是否支持单请求多图，如 openai 的 `n`）。
- `submit(ctx, prompt, refs, count)`：async 返回 `{jobId}`；sync 直接返回 `{results}`（可多张，url 或 base64）。
- `poll?(ctx, jobId)`：仅 async 实现。
- `ResultItem = {kind:'url';url} | {kind:'base64';data;mime}`；落盘统一处理：url 下载、base64 解码写文件。
- `CallContext` 携带 baseUrl、apiKey、config（含解析后尺寸/比例/custom 参数）。

### 2.2 Provider —— JSON 数据

一个 Provider = 一个后端实例。内置 grsai 是**代码自带**的 Provider（默认可用、无需任何 JSON）；
自定义 Provider 从 `~/.image-flow/providers/*.json` 扫描加载（激活时扫一次，改后重载窗口生效，无 file watch）。

### 2.3 ParamSet —— JSON 数据，可复用

「某类模型支持哪些比例/分辨率/自定义参数」抽成独立文件 `~/.image-flow/params/*.json`，多模型可引用同一个。
模型用 `paramSet:"<id>"` 引用。工作台与编辑区共用同一批模型，各自只在 config 里记自己选了啥。

---

## 3. 文件布局（`~/.image-flow/`，跨工作区全局）

```
~/.image-flow/
  config.json            # 当前选择 + 共用偏好（取代旧 globalState）
  providers/<id>.json    # 每个自定义 Provider 一个文件
  params/<id>.json       # 可复用参数集
```

注意区别于工作区内的 `.image-flow/tasks|favorites`（那些不变）。内置 grsai 不落盘（避免误删默认不可用）。

### 3.1 config.json（取代 globalState；apiKey 不在此，跟随 Provider）

```jsonc
{
  "providerId": "grsai", "model": "nano-banana-2", "aspectRatio": "3:4", "imageSize": "1K",
  "params": {}, "concurrency": 1,
  "editModel": "nano-banana-2", "editAspectRatio": "3:4", "editImageSize": "1K",
  "editParams": {}, "editConcurrency": 1,
  // 共用偏好（不随 Provider 变）
  "workbenchCols": 2, "tasksCols": 2, "favoritesCols": 2,
  "workbenchTabCols": 4, "tasksTabCols": 2, "favoritesTabCols": 2,
  "showThumbActions": true, "autoName": true, "namingModel": "gemini-3.1-flash-lite",
  "modelInjections": {}
}
```

迁移：启动时若 config.json 不存在 → 从旧 globalState+secrets 读出写入一次（旧数据保留不删）。

### 3.2 providers/<id>.json —— **最终形态（关键，重做务必照此）**

> **baseUrl/apiKey 必须在 model 级**，不能在 Provider 级共用一对——不同模型常来自不同渠道、
> 地址与密钥都不同。Provider 级 baseUrl/apiKey 作可选兜底。

```jsonc
{
  "id": "custom", "label": "自定义",
  "models": [
    { "name": "nano-banana-2", "adapter": "grsai-async",  "paramSet": "custom-grsai",
      "baseUrl": "https://渠道A", "apiKey": "keyA" },
    { "name": "gpt-image-2",   "adapter": "openai-images", "paramSet": "custom-openai",
      "baseUrl": "https://渠道B", "apiKey": "keyB" }
  ]
}
```

调用时 url/key 优先取所选 model 自带，缺失才回落 Provider 级；内置 grsai 的 apiKey 仍走 config.apiKey/secrets。

### 3.3 params/<id>.json

```jsonc
{
  "aspectRatios": ["1:1","16:9","9:16","4:3","3:4"],
  "imageSizes": ["1K","2K","4K"],          // 见 §5 尺寸换算
  "custom": [
    { "key":"quality",    "label":"画质",     "options":["low","medium","high","auto"], "default":"high" },
    { "key":"moderation", "label":"审核力度", "options":[], "default":"low" }   // options 空=隐藏固定参数，见 §6
  ]
}
```

---

## 4. 「自定义」UX —— 最终确定的形态（中间走了很多弯路，见 §8）

- 设置页「API」下拉**只有两类**：内置 **Grsai**（无文件）+「**自定义**」。
- 「自定义」对应**唯一一份** `providers/custom.json`，多个 model 写在里面，各 model 自带 url/key。
- 「自定义」始终作为一个下拉项存在（catalog 里没有真 custom 时用合成占位项）。
- 选「自定义」时：缺文件则按默认脚手架**自动创建并打开**供填写；已存在则直接读取切换。
- 已存在的文件不覆盖；手改坏了自行更正。

---

## 5. 尺寸 / 比例换算（openai-images 的关键坑）

直接把 `imageSize`（如 `1024x1024`）发给后端是错的——**丢失了比例信息**：用户选 16:9 时不能发 1024x1024。

正确做法：参数集 `imageSizes` 用档位 `1K/2K/4K`，发送时按「比例 + 档位」换算成真实像素。
复用已有的 `toVipPixels(aspectRatio, imageSize)`（`src/api.ts` 里的 `VIP_PIXEL_TABLE`，含 5 个比例 × 1K/2K/4K）：

| 比例 | 1K | 2K | 4K |
|---|---|---|---|
| 1:1 | 1024x1024 | 2048x2048 | 2880x2880 |
| 16:9 | 1280x720 | 2048x1152 | 3840x2160 |
| 9:16 | 720x1280 | 1152x2048 | 2160x3840 |
| 4:3 | 1152x864 | 2304x1728 | 3264x2448 |
| 3:4 | 864x1152 | 1728x2304 | 2448x3264 |

adapter 里 `resolveImageSize`：`imageSize` 已是 `\d+x\d+` 像素串则原样发，否则走 `toVipPixels`。

---

## 6. 隐藏的固定参数（moderation 那类）

需求：某些参数不想给用户出下拉，但要以固定默认值随请求发送（如 `moderation` 恒为 `low`）。

约定：自定义参数 `options` 为空 `[]` = **前端不渲染下拉**，但其 `default` 仍随请求发送。

实现要点：
- `paramDefaults(paramSet)` 收集所有自定义参数默认值（含隐藏的）。
- 切 Provider（`providerSelectPatch`）/切模型（Workbench/Edit 的 onModel/onEditModel）时把 `params`/`editParams` **播种为默认值**——否则隐藏参数进不了 config.params，发不出去；可见参数也能默认即生效（之前只显示不发）。
- 前端渲染 `ps.custom.filter(c => c.options.length > 0)`。
- 请求体过滤用 `if (v !== undefined && v !== '')`（**不能用 `if (v)`**，否则会吞掉 `'0'`/`'false'` 这类 falsy 但合法的固定值）。

---

## 7. 受影响文件（实现落点）

| 文件 | 改动 |
|---|---|
| `src/providers.ts`（新增） | Provider/ParamSet 类型、内置 grsai、`resolveCatalog`/`resolveRuntimeProviders`/`toCatalog`、`buildCustomScaffold`、`providerSelectPatch`、`paramDefaults`、`CUSTOM_PROVIDER_ID/LABEL` |
| `src/providerRuntime.ts`（新增） | `loadCustom`(扫描 JSON)、`currentProvider`、`resolveCall`(组装 CallContext+adapter，model 级 url/key 优先)、`writeCustomScaffold`(脚手架落盘，不覆盖) |
| `src/adapters/*`（新增） | `types.ts` + `grsaiAsync.ts`/`openaiImages.ts`/`geminiGenerate.ts` + `index.ts`(getAdapter) |
| `src/api.ts` | 改为按 adapter 分发；保留公共 fetch/解析、`requestTaskName`、`toVipPixels` |
| `src/config.ts` | 读写本地 config.json；候选改由 Provider/ParamSet 派生；迁移逻辑；`editConfigView` |
| `src/configStore.ts`（新增） | `mergeStoredConfig`/`DEFAULT_STORED` 纯函数 |
| `src/storage.ts` | `~/.image-flow/` 主目录路径助手 |
| `src/shared.ts` | `ImageFlowConfig`(providerId/params/editParams)；Catalog/CatalogProvider/CatalogModel/ResolvedParamSet/CustomParam 等类型 |
| `src/tasks.ts` | 轮询循环支持 sync adapter；落盘支持 base64；meta 记 providerId/adapter |
| `src/sidebarProvider.ts` | init 下发 Catalog；`selectCustomProvider` 消息；providerId 失效自愈（见 §8 教训） |
| `src/webview/ApiConfig.tsx` | 删节点；API(Provider) 选择器 + 合成「自定义」项 |
| `src/webview/Workbench.tsx`/`Edit.tsx` | 下拉候选来自当前 Provider 的模型+ParamSet；动态渲染 custom 参数；切模型播种默认值 |
| `src/webview/catalog.ts`（新增） | `providerOf`/`modelOf`/`EMPTY_PARAMS` 前端纯助手 |
| `src/webview/vscode.ts` | 透传 Catalog 等类型、`selectCustomProvider` 消息类型 |

---

## 8. 踩坑与返工记录（重做时**直接避开**）

这段是本文档的核心价值——上面的功能点都对，但实现过程反复返工，导致「史山」。

1. **Provider 级 vs model 级 url/key**（最大返工）。最初把 baseUrl/apiKey 放 Provider 级，
   一个文件一对 key。但用户的两个模型来自不同渠道、key 不同 → 无法混用。中间错误地拆成两个
   独立 Provider（custom-grsai/custom-openai 两个下拉项），又被否。**最终正解：一份 custom.json、
   多个 model、url/key 在 model 级**。→ **重做时一步到位放 model 级。**

2. **下拉「新建自定义」入口的演化**。先加了「+ 新建自定义…」哨兵项；又改双 Provider；最后才定为
   「自定义」单项 + 缺文件自动创建。→ **重做直接做「自定义」单项 + 按需创建。**

3. **toCatalog 用 `as CatalogModel[]` 强转泄漏 apiKey**。RuntimeModel 加了 baseUrl/apiKey 后，
   强转不会剥字段，会把 apiKey 下发进 webview catalog。→ **toCatalog 必须显式 map 只留
   `{name,adapter,params}`。**

4. **尺寸直发丢比例**（见 §5）。→ 重做时 openai/gemini adapter 一开始就做「比例+档位→像素」换算。

5. **隐藏固定参数发不出去**（见 §6）。默认值不播种进 config.params 就不会发送；且 `if(v)` 会吞
   falsy 值。→ 重做时把「参数默认值播种」作为切模型/切 Provider 的固定动作。

6. **providerId 失效卡死 + 自愈过度**。删掉 custom.json 后 config.providerId 仍是 `custom`，
   前端合成「自定义」项处于选中态，受控组件选中已选项不触发 onChange → 永远发不出创建消息 →
   下拉全空卡死。第一版自愈「一律回落 grsai 并持久化」又太粗暴（等于用不了自定义）。
   **最终：选了自定义但文件缺失→重建并留在自定义；其它失效→仅本次临时回落 grsai 不写盘。**
   → **重做时：合成项的选择要能稳定触发后端（不依赖 onChange 的值变化），或 init 时若
   providerId=custom 且缺文件就直接重建，从根上避免「选中态卡死」。**

7. **本机 config.json 被工具改写编码**。PowerShell 5.1 `ConvertFrom-Json` 读 UTF-8(无 BOM)
   会把中文注入句读成乱码。→ 改 config.json 用 Edit 工具，别用 PowerShell 读写。

---

## 9. 重做建议（清爽路径）

1. 先落「存储迁移」：globalState → config.json + 迁移兜底。
2. 再落「Adapter 抽象 + 内置 grsai 等价重构」，功能完全等价，单测覆盖 vip 换算。
3. 再落「sync adapter + base64 落盘 + ParamSet + 动态参数」，**openai/gemini 一开始就做尺寸换算**。
4. 最后「UI 收口」：API 选择器 + 「自定义」单项 + 缺文件自动创建。**url/key 一开始就 model 级、
   toCatalog 显式剥密钥、参数默认值播种、合成项选择稳定触发后端**——把 §8 的 7 条当 checklist。
