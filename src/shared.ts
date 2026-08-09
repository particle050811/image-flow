// 扩展主进程（Node）与 Webview 前端（浏览器）共享的类型。
// 纯类型文件——编译后被擦除，对两端环境都安全，不要在此引入 vscode 或 DOM 依赖。
// 这是 Config / Task / 消息协议的唯一定义处，避免在 api.ts、command.ts、webview 各写一份导致漂移。

/** 一个模型上次使用的参数快照：切走时整体记下，切回时校验后恢复（比例/分辨率/并发/自定义参数全独立） */
export interface ModelParamSnapshot {
	aspectRatio: string;
	imageSize: string;
	/** 该模型上次使用的并发数；旧配置的快照无此字段，视为无记忆 */
	concurrency?: number;
	params: Record<string, string>;
}

/** 扩展配置（globalState 存非敏感项 + secrets 存 apiKey） */
export interface ImageFlowConfig {
	apiKey: string;
	baseUrl: string;
	/** 工作台选中模型所属渠道：'grsai' = 内置；'custom' = settings.json 自定义（随模型选择自动切换） */
	providerId: string;
	model: string;
	/** 工作台当前模型的可见自定义参数当前值（如 {quality:'high'}）；内置 grsai 恒空 */
	params: Record<string, string>;
	aspectRatio: string;
	imageSize: string;
	/** 每个 (渠道, 模型) 上次使用的参数快照，切模型时据此恢复（键为渠道限定名，各渠道各模型互相独立） */
	imageSizeMemory: Record<string, ModelParamSnapshot>;
	concurrency: number;
	/** 工作台素材库图片每行显示几张 */
	workbenchCols: number;
	/** 任务栏图片每行显示几张 */
	tasksCols: number;
	/** 收藏页图片每行显示几张 */
	favoritesCols: number;
	/** 工作台选择栏（标签）每行显示几个 */
	workbenchTabCols: number;
	/** 任务栏选择栏（标签）每行显示几个 */
	tasksTabCols: number;
	/** 收藏页选择栏（标签）每行显示几个 */
	favoritesTabCols: number;
	/** 编辑页预设模板标签每行显示几个 */
	templateCols: number;
	/** 模型 → 用户自定义注入句的覆盖表；缺省回退内置默认表 */
	modelInjections: Record<string, string>;
	/** 工作台选中的预设模板名（.image-flow/prompts/ 下文件去扩展名）；'' = 不加载预设。生成/预览时其内容前置进 prompt */
	workbenchTemplate: string;
	/** 视频/图片两种模式各自记忆的工作台预设模板名：跨类切换模型时离开方存入、进入方恢复 */
	workbenchVideoTemplate: string;
	workbenchImageTemplate: string;
	/** 最近使用的视频/图片模型（渠道限定名：qualifiedModel 的 provider+NUL+model 编码）：加载 *v.md / *i.md 时按模式自动恢复 */
	lastVideoModel: string;
	lastImageModel: string;
	/** 编辑页专属模型（与主生成界面互不影响） */
	editModel: string;
	/** 编辑页选中模型所属渠道（随模型选择自动切换） */
	editProviderId: string;
	/** 编辑页专属比例 */
	editAspectRatio: string;
	/** 编辑页专属分辨率 */
	editImageSize: string;
	/** 每个 (渠道, 模型) 上次使用的编辑页参数快照，切模型时据此恢复 */
	editImageSizeMemory: Record<string, ModelParamSnapshot>;
	/** 编辑页专属并发数 */
	editConcurrency: number;
	/** 编辑页当前模型的可见自定义参数当前值（与 params 互不影响） */
	editParams: Record<string, string>;
	/** AI 给任务命名所用的对话模型 */
	namingModel: string;
	/** 命名模型所属渠道 */
	namingProviderId: string;
	/** 是否在提交任务时自动 AI 命名（生成与编辑通用） */
	autoName: boolean;
	/** 缩略图上的收藏 ⭐ / 编辑 ✎ 按钮是否常驻显示（关闭则仅 hover 出现；编辑区除外） */
	showThumbActions: boolean;
	/** 工作台素材库是否显示音频/视频（关闭则只列图片） */
	showAudioVideo: boolean;
	/** 视频模型仅允许文件名以 v.md 结尾的 Markdown 生成（防误触发付费视频任务）；设置页可关 */
	videoOnlyVmd: boolean;
	/** 扩展启动时是否清理「无产物」任务文件夹（顶层无图/音/视频文件的失败留痕，含历史「构建并复制」遗留夹） */
	cleanEmptyTasksOnStartup: boolean;
}

/**
 * 任务级元数据，落盘为任务文件夹内的 meta.json，是任务卡片展示的唯一依据。
 * 取代原先散落在提示词 md frontmatter 的 source。
 */
export interface TaskMeta {
	/** 来源：生成 = 来源 md 相对路径；编辑 = （编辑任务） */
	source: string;
	/** 可读短名：编辑任务由 AI 命名后写入；生成任务为来源 md 名 */
	title?: string;
	/** 本次调用的模型名 */
	model: string;
	/** 比例（gpt-image-2-vip 为换算后像素值） */
	aspectRatio: string;
	/** 分辨率（1K / 2K / 4K） */
	imageSize: string;
	/** 本次总申请生成的图片数（= 并发量 / job 数） */
	requested: number;
	/** 成功产出的图片数，随 job 完成累加 */
	succeeded: number;
	/** 每张成功图片各自的生成耗时（ms，按完成顺序）。源数据：平均生成时间由它派生，失败图片不入列 */
	durations?: number[];
	/** 本次消耗的积分（即梦渠道）：随 job 终结从 CLI 返回的 credit_count 累加（0 不记录，旧任务无此字段） */
	credit?: number;
}

/** 模型可调的一个自定义参数（settings.json 的 custom[] 一项；发请求时塞进 body 的 key=value） */
export interface CustomParam {
	/** 发请求时塞进 body 的参数名 */
	key: string;
	/** UI 上显示的标题 */
	label: string;
	/** 下拉可选值 */
	options: readonly string[];
	/** 默认值，切到该模型时播种进 config.params */
	default: string;
}

/** 发往 webview 的一个图片模型：跨渠道合并列表的一项，同名模型靠 provider 区分；不含 baseUrl/apiKey */
export interface WebviewImageModel {
	/** 所属渠道 id：'grsai' = 内置；'custom' = settings.json 自定义 */
	provider: string;
	/** 渠道展示名（模型下拉分组标题） */
	providerLabel: string;
	/** 模型 API 名 */
	model: string;
	/** 模型展示名 */
	label: string;
	/** 该模型支持的比例 */
	aspectRatios: readonly string[];
	/** 该模型支持的分辨率档位 */
	imageSizes: readonly string[];
	/** 并发上限（并发选择器渲染 1..max）；视频模型 4、其余 10 */
	maxConcurrency: number;
	/** 是否视频模型：编辑页不可用，且默认仅允许 *v.md 文件生成 */
	video?: boolean;
	/** 首次切到该模型（无参数记忆）时的默认参数；缺省沿用切换前的当前值 */
	defaults?: { aspectRatio?: string; imageSize?: string; concurrency?: number };
	/** 该模型可调的自定义参数（可见项），无则空数组 */
	custom: readonly CustomParam[];
}

/**
 * 各配置项的可选值，供侧栏下拉渲染。合并全部渠道（内置 grsai + 可用的自定义）的模型，
 * 前端用 (providerId, model) 二元组索引；不含任何 baseUrl/apiKey。
 */
export interface ConfigOptions {
	/** 全部渠道的图片模型（按渠道分组的顺序排列） */
	imageModels: readonly WebviewImageModel[];
}

/** 媒体大类：图片 / 音频 / 视频。前后端共享单一来源（util/images 的判定函数复用此类型） */
export type MediaType = 'image' | 'audio' | 'video';

/** 扩展内部产出的一张图片：仅含文件引用（file Uri 字符串） */
export interface TaskImage {
	name: string;
	uri: string;
	/** 同目录下存在同主名 .md 描述文件（素材库扫描时打标：排序靠前、插入引用时附带描述） */
	hasDesc?: boolean;
	/** 媒体大类，仅素材库扫描会产出音/视频；缺省按图片处理（任务产物恒为图片） */
	media?: MediaType;
}

/** 扩展内部的一个生成任务（对应一个 task-* 文件夹） */
export interface Task {
	folder: string;
	images: TaskImage[];
	/** 任务文件夹内归档的提示词 .md 主名（生成 = 来源 md 名，编辑 = edit），旧任务（无 meta.json）回退展示用 */
	promptName?: string;
	/** 任务元数据（meta.json），新任务必有；旧任务为 undefined，回退用 promptName */
	meta?: TaskMeta;
}

/** 发往 webview 的图片：额外带 webview 可加载的 src（asWebviewUri 转换结果，已有缩略图时为缩略图） */
export interface WebviewImage extends TaskImage {
	src: string;
	/** 需要 webview 生成缩略图时下发（sha1(uri+mtime+size)），生成后经 saveThumb 回传落盘 */
	thumbKey?: string;
	/** 该图是否已被收藏（在任一收藏夹中）。后端按 favorites.json 打标，前端只读不比对 */
	favorited?: boolean;
	/** 收藏备注（仅收藏页下发）：CLI favorite --note 写入，悬浮提示展示「为何选它」 */
	note?: string;
}

export interface WebviewTask {
	folder: string;
	images: WebviewImage[];
	/** 来源 md 名（编辑任务为 edit），旧任务回退展示用 */
	promptName?: string;
	/** 任务元数据（meta.json），新任务必有 */
	meta?: TaskMeta;
}

/** 一个素材库（对应一个文件夹，递归扫描出的图片） */
export interface MaterialLibrary {
	folder: string;
	name: string;
	images: TaskImage[];
}

/** 发往 webview 的素材库：图片带 asWebviewUri 转换后的 src */
export interface WebviewLibrary {
	folder: string;
	name: string;
	images: WebviewImage[];
}

/** 预设提示词模板：name 为文件名去扩展名，content 为全文 */
export interface PromptTemplate {
	name: string;
	content: string;
}

/** 前端状态条形状：提示文案 + 是否为错误态 */
export interface StatusState {
	text: string;
	error: boolean;
}

/** 编辑区图片（发往 webview）：src 为 data URI——已有压缩展示图时为展示图，否则为原图 */
export interface WebviewEditImage {
	name: string;
	src: string;
	/** 媒体大类，缺省按图片渲染；音/视频改用原生 <video>/占位块 */
	media?: MediaType;
	/** 原图较大且尚无压缩展示图时为 true，webview 据此生成并经 saveEditThumb 回传 */
	needsThumb?: boolean;
}

/** 异步生成中单个 job 的状态（对应一次 generate 提交、一个远端 job id） */
// submitting：本地已建卡、generate 请求尚未拿到 job id 的中间态。
// 这样点生成可立即建卡返回，不必干等网络往返；拿到 id 后转 running。
export type JobStatus = 'submitting' | 'running' | 'succeeded' | 'failed' | 'violation';

/** 一次异步提交对应的 job：远端 id + 状态。succeeded 后不再轮询即不会重复下载 */
export interface PendingJob {
	/** 远端任务 id；submitting 态尚未拿到，转 running 时写入 */
	id?: string;
	status: JobStatus;
	error?: string;
	/** 远端返回的生成进度 0~100，仅 running 态有意义 */
	progress?: number;
	/** 本 job 开始提交的时刻（ms）：成功落盘时据此算单图生成耗时；持久化以跨重启续算 */
	startedAt?: number;
	/** 本 job 终结时远端返回的积分消耗（即梦 query_result 的 credit_count）；其余渠道/未终结缺省 */
	creditCount?: number;
}

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
	/** 任务文件夹的绝对 Uri 字符串。globalState 跨工作区共享，续拉时不能依赖当前窗口的工作区根定位 */
	dir: string;
	/** 产出图片文件名前缀：生成任务为 md 名，编辑任务为 edit */
	prefix: string;
	/** 来源 md 的 Uri 字符串（仅 generate，用于追溯） */
	mdUri?: string;
	/** 提交时所属 Provider（grsai/custom）；轮询按任务自身的 provider+model 解析协议，
	 *  不受用户事后切换模型/Provider 影响。旧持久化任务无此字段，回退当前配置。 */
	providerId?: string;
	model: string;
	/** 是否 sync adapter（提交即整图生成、无独立 job id）。sync 时前端把「提交中」显示为「生成中」 */
	sync?: boolean;
	/** AI 命名的可读短名（编辑任务），命名返回后写入；未命名前为 undefined */
	title?: string;
	/** 任务元数据（落盘 meta.json），succeeded/title 随进度更新后回写 */
	meta: TaskMeta;
	/** 创建阶段：建卡即置 true，后台解析提示词/归档参考图（视频参考可达数十 MB）完成后转 false 开始提交。
	 *  创建中的任务不持久化（尚无可续拉的 job），重启即消失 */
	creating?: boolean;
	jobs: PendingJob[];
	/** 已成功下载到文件夹的图片，随 job 完成累加 */
	images: TaskImage[];
	/** 创建时间（ms），用于超时兜底。注意 resume() 会按会话起算重置它，不代表真实墙钟年龄 */
	createdAt: number;
	/** 任务首次提交时间（ms），仅用于显示已进行时间；resume() 不重置，保留真实墙钟年龄 */
	startedAt: number;
}

/** 发往 webview 的进行中任务：聚合进度 + 已存缩略图（带 src） */
export interface WebviewPendingTask {
	id: string;
	folder: string;
	model: string;
	/** 比例（与历史卡片同源，取 meta.aspectRatio），用于详情头与历史一致展示 */
	aspectRatio: string;
	/** 分辨率（与历史卡片同源，取 meta.imageSize） */
	imageSize: string;
	/** AI 命名的可读短名（编辑任务），命名返回后展示，未命名前为 undefined */
	title?: string;
	/** 来源 md 名（编辑任务为 edit），即产出图片文件名前缀 */
	promptName: string;
	total: number;
	done: number;
	failed: number;
	/** 创建阶段（解析提示词/归档参考图中），前端把「提交中」显示为「创建中」 */
	creating?: boolean;
	/** 仍在提交（尚未拿到 job id）的 job 数，>0 表示任务处于「提交中」阶段，前端据此区分提交/生成 */
	submitting: number;
	/** 是否 sync adapter：sync 的提交即整图生成，前端把「提交中」阶段显示为「生成中」 */
	sync?: boolean;
	/** 整任务聚合进度 0~100：已完成 job 记满分，running job 取远端进度均摊 */
	progress: number;
	/** 任务首次提交时间（ms），前端据此显示已进行时间（真实墙钟，不随重启重置） */
	startedAt: number;
	/** 已终结 job 累加的积分消耗（即梦渠道）：进行中实时累加、未扣费任务缺省，前端据此显示当前花费 */
	credit?: number;
	errors: string[];
	images: WebviewImage[];
}

/** 收藏的一张图：绝对 file Uri 字符串 + 可选备注 + 收藏时间 */
export interface FavoriteItem {
	uri: string;
	note?: string;
	addedAt: number;
}

/** 一个收藏夹：不可变 id + 可改 name + 图片项 */
export interface FavoriteCollection {
	id: string;
	name: string;
	createdAt: number;
	items: FavoriteItem[];
	/** 上次导出选定的父目录（file Uri 字符串），下次导出对话框据此回到该目录 */
	lastExportDir?: string;
}

/** 收藏数据全文（落 .image-flow/favorites.json）；activeCollectionId = 左键收藏的目标夹 */
export interface FavoritesData {
	version: 2;
	activeCollectionId: string;
	collections: FavoriteCollection[];
}

/** 发往 webview 的收藏夹：图片带 asWebviewUri 后的 src */
export interface WebviewCollection {
	id: string;
	name: string;
	images: WebviewImage[];
}

/** 扩展 → 前端 */
export type InboundMessage =
	| { type: 'config'; config: ImageFlowConfig; options: ConfigOptions }
	| { type: 'activeMd'; name: string | null }
	/** seq：扫描开始时刻的单调递增序号。历史扫盘慢且多次刷新不串行，旧扫描可能晚到；前端丢弃 seq 更小的推送 */
	| { type: 'history'; tasks: WebviewTask[]; seq: number }
	/** seq：与 unreadFolders 共用一个序号（两者是同一进行中列表的快照），按捕获时刻排序应用、丢弃更旧的 */
	| { type: 'pendingTasks'; tasks: WebviewPendingTask[]; seq: number }
	/** 进行中任务的 folder 快照（任务变更瞬间内存直出、抢在慢的历史扫盘前送达），前端据此登记未读 */
	| { type: 'unreadFolders'; folders: string[]; seq: number }
	| { type: 'status'; message: string }
	| { type: 'error'; message: string }
	| { type: 'busy'; busy: boolean }
	| { type: 'libraries'; libraries: WebviewLibrary[] }
	| { type: 'autoLibraries'; libraries: WebviewLibrary[] }
	| { type: 'promptTemplates'; templates: PromptTemplate[] }
	| { type: 'revealTask'; folder: string }
	| { type: 'editImages'; images: WebviewEditImage[] }
	| { type: 'favorites'; collections: WebviewCollection[]; activeCollectionId: string };

/** 前端 → 扩展 */
export type OutboundMessage =
	| { type: 'init' }
	| { type: 'saveConfig'; patch: Partial<ImageFlowConfig> }
	| { type: 'openProviderSettings' }
	| { type: 'jimengLogin' }
	| { type: 'generate' }
	| { type: 'previewRequest' }
	| { type: 'openImage'; uri: string }
	| { type: 'insertImage'; uri: string }
	| { type: 'openExternal'; url: string }
	| { type: 'refreshHistory' }
	| { type: 'refreshAutoLibraries' }
	| { type: 'addLibrary' }
	| { type: 'removeLibrary'; folder: string }
	| { type: 'editUpload' }
	| { type: 'editAddImages'; uris: string[] }
	| { type: 'editAddImagesData'; items: { name: string; data: string }[] }
	| { type: 'editRemoveImage'; name: string }
	| { type: 'editClearImages' }
	| { type: 'editOpenImage'; name: string }
	| { type: 'editGenerate'; prompt: string }
	| { type: 'editPreviewRequest'; prompt: string }
	| { type: 'openPrompt'; folder: string }
	| { type: 'refreshTemplates' }
	| { type: 'saveThumb'; key: string; data: string }
	| { type: 'saveEditThumb'; name: string; srcLength: number; data: string }
	| { type: 'toggleFavorite'; uri: string }
	| { type: 'moveFavoriteTo'; uri: string; collectionId: string }
	| { type: 'renameImage'; uri: string }
	| { type: 'setActiveCollection'; collectionId: string }
	| { type: 'createCollection' }
	| { type: 'renameCollection'; id: string }
	| { type: 'deleteCollection'; id: string }
	| { type: 'exportCollection'; collectionId: string };
