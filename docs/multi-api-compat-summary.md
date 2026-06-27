# 多 API 兼容 / 自定义配置文件改造 · 变更与教训总结

> **状态（2026-06-27）**：已按本文档「干净重做」完成，分三个提交落地——
> `b28186e`（Phase 1：adapter 抽象 + grsai 等价重构）、`ce3e31d`（Phase 2：openai-images /
> gemini 同步 adapter + 自定义参数透传）、`d788719`（Phase 3：UI 收口 + Provider 数据模型 +
> settings.json 加载）。数据结构最终采用**方案 A**：把按模型的候选数据扩进现有 `ConfigOptions`
> （未新建独立 `Catalog` 类型 / `catalog.ts`），功能与本文等价、改动面更小。下文保留作设计依据与教训。
>
> 本文档汇总「多 API 兼容 + 自定义模型（单文件 JSON）」整段改造的目标、最终架构、
> 全部关键设计决策，以及本轮实现中踩的坑与返工原因。该整段改动已被 **git 回滚**（回滚到
> `18dd1c6` 之前的状态），本文档保留下来，作为日后**干净重做**的依据。
>
> 注：原方案含「配置 globalState → config.json 文件化」，重做已**改为配置仍留 globalState**（见 §1、§3.1）。
>
> 回滚范围：`c592f0c`（设计计划）—— `30d5d19`（最新），共 22 个提交。回滚点 `18dd1c6`
> （任务 MD 改造，与本功能无关，保留）。

---

## 1. 目标（要解决什么）

把后端从写死的 Grsai 解耦，让扩展能兼容任意图片生成 API：

1. 设置页新增「API」选择器：内置 grsai + 用户自定义。
2. 自定义用**唯一一份**本地 JSON 描述：`~/.image-flow/settings.json`。
3. settings.json 可定义模型名、调用方式、支持的比例/分辨率、自定义参数（如 quality）。
4. 配置（当前选择 + 共用偏好）**继续存 VS Code `globalState`**，不文件化、不迁移。

### 1.1 当前代码现状（重做起点 —— 已具备的别再做一遍）

> 本节按真实代码核对，避免把「早做完的」当成待办（如「删节点下拉」其实已删）。

- **「节点」下拉早已删除**（commit `1e121bd`「隐藏节点/命名模型下拉」，不在本功能回滚范围内）：
  webview 不渲染节点选择，`baseUrl` 固定 `https://grsai.dakka.com.cn`（国内）。**但**残留未清：
  `config.ts` 的 `CONFIG_OPTIONS.baseUrl`（国内/全球节点选项）、`DEFAULTS.baseUrl`，以及
  `shared.ts` 的 `baseUrl` 字段、`BaseUrlOption` 类型、`ConfigOptions.baseUrl`。
  → 重做时：grsai 沿用这个固定 baseUrl；自定义模型 baseUrl 取 settings.json 的 model 级；残留可顺手清。
- **配置本就在 globalState**（`config.ts` 的 `STATE_KEY` = `image-flow.config`，apiKey 在 secrets），
  从未文件化 → 「不迁移」是天然现状，**无需写任何迁移/兜底逻辑**。
- **adapter / provider / params 代码全无**（那轮改造已整体回滚）：`src/providers.ts`、
  `src/providerRuntime.ts`、`src/adapters/*` 均不存在；`api.ts` 仍是写死 grsai 的单体
  （`submitGeneration`/`queryResult`/`requestTaskName` 直接拼 `${config.baseUrl}/v1/...`）。
  §2、§7 列的都是**要新建**的。
- `ImageFlowConfig` 现在**没有** `providerId`/`params`/`editParams` 字段，待 §7 新增。
- **命名模型 `namingModel` 现状**：值在 globalState（默认 `gemini-3.1-flash-lite`），下拉同在
  commit `1e121bd` 隐藏；`api.ts` 的 `requestTaskName` 打 `${config.baseUrl}/v1/chat/completions`，
  即**相乘于 grsai 的 baseUrl/apiKey**。→ 重做后 grsai 仍走这条（globalState.namingModel + secrets）；
  自定义时命名改从 settings.json 的 `chat[]` 取（按 `namingModel` 选其一，自带 url/key）。
- `toVipPixels` / `VIP_PIXEL_TABLE` 已在 `api.ts`（§5 直接复用，勿重写）。
- `ApiConfig.tsx` 现状：顶部直接是「API Key」输入框，**还没有** API/Provider 选择器（§4 要加的）。

---

## 2. 最终架构（两层解耦）

**Adapter（调用协议，代码内置）+ Provider（单文件 JSON，模型按输出类型分组、参数内联进 model）**

模型按**输出类型**组织：`image`（图片生成）、`chat`（对话，当前用于 AI 命名），未来可同构扩展
`video`/`audio`。每个类型下是一批模型，每个模型用 `adapter` 指明走哪种协议。

### 2.1 Adapter —— 代码内置，有限集合（按输出类型）

每个 adapter 封装一种 HTTP 协议（怎么拼请求体、同步/异步、怎么落盘）。模型用 `adapter:"<id>"` 引用。
新协议=加一个 adapter；加模型/换 baseUrl/调参数全靠改 JSON。

**图片类**（`image[]` 的模型用）：

| Adapter id | 协议 | 同步/异步 | 参考图入参 | 结果 |
|---|---|---|---|---|
| `grsai-async` | `POST /v1/api/generate` → 轮询 `GET /v1/api/result` | 异步轮询 | `images[]`(base64/url) | `results[].url`，需下载 |
| `openai-images` | `POST /v1/images/generations` | 同步一次返回 | `image[]`(字段名是 `image`) | `data[].url` 或 `b64_json` |
| `gemini-generate` | `POST /v1beta/models/<model>:generateContent` | 同步一次返回 | `contents[].parts[].inline_data`(base64) | `candidates[]...inlineData.data`(base64)，直接解码落盘 |

**对话类**（`chat[]` 的模型用）：

| Adapter id | 协议 | 同步/异步 | 入参 | 结果 |
|---|---|---|---|---|
| `openai-chat` | `POST /v1/chat/completions`（非流式） | 同步一次返回 | `messages[]` | `choices[0].message.content`（文本） |

> 现状即等价于 `api.ts` 的 `requestTaskName`（已在打 `/v1/chat/completions`），`openai-chat` 把它收成一个 adapter。
> 未来 `video`/`audio` 再各加对应 adapter（如 `*-async` 轮询取结果），结构不变。

鉴权统一假设 `Authorization: Bearer <apiKey>`。

图片 adapter 接口（`src/adapters/types.ts`）要点：
- `kind: 'async' | 'sync'`；`supportsBatch: boolean`（是否支持单请求多图，如 openai 的 `n`）。
- `submit(ctx, prompt, refs, count)`：async 返回 `{jobId}`；sync 直接返回 `{results}`（可多张，url 或 base64）。
- `poll?(ctx, jobId)`：仅 async 实现。
- `ResultItem = {kind:'url';url} | {kind:'base64';data;mime}`；落盘统一处理：url 下载、base64 解码写文件。
- `CallContext` 携带 baseUrl、apiKey、config（含解析后尺寸/比例/custom 参数）。

对话 adapter 接口更简单，不复用上面的 submit/poll：`chat(ctx, messages) → string`，一次返回文本即可。

### 2.2 Provider —— 单文件 JSON

内置 grsai 是**代码自带**的 Provider（默认可用、无需任何 JSON）；自定义 Provider 从
**唯一一份** `~/.image-flow/settings.json` 读取（激活时读一次，改后重载窗口生效，无 file watch）。
「自定义」始终只有一个，文件顶层是按输出类型分组的对象 `{ image:[], chat:[], … }`。

### 2.3 参数 —— 内联进每个 model

不再有独立的 ParamSet 文件/概念。图片模型「支持哪些比例/分辨率/自定义参数」直接写在该 model
对象上（`aspectRatios`/`imageSizes`/`custom`）；对话模型只需 `model`/`label`/`baseUrl`/`apiKey`
（无这些图片专属字段）。多模型若参数相同就各写一份（单文件、直观优先）。
工作台与编辑区共用同一批 `image[]` 模型，各自只在 globalState 里记自己选了啥。

---

## 3. 文件布局（`~/.image-flow/`，跨工作区全局）

```
~/.image-flow/
  settings.json          # 唯一一份：按输出类型分组的对象 { image:[], chat:[], … }，参数内联进每个 model
```

只有这一个文件。配置（当前选择 + 共用偏好）仍在 VS Code `globalState`，不落盘、不迁移。
注意区别于工作区内的 `.image-flow/tasks|favorites`（那些不变）。内置 grsai 不写进 settings.json
（避免误删默认不可用）。

### 3.1 配置仍在 globalState（不变）

`model/aspectRatio/imageSize/concurrency` 及编辑区对应字段、共用偏好
（`workbenchCols`、`autoName`、`namingModel`、`modelInjections` 等）已在 `globalState`，照旧不动，
apiKey 仍走 secrets（内置 grsai）。**无 config.json、无迁移兜底逻辑。** 本次**新增**
`providerId`（记当前选 grsai 还是 custom）+ `params`/`editParams`（custom 可见参数当前值）三个字段；
选 custom 时具体某个 model 的 url/key 从 settings.json 取。

### 3.2 settings.json —— **最终形态（关键，重做务必照此）**

> **baseUrl/apiKey 在 model 级**，不能在 Provider 级共用一对——不同模型常来自不同渠道、
> 地址与密钥都不同。参数（比例/分辨率/custom）也**内联进每个 model**，无独立 paramSet。

> 文件顶层是按输出类型分组的对象。`image[]` 供工作台/编辑共用，`chat[]` 供 AI 命名（按
> globalState 的 `namingModel` 选其一）。未来 `video`/`audio` 同构追加键即可。

```jsonc
{
  // —— 图片生成模型：globalState.model / editModel 选其一 ——
  "image": [
    {
      "model": "nano-banana-2",// API 调用名：提交请求时发给后端的模型标识
      "label": "Nano Banana 2",// 展示名：下拉里给用户看的名字
      "adapter": "grsai-async",// 调用协议，可选 "grsai-async" | "openai-images" | "gemini-generate"
      "baseUrl": "https://grsai.dakka.com.cn",// 该模型的 api 地址
      "apiKey": "Your API Key",// 该模型的密钥
      "aspectRatios": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4"], // 比例下拉可选项；全部可选（含 3:2/21:9/1:3 等）见 §5
      "imageSizes": ["1K", "2K", "4K"], // 分辨率档位下拉，发送时按「比例+档位」换算成像素
      "custom": []             // 该模型额外可调参数：空数组=没有
    },
    {
      "model": "gpt-image-2",
      "label": "GPT Image 2",
      "adapter": "openai-images",
      "baseUrl": "https://yunwu.ai/v1",
      "apiKey": "Your API Key",
      "aspectRatios": ["1:1", "16:9", "9:16", "4:3", "3:4"],
      "imageSizes": ["1K", "2K", "4K"],
      "custom": [               // 额外参数：（如 OpenAI 独有的 quality）
        {
          "key": "quality",     // 发请求时塞进 body 的参数名
          "label": "输出质量",   // UI 上显示的标题
          "options": ["low", "medium", "high", "auto"], // 下拉可选值
          "default": "low"      // 默认值，切到该模型时播种进 globalState 的 params
        }
      ]
    }
  ],
  // —— 对话模型：当前用于 AI 任务命名，globalState.namingModel 选其一 ——
  "chat": [
    {
      "model": "gemini-3.1-flash-lite",// API 调用名
      "label": "Gemini 3.1 Flash Lite",// 展示名
      "adapter": "openai-chat",// 对话协议；可选，缺省即 OpenAI 兼容 /v1/chat/completions
      "baseUrl": "https://grsai.dakka.com.cn/v1",// OpenAI 兼容根地址
      "apiKey": "Your API Key"
    }
  ]
  // 预留：未来 "video": [...]、"audio": [...] 同构扩展
}
```

调用时直接取所选 model 自带的 url/key/参数；内置 grsai 的 apiKey 仍走 secrets。
像 moderation 那类「不给用户出下拉、恒发固定值」的参数不进 `custom[]`，由 adapter 写死（见 §6）。
`chat[]` 可选——缺省或空则不自动命名（合流到「命名失败回退占位名」，`autoName` 开关照常生效）。

---

## 4. 「自定义」UX —— 最终确定的形态（中间走了很多弯路，见 §8）

**位置**：设置页**最顶部**加一行「API」选择器，在现有「API Key」输入框之上。

- 「API」选择器**只有两项**：内置 **Grsai** + 「**自定义**」。选中值即 `config.providerId`（grsai / custom），存 globalState。
- 选 **Grsai** → 下面照旧渲染 grsai 的「API Key」输入框（key 走 secrets）。
- 选 **自定义** → **不渲染**那个「API Key」输入框（自定义的 key 在 settings.json 每个 model 里自带）。
- 选择器**右侧**放一个「**打开配置文件**」按钮：点它打开 `~/.image-flow/settings.json`。
- **文件不存在则先自动创建**默认脚手架（内容即 §3.2 的示例对象 `{ image:[], chat:[] }`）再打开；已存在则直接打开。
- 已存在的文件**不覆盖**；用户手改坏了自行更正。
- 「自定义」始终作为一项存在（catalog 里没有真 custom 时用合成占位项），保证能选中并触发上述创建/打开。

**候选来源随 provider 切换**（grsai = 内置列表；custom = settings.json 按类型取）：
- 工作台/编辑的模型下拉 ← `image[]`（grsai 时为内置图片模型列表）。
- 命名模型（`namingModel`）← `chat[]`（grsai 时为内置 gemini/gpt 列表）。
- 前端逻辑统一：换 provider 只换候选来源，选中值仍存 globalState 的同一批字段。

---

## 5. 尺寸 / 比例换算（openai-images 的关键坑）

直接把 `imageSize`（如 `1024x1024`）发给后端是错的——**丢失了比例信息**：用户选 16:9 时不能发 1024x1024。

正确做法：model 内联的 `imageSizes` 用档位 `1K/2K/4K`，发送时按「比例 + 档位」换算成真实像素。
复用 `toVipPixels(aspectRatio, imageSize)`（`src/api.ts` 里的 `VIP_PIXEL_TABLE`）。本次把表**扩到 15 个比例
+ `auto`**（来源：gpt-image-2-vip 官方比例参考）：

| 比例 | 1K | 2K | 4K |
|---|---|---|---|
| 1:1 | 1024x1024 | 2048x2048 | 2880x2880 |
| 16:9 | 1280x720 | 2048x1152 | 3840x2160 |
| 9:16 | 720x1280 | 1152x2048 | 2160x3840 |
| 4:3 | 1152x864 | 2304x1728 | 3264x2448 |
| 3:4 | 864x1152 | 1728x2304 | 2448x3264 |
| 3:2 | 1536x1024 | 2048x1360 | 3504x2336 |
| 2:3 | 1024x1536 | 1360x2048 | 2336x3504 |
| 5:4 | 1120x896 | 2240x1792 | 3200x2560 |
| 4:5 | 896x1120 | 1792x2240 | 2560x3200 |
| 21:9 | 1456x624 | 2912x1248 | 3840x1648 |
| 9:21 | 624x1456 | 1248x2912 | 1648x3840 |
| 1:3 | —（无 1K） | 688x2048 | 1280x3840 |
| 3:1 | —（无 1K） | 2048x688 | 3840x1280 |
| 2:1 | 1536x768 | 3072x1536 | 3840x1920 |
| 1:2 | 768x1536 | 1536x3072 | 1920x3840 |

实现注意：
- **`auto`**：是合法比例值但**不换算**，直接发 `"auto"`（vip 接受，让后端定尺寸）。`toVipPixels` 命中 `auto` 即原样返回。
- **极端比例 `1:3` / `3:1` 无 1K 档**（官方只给 2K/4K）：用户若在这两个比例下选 1K，换算时**并到最近可用档**（2K），别让 `row['1K']` 取到 `undefined`。
- **只有 `gpt-image-2-vip` 需要换算**（它「不支持比例、只认像素」）；`nano-banana` 系列直接发 `aspectRatio`+`imageSize`，
  `gpt-image-2`（非 vip）直接发比例字符串（后端自有 1K 像素映射，见 `grsai-api.md`），都不走此表。第三方 `openai-images` 的 `size` 同 gpt-image-2 规则。
- vip 像素硬约束（换算值已满足，自定义像素时需校验）：最大边 ≤ 3840、两边均为 16 倍数、长短边比 ≤ 3:1、总像素 655,360 ~ 8,294,400。
- adapter 里 `resolveImageSize`：`imageSize` 已是 `\d+x\d+` 像素串则原样发，否则走 `toVipPixels`。

> 上表与约束源自官方 Apifox 文档，已同步存入 **`docs/grsai-api.md` §2**（含 gpt-image-2 非 vip 的 1K 映射表）。`1:3`/`3:1` 官方仅给 2 个像素值，按长边维度归 2K/4K。

---

## 6. 固定参数（moderation 那类）—— adapter 内写死

需求：某些参数不想给用户出下拉，但要以固定值随请求发送（如 `moderation` 恒为 `low`）。

约定：**这类参数不进 model 的 `custom[]`**，由对应 adapter 在拼请求体时直接写死。例如 `openai-images`
adapter 固定带上 `moderation: 'low'`。`custom[]` 里只放真正要给用户出下拉的可见参数。

好处：JSON 不必再表达「隐藏」语义，前端无需过滤，固定值也不依赖「播种进 params(globalState)」这条链路，
少一类容易漏发的状态。

实现要点：
- 固定值写在 adapter 拼 body 的代码里，跟随该协议走（换 baseUrl/调可见参数仍靠 JSON，不影响）。
- model 的 `custom[]` 全是可见项，前端直接全渲染，无需 `filter(c => c.options.length > 0)`。
- 可见参数默认值仍要在切 Provider/切模型时**播种为默认值**（写进 globalState 的 params，否则只显示不发）。
- 请求体过滤用 `if (v !== undefined && v !== '')`（**不能用 `if (v)`**，否则会吞掉 `'0'`/`'false'` 这类 falsy 但合法的值）。

---

## 7. 受影响文件（实现落点）

| 文件 | 改动 |
|---|---|
| `src/providers.ts`（新增） | Provider 类型（模型按 `image`/`chat` 分组、参数内联进 model）、内置 grsai、`resolveCatalog`/`toCatalog`、`buildCustomScaffold`、`providerSelectPatch`、`paramDefaults`、`CUSTOM_PROVIDER_ID/LABEL` |
| `src/providerRuntime.ts`（新增） | `loadCustom`(读**单个** `settings.json`、按类型取 `image[]`/`chat[]`)、`currentProvider`、`resolveCall`(组装 CallContext+adapter，取 model 自带 url/key)、`writeCustomScaffold`(脚手架落盘，不覆盖) |
| `src/adapters/*`（新增） | `types.ts`（图片 + 对话两套接口）+ 图片 `grsaiAsync.ts`/`openaiImages.ts`/`geminiGenerate.ts` + 对话 `openaiChat.ts` + `index.ts`(getAdapter) |
| `src/api.ts` | 改为按 adapter 分发；`requestTaskName` 收成 `openai-chat` adapter；保留公共 fetch/解析、`toVipPixels` |
| `src/config.ts` | 仍读写 `globalState`（**不文件化、无迁移**）；新增 `providerId` 字段；候选改由当前 Provider 的 model（含内联参数）派生；`editConfigView` |
| `src/storage.ts` | `~/.image-flow/settings.json` 路径助手 |
| `src/shared.ts` | `ImageFlowConfig`(加 `providerId`/params/editParams)；Catalog/CatalogProvider/CatalogModel/CustomParam 等类型（参数随 model 走，无 ResolvedParamSet） |
| `src/tasks.ts` | 轮询循环支持 sync adapter；落盘支持 base64；meta 记 providerId/adapter |
| `src/sidebarProvider.ts` | init 下发 Catalog；`selectCustomProvider` 消息；providerId 失效自愈（见 §8 教训） |
| `src/webview/ApiConfig.tsx` | 删节点；API(Provider) 选择器 + 合成「自定义」项 |
| `src/webview/Workbench.tsx`/`Edit.tsx` | 下拉候选来自当前 Provider 的 model（含内联参数）；动态渲染 custom 参数；切模型播种默认值 |
| `src/webview/catalog.ts`（新增） | `providerOf`/`modelOf`/`EMPTY_PARAMS` 前端纯助手 |
| `src/webview/vscode.ts` | 透传 Catalog 等类型、`selectCustomProvider` 消息类型 |

> 相比上一版，省去了 `src/configStore.ts`（config.json 合并/迁移已不需要）与 `params/*.json` 这一层。

---

## 8. 踩坑与返工记录（重做时**直接避开**）

这段是本文档的核心价值——上面的功能点都对，但实现过程反复返工，导致「史山」。

1. **Provider 级 vs model 级 url/key**（最大返工）。最初把 baseUrl/apiKey 放 Provider 级，
   一个文件一对 key。但用户的两个模型来自不同渠道、key 不同 → 无法混用。中间错误地拆成两个
   独立 Provider（custom-grsai/custom-openai 两个下拉项），又被否。**最终正解：一份 settings.json、
   多个 model、url/key/参数全内联在 model 级**。→ **重做时一步到位放 model 级。**

2. **下拉「新建自定义」入口的演化**。先加了「+ 新建自定义…」哨兵项；又改双 Provider；最后才定为
   「自定义」单项 + 缺文件自动创建。→ **重做直接做「自定义」单项 + 按需创建。**

3. **toCatalog 用 `as CatalogModel[]` 强转泄漏 apiKey**。RuntimeModel 加了 baseUrl/apiKey 后，
   强转不会剥字段，会把 apiKey 下发进 webview catalog。→ **toCatalog 必须显式 map 只留
   `{name,adapter,params}`。**

4. **尺寸直发丢比例**（见 §5）。→ 重做时 openai/gemini adapter 一开始就做「比例+档位→像素」换算。

5. **固定参数（moderation 那类）放错层**（见 §6）。最初想用「options 空=隐藏」让 JSON 表达固定参数，
   结果默认值不播种进 config.params 就发不出去、且 `if(v)` 会吞 falsy 值，链路又长又易漏。
   → **重做时这类固定值直接写死在 adapter 里**；model 的 `custom[]` 只留可见参数，可见参数默认值仍要播种。

6. **providerId 失效卡死 + 自愈过度**。删掉 custom.json 后 config.providerId 仍是 `custom`，
   前端合成「自定义」项处于选中态，受控组件选中已选项不触发 onChange → 永远发不出创建消息 →
   下拉全空卡死。第一版自愈「一律回落 grsai 并持久化」又太粗暴（等于用不了自定义）。
   **最终：选了自定义但文件缺失→重建并留在自定义；其它失效→仅本次临时回落 grsai 不写盘。**
   → **重做时：合成项的选择要能稳定触发后端（不依赖 onChange 的值变化），或 init 时若
   providerId=custom 且缺文件就直接重建，从根上避免「选中态卡死」。**

7. **本机 JSON 被工具改写编码**。PowerShell 5.1 `ConvertFrom-Json` 读 UTF-8(无 BOM)
   会把中文读成乱码。→ 改 settings.json 用 Edit 工具，别用 PowerShell 读写。（本版 config 已不
   文件化，此坑只剩 settings.json 一处。）

---

## 9. 重做建议（清爽路径）

1. 先落「Adapter 抽象 + 内置 grsai 等价重构」，功能完全等价，单测覆盖 vip 换算（config 仍在
   globalState 不动，只新增 `providerId` 字段，默认 grsai）。
2. 再落「sync adapter + base64 落盘 + model 内联参数 + 动态参数」，**openai/gemini 一开始就做尺寸换算**。
3. 最后「UI 收口」：API 选择器 + 「自定义」单项 + 缺 settings.json 自动创建。**url/key/参数一开始就
   内联在 model 级、toCatalog 显式剥密钥、参数默认值播种进 globalState、合成项选择稳定触发后端**
   ——把 §8 的 7 条当 checklist（其中第 7 条「config.json 编码」已不适用，但 settings.json 同样
   别用 PowerShell 读写、用 Edit）。
