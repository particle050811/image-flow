---
name: image-flow
description: 用 image-flow 写绘图提示词、配参考图、出图与跟踪时使用。九条命令：list/fix/preview 列参考图、修引用路径、预览最终提示词；submit 按 md 出图/出视频、edit 图生图改写现成图片（--prompt + --image，不写 md）；query_result/list_task/list_model 查任务与模型档位；favorite 收藏合格产物。
---

# image-flow 参考图命令

本项目用 [image-flow](https://github.com/particle050811/image-flow) 这个 VS Code 扩展调 AI 绘图。它附带一个 CLI 壳，让你（AI）能直接在终端列出可用参考图、修复图片引用路径——你只填命令和 md 路径，其余（发现端口、鉴权、取结果）都在壳里。壳按固定候选端口段（47870~47879）扫描扩展在 127.0.0.1 起的回环 HTTP 服务并自动找到本工作区对应的窗口（token 在 `~/.image-flow/token`，扩展首次激活自动生成），同步请求/响应，工作区内没有任何桥接文件。

## 前提（很重要，不满足会报连不上）

这些命令实际是让**正在运行的 VS Code 扩展**干活，所以：

1. 必须有一个 **VS Code 窗口开着**，且打开的是**本项目工作区**（即本 skill 所在项目的根文件夹）。
2. image-flow 扩展已激活（装了扩展、开机后自动激活）。
3. 素材库已在扩展侧栏「设置」里配置好（`list`/`fix` 的图都从素材库 + md 所在目录找）。
4. `preview` 用的是侧栏当前选中的模型/参数（工作台页配置），跑之前确认那边选对了模型。

如果命令秒级报「连不上 image-flow 扩展」，基本就是窗口没开、或开的是别的工作区窗口；窗口正在重载的一两秒空档壳会自动重试，无需你处理。

## 文件名约定：v.md 视频、i.md 图片

Markdown 文件名后缀决定提示词模式，写提示词前先按目标产物用对后缀：

- 文件名以 **`v.md`** 结尾 → 视频提示词。image-flow 默认只允许 `v.md` 结尾的文件生成视频（防误触发付费视频任务），非 `v.md` 文件选视频模型会被拦截。
- 文件名以 **`i.md`** 结尾 → 图片提示词。侧栏据此自动切到该模式最近用过的模型、模型下拉按模式过滤。
- 其余后缀不限模式，两类模型都能用，但不享受上述自动切模型的便利。

## 命令

脚本随本 skill 分发，就在 skill 目录里，从项目根用相对路径调用即可：

### 1. list —— 列出可用参考图

```bash
node ".claude/skills/image-flow/imgflow.mjs" list "<md文件路径>"
```

输出每行一个 `![别名或文件主名](文件名)`（**只有文件名、没有路径**），例如：

```
![李樱](李樱三视图（手持海王剑）.png)
![机械core](机械core.png)
```

范围 = 该 md **所在目录的全部图片** + **素材库全部图片**（不筛是否写了描述），按文件名去重。
`别名` 来自图片旁同名 `.md` 描述文件里的 `[别名]`；没有描述就用文件主名。

### 2. fix —— 修复图片引用路径

```bash
node ".claude/skills/image-flow/imgflow.mjs" fix "<md文件路径>"
```

把正文里**当前路径解析不到**的图片引用，按文件名在「md 目录 + 素材库（递归）」里找到真实位置，
改写成正确的相对路径并**直接回写 md 文件**。已经正确的引用不动。

输出一份报告：
```
共 3 处引用：修正 2，已正确 0，问题 1

修正：
  李樱三视图（手持海王剑）.png → ../李樱三视图（手持海王剑）.png

问题：
  ✗ 多个候选：core.png
      - D:\...\A\core.png
      - D:\...\B\core.png
```
- **修正**：已自动改好。
- **问题 - 未找到**：素材库/目录里没这个文件名，检查拼写或先把图放进素材库。
- **问题 - 多个候选**：多处有同名文件，无法判定，命令不会乱改——需你手动写明确路径。
- fix 命令若整体出错（如 md 不存在），会以非零退出码 + `ERROR ...` 信息返回。

### 3. preview —— 预览最终提示词（自查引用是否写对）

```bash
node ".claude/skills/image-flow/imgflow.mjs" preview "<md文件路径>"
```

解析 md 正文，构建「替换后的最终提示词」（与侧栏「预览」按钮同一份逻辑），直接输出正文文本。
**不调用生成 API、不消耗额度**。

- 正常时，输出就是会发给绘图后端的最终提示词（图片引用已替换为 `【@图片N】` 占位）。
- **引用有问题时（如图片文件名写错、找不到文件）会直接报错**，以非零退出码 + `ERROR preview: ...`
  返回，不用你再去猜或者等生成失败才发现。写完提示词后应习惯性跑一次 `preview` 自查，
  确认引用都能解析、正文替换符合预期，再交给用户去生成。

## 模型调用命令（submit / edit / query_result / list_task / list_model / favorite）

这六条命令输出 **JSON**，成败看 `gen_status`（`querying`=进行中 / `success` / `fail` + `fail_reason`），
**不要只看退出码**（非零退出码只代表传输层失败，如连不上扩展）。
`edit` 与查询/收藏类命令（query_result/list_task/list_model/favorite）按**当前目录**归属路由到对应
VS Code 窗口，必须在本项目目录下运行（但 `edit --image` 的图片路径不限本项目目录）。

### 4. submit —— 提交生成任务

```bash
node ".claude/skills/image-flow/imgflow.mjs" submit "<md文件路径>" [--model=模型名] [--ratio=3:4] [--resolution=2k] [--generate_num=4] [--param=duration=8] [--poll=秒]
```

md 正文即提示词、`![]()` 引用即有序参考图（文生图/图生图自动合一）。**不传的参数回落该模型在
侧栏的配置**——完全等价「侧栏切到该模型点生成」；传了只影响本次，不改侧栏配置。要点：

- `--model`：裸名跨渠道重名时会报错并列出限定名，用 `渠道:模型名`（如 `jimeng:5.0`）指定。
- `--ratio`/`--resolution`/`--generate_num`/`--param=键=值`：严格按该模型档位校验，
  非法直接 `gen_status:fail` 并列出可选值，不会静默换成别的值。档位先用 `list_model` 查。
- **视频模型只放行 `v.md` 结尾的文件**（防误触发付费视频任务）；视频的时长用 `--param=duration=秒`。
- 响应回显本次**实际生效**的参数（`params` 字段含 provider/model/ratio/resolution/generate_num/video/custom），
  提交后核对一眼，防止误用默认值：

```json
{"submit_id":"260721/153055123","gen_status":"querying","params":{"provider":"grsai","model":"nano-banana-2","ratio":"3:4","resolution":"4K","generate_num":4,"video":false,"custom":{}}}
```

- `--poll=N`：壳内每 1s 查询直到任务终结或超 N 秒，进程退出时输出最终结果。用
  `--poll=300`（图片）/`--poll=900`（视频），一次调用直接拿到成品路径，无需自己轮询。
- **带 `--poll` 必须挂后台跑**（Bash 工具传 `run_in_background: true`），绝不要在前台等：
  出图动辄几分钟到十几分钟，前台会把对话和用户的其它操作全卡住。挂后台后进程退出时你会被自动
  唤醒、stdout 尾部就是最终 JSON，期间可以继续干别的。批量出图同理——**整个 for 循环作为一条
  后台命令提交**，不要一轮一轮在前台等。若确实想立刻拿回控制权，就不带 `--poll`：提交秒回
  `submit_id`，之后用 `query_result` 查。
- 提示词/参考图解析失败会同步返回 `gen_status:fail` + 原因（不会给一个查无此任务的 submit_id）。

### 5. edit —— 编辑模式（图生图，不写 md）

```bash
node ".claude/skills/image-flow/imgflow.mjs" edit --prompt="提示词正文" [--image=<图片路径>]... \
     [--model=] [--ratio=] [--resolution=] [--generate_num=4] [--param=键=值] [--poll=秒]
```

等价「侧栏编辑页：把这些图拖进编辑区 + 输入提示词点生成」。改写现成图片（套滤镜/换风格/局部改动）
用这条，**不用为此新建 md**。要点：

- **一次调用 = 一个任务**，多个 `--image` 是**同一次编辑的多张参考图**（顺序即 图片1/图片2…）。
  想把同一提示词套到 N 张图上，就写 shell 循环调 N 次、每次一个 `--image`，得到 N 个独立任务——
  一次调用不会替你拆成 N 个任务。
- `--prompt`：纯文本，格式同 md 正文，可用 `[主名]` 引用某张图（主名 = 文件名去扩展名），
  如 `--prompt="把 [mc_castle] 改写成真实照片质感"`；不写引用也行，图仍按顺序作参考上传，
  只是正文里没有 `【@图片N】` 指针。省掉 `--image` 就是纯文生图。
- `--image`：可重复；**路径不限本项目目录**（任意本机路径，相对路径按当前目录解析）。
  两张图同名或同主名会被拒（`logo.png` 与 `logo.jpg` 的 `[logo]` 引用会歧义）；
  **只收图片**，音视频会被拒（编辑模式只出图）。
- 参数默认取**编辑页那套配置**（编辑页的模型/比例/分辨率/张数），不是工作台的；`--model` 等按次覆盖，
  等价「编辑页切到该模型点生成」，校验与 `submit` 同规则。**不支持视频模型**。
- 编辑模式**不拼工作台预设提示词模板**（按设计如此），要什么全写进 `--prompt`。
- 输出与 `submit` 同形（`submit_id` + `gen_status` + 回显生效参数），`--poll=N` 同样可用，
  **同样必须挂后台**（见 submit 一节）；产物照常落 `.image-flow/tasks/`，后续用 `query_result` / `favorite`。

批量示例（一批图各套同一段滤镜提示词，逐个出图）——**整个循环作为一条后台命令跑**：

```bash
for f in /d/pics/mc_*.png; do
  node ".claude/skills/image-flow/imgflow.mjs" edit --image="$f" \
    --prompt="保持构图与物体位置不变，把画面改写为真实照片质感……" \
    --generate_num=4 --poll=300
done
```

### 6. query_result —— 查任务进度与产物

```bash
node ".claude/skills/image-flow/imgflow.mjs" query_result --submit_id=260721/153055123 [--poll=秒]
```

- 进行中：`{"gen_status":"querying","progress":42,"requested":4,"done":1,"failed":0,"outputs":[...]}`（已出的产物即时可见）。
- 已终结：`gen_status` 为 `success`/`fail`（部分失败按 fail 报、`fail_reason` 说明成功几张，产物照给）。
- `outputs` 为**绝对路径 + media 类型**（image/video/audio），产物本就自动落盘任务夹，无需下载参数。
- 即梦渠道的任务（进行中/已终结）额外带 `credit`：当前已扣积分（终结后为本次实际总消耗，失败任务同样计费）。`credit` 在 0 消耗或字段缺省时不出现——不要把它的缺席误判成解析失败。

### 7. list_task —— 列任务

```bash
node ".claude/skills/image-flow/imgflow.mjs" list_task [--limit=20]
```

进行中任务（带 progress）在前、已终结历史在后，每项含 submit_id/gen_status/model/ratio/resolution/requested/succeeded/title/source；即梦渠道任务额外带 `credit`（累计消耗积分）。

### 8. list_model —— 列可用模型与档位

```bash
node ".claude/skills/image-flow/imgflow.mjs" list_model
```

默认输出**精简文本**（AI 消费、省 token）：`current`（侧栏当前选中——不传覆盖参数时 submit 会用的值）
+ 图片模型的 `ratio`/`resolution` 档位 + 视频模型只列名字（视频档位不展开，防刷屏）。需要完整原始 JSON
（含各模型 `maxConcurrency`、视频模型 `duration` 档位、`custom` 等）时加 `--full`：

```bash
node ".claude/skills/image-flow/imgflow.mjs" list_model --full
```

### 9. favorite —— 收藏核对合格的产物

```bash
node ".claude/skills/image-flow/imgflow.mjs" favorite --path=<产物绝对路径> [--note=备注]
```

把核对通过的成品收进侧栏**当前收藏夹**，用户在侧栏收藏页即时看到（无需手动刷新）：

- `--path`：产物绝对路径，直接抄 `query_result` 输出的 `outputs[].path`；必须在本工作区内。
- `--note`：一句备注说明**为何选它**（如 `--note=第3张，位置/画风均合格`），侧栏缩略图悬浮可见。
- 幂等：重复收藏不会取消也不会重复入夹（`already_favorited:true` 表示本就已收藏；带 `--note` 会更新备注）。
- 成功响应：`{"gen_status":"success","path":"D:\\...\\1.png","collection":"默认收藏","already_favorited":false,"note":"..."}`。

## 调试模式（--debug）

任意命令后加 `--debug`（或设环境变量 `IMGFLOW_DEBUG=1`），脚本返回时在 stdout 末尾追加一行
`[debug] <本次总耗时>s`，用于量各命令耗时、排查卡顿。可与 `--full`、`--poll` 组合使用。

## 出图张数规则（强制）

- **每批固定生成 4 张**（`submit` 时带 `--generate_num=4`）：以 4 张的平均效果评判提示词好坏，避免被模型单张的偶然发挥（无论好坏）误导而误判提示词。
- **单个出图任务累计上限 40 张**：围绕同一目标反复修提示词重跑，累计生成达到 40 张仍不合格就必须停下，向用户报告已尝试的方案与失败原因，等用户定夺——不要在一个可能无法完成的任务上死循环烧额度。

## 出图后必须查看结果（强制）

`submit`/`query_result` 拿到 `success` 和产物路径**不等于任务完成**。必须用 Read 工具逐张打开产物图片查看，并对照提示词与每张参考图核对：

- 要求改的内容改对了没有（位置、尺寸、朝向）；
- 参考图里的物体外观（颜色、纹理、视角）是否被忠实还原；
- 不该动的部分是否被模型顺手改了（背景、周边结构、画幅、清晰度/柔焦质感）。

任何一项不合格，就修提示词或换方案重跑，不要把没核对过的图交给用户。
核对**通过**的成品随手 `favorite --path=... --note=为何选它`——筛过的成品直接流进侧栏收藏页，用户零点击可见。

## 典型工作流

给某段提示词配参考图并出图时：

1. `list` 看有哪些可用参考图，挑出要用的。
2. 在 md 正文里用**裸文件名**写引用，如 `![李樱](李樱三视图（手持海王剑）.png)`（直接抄 list 输出即可）。
3. `fix` 一把，把这些裸文件名补成正确相对路径。
4. `preview` 自查一遍：确认没有报错、最终提示词符合预期。
5. 需要直接出图时：`list_model` 确认模型与档位 → `submit <md> --generate_num=4 --poll=300`
   （**挂后台跑**，张数按「出图张数规则」固定 4 张）→ 进程退出即拿到 `success` + 产物绝对路径；
   或不带 `--poll` 拿 submit_id 后用 `query_result` 跟踪。
6. 出图成功后按「出图后必须查看结果」一节逐张查看核对，不合格就修正重跑；
   核对通过的成品 `favorite` 收进侧栏收藏夹（带备注），再告知用户。

这样你不用关心图片实际在哪一层目录，也不用碰侧栏：写名字、fix、preview、submit 一条龙。

改写已有图片（套滤镜、换风格、批量处理一批现成图）时不走上面这套，直接 `edit`：
`edit --image=<图片> --prompt="要怎么改" --generate_num=4 --poll=300`，一张图一次调用、循环处理一批；
出图后同样按「出图后必须查看结果」核对、合格的 `favorite`。
