import { useEffect, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import {
	vscode,
	type Config,
	type ConfigOptions,
	type InboundMessage,
	type WebviewTask,
	type WebviewPendingTask,
	type WebviewLibrary,
	type WebviewCollection,
	type WebviewEditImage,
	type PromptTemplate,
	type StatusState,
} from './vscode';
import { useCooldown } from './useCooldown';
import { Workbench } from './Workbench';
import { clearResourceCachesThrottled } from './resourceCache';
import { requestThumbs, requestEditThumbs } from './thumbs';
import { Tasks } from './Tasks';
import { ApiConfig } from './ApiConfig';
import { Edit } from './Edit';
import { Favorites } from './Favorites';

type TabId = 'workbench' | 'edit' | 'tasks' | 'favorites' | 'api';

const TABS: { id: TabId; label: string }[] = [
	{ id: 'workbench', label: '工作台' },
	{ id: 'edit', label: '编辑' },
	{ id: 'tasks', label: '任务' },
	{ id: 'favorites', label: '收藏' },
	{ id: 'api', label: '设置' },
];

/** 未读悬空条目的剪枝保护期：不满此年龄一律不剪，挡并发刷新的过期快照竞态 */
const UNREAD_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 解析任务文件夹标识（yyMMdd/HHmmssSSS，createTaskFolder 的两级格式）为创建时刻 epoch ms；
 * 非该格式返回 null。条目均来自真实任务夹，无需再做月/日越界回环校验。
 */
function folderEpoch(folder: string): number | null {
	if (!/^\d{6}\/\d{9}$/.test(folder)) {
		return null;
	}
	const digits = folder.replace('/', '');
	const n = (a: number, b: number) => Number(digits.slice(a, b));
	return new Date(2000 + n(0, 2), n(2, 4) - 1, n(4, 6), n(6, 8), n(8, 10), n(10, 12), n(12, 15)).getTime();
}

export function App() {
	const [tab, setTab] = useState<TabId>('workbench');
	const [config, setConfig] = useState<Config | null>(null);
	const [options, setOptions] = useState<ConfigOptions | null>(null);
	const [activeMd, setActiveMd] = useState<string | null>(null);
	const [tasks, setTasks] = useState<WebviewTask[]>([]);
	const [pendingTasks, setPendingTasks] = useState<WebviewPendingTask[]>([]);
	const [libraries, setLibraries] = useState<WebviewLibrary[]>([]);
	const [autoLibraries, setAutoLibraries] = useState<WebviewLibrary[]>([]);
	const [collections, setCollections] = useState<WebviewCollection[]>([]);
	const [activeCollectionId, setActiveCollectionId] = useState<string>('c_default');
	const [editImages, setEditImages] = useState<WebviewEditImage[]>([]);
	const [templates, setTemplates] = useState<PromptTemplate[]>([]);
	const [busy, setBusy] = useState(false);
	// 完成通知点「查看」后要定位的任务：folder + nonce（同一任务可重复触发跳转）
	const [reveal, setReveal] = useState<{ folder: string; nonce: number } | null>(null);
	const [genCooling, genCool] = useCooldown(500);
	const [status, setStatus] = useState<StatusState>({ text: '', error: false });
	// 未读任务的文件夹标识集合：任务创建（pendingTasks 推送）即登记，点开即删，常态接近空。
	// 持久化进 webview state（getState/setState），跨重载/重启保留。
	// 登记依赖 webview 活着，而所有生成入口（工作台/编辑页按钮、右键命令、通知「查看」）都先聚焦侧栏；
	// 仅剩「重启后 resume 续拉完成且期间侧栏未打开」会漏标，漏标方向是不亮未读，按产品决策接受。
	const [unreadTasks, setUnreadTasks] = useState<Set<string>>(
		() => new Set(vscode.getState()?.unreadTasks ?? [])
	);
	// 当前进行中任务的文件夹集合：history 推送剪枝未读集合时参照，别把刚创建还没进历史的任务剪掉
	const pendingFoldersRef = useRef<Set<string>>(new Set());
	// 已应用的 history 推送序号：丢弃晚到的旧扫描快照（并发刷新完成顺序不定）
	const historySeqRef = useRef(0);
	// 已应用的进行中快照序号（unreadFolders / pendingTasks 共用）：按捕获时刻排序应用，丢弃更旧的
	const pendingSnapSeqRef = useRef(0);

	// 写回 webview 持久化状态（state 目前仅此一键，整体覆写）
	const persistUnread = (set: Set<string>) => {
		vscode.setState({ unreadTasks: [...set] });
	};

	// 点开已完成任务卡片：消掉未读，清除特效并让角标减一
	const markTaskViewed = (folder: string) => {
		setUnreadTasks((prev) => {
			if (!prev.has(folder)) {
				return prev;
			}
			const next = new Set(prev);
			next.delete(folder);
			persistUnread(next);
			return next;
		});
	};

	// 登记未读（幂等）：不在集合的 folder 加入并持久化
	const registerUnread = (folders: string[]) => {
		setUnreadTasks((prev) => {
			const fresh = folders.filter((f) => !prev.has(f));
			if (!fresh.length) {
				return prev;
			}
			const next = new Set(prev);
			for (const f of fresh) {
				next.add(f);
			}
			persistUnread(next);
			return next;
		});
	};

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
					// 晚到的旧扫描快照直接丢弃：应用它会回退任务列表、还可能把新登记的未读剪掉
					if (msg.seq < historySeqRef.current) {
						break;
					}
					historySeqRef.current = msg.seq;
					setTasks(msg.tasks);
					// 剪枝未读集合：既不在历史也不在进行中的条目（创建失败撤卡、文件夹被清理/手删）移除，防悬空堆积。
					// 年龄护栏挡并发刷新竞态：历史扫盘慢且多次刷新不串行，过期快照可能不含刚创建/刚转历史的任务，
					// 不满 1 天的条目一律保留（悬空至多滞留 1 天，无害），只有陈旧悬空条目才真正剪掉
					setUnreadTasks((prev) => {
						const alive = new Set(msg.tasks.map((t) => t.folder));
						const next = new Set(
							[...prev].filter((f) => {
								if (alive.has(f) || pendingFoldersRef.current.has(f)) {
									return true;
								}
								const created = folderEpoch(f);
								return created !== null && Date.now() - created < UNREAD_PRUNE_MIN_AGE_MS;
							})
						);
						if (next.size === prev.size) {
							return prev;
						}
						persistUnread(next);
						return next;
					});
					// 缺缩略图的大图（带 thumbKey）入队生成回传，下次推送即可用缩略图
					requestThumbs(msg.tasks.flatMap((t) => t.images));
					// 任务完成会带来新的大图，节流清一次资源缓存，限制长会话内的磁盘增长
					clearResourceCachesThrottled();
					break;
				case 'pendingTasks':
					// 晚到的旧快照丢弃：旧 pending 卡片复活会把已完成任务重新登记未读
					if (msg.seq < pendingSnapSeqRef.current) {
						break;
					}
					pendingSnapSeqRef.current = msg.seq;
					setPendingTasks(msg.tasks);
					pendingFoldersRef.current = new Set(msg.tasks.map((t) => t.folder));
					// 登记未读的主路径是 unreadFolders 消息（变更瞬间先行送达），这里兜底 init 重放
					registerUnread(msg.tasks.map((t) => t.folder));
					requestThumbs(msg.tasks.flatMap((t) => t.images));
					break;
				case 'unreadFolders':
					// 任务创建/变更瞬间的进行中快照：登记未读（幂等）。进行中卡片本身不亮未读特效，
					// 任务完成落进历史后特效才生效，点开即消。
					// 它比同一轮刷新的 pendingTasks 先送达，顺带刷新剪枝参照的进行中集合
					if (msg.seq < pendingSnapSeqRef.current) {
						break;
					}
					pendingSnapSeqRef.current = msg.seq;
					pendingFoldersRef.current = new Set(msg.folders);
					registerUnread(msg.folders);
					break;
				case 'libraries':
					setLibraries(msg.libraries);
					requestThumbs(msg.libraries.flatMap((l) => l.images));
					// 素材库同样批量加载大图（增删库/切 MD 刷新），与 history 一样节流清缓存
					clearResourceCachesThrottled();
					break;
				case 'autoLibraries':
					setAutoLibraries(msg.libraries);
					requestThumbs(msg.libraries.flatMap((l) => l.images));
					clearResourceCachesThrottled();
					break;
				case 'editImages':
					setEditImages(msg.images);
					// 大图生成压缩展示图回传，之后的全量重发不再携带原图
					requestEditThumbs(msg.images);
					break;
				case 'favorites':
					setCollections(msg.collections);
					setActiveCollectionId(msg.activeCollectionId);
					requestThumbs(msg.collections.flatMap((c) => c.images));
					break;
				case 'promptTemplates':
					setTemplates(msg.templates);
					break;
				case 'revealTask':
					// 切到任务栏并标记要定位的任务，Tasks 据 nonce 选中对应条目
					setTab('tasks');
					setReveal({ folder: msg.folder, nonce: Date.now() });
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

	// 多字段批量保存：一条 saveConfig 消息、扩展侧一次 globalState 写。模型切换（model/imageSize/记忆）共用
	const saveFields = (patch: Partial<Config>) => {
		setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
		vscode.postMessage({ type: 'saveConfig', patch });
	};

	const switchTab = (id: TabId) => {
		setTab(id);
		if (id === 'tasks') {
			vscode.postMessage({ type: 'refreshHistory' });
		}
		// 工作台与编辑页都用预设模板列表，切到任一页都刷新一遍
		if (id === 'edit' || id === 'workbench') {
			vscode.postMessage({ type: 'refreshTemplates' });
		}
	};

	// 生成：0.5s 冷却防连点（冷却期间按钮禁用，借 busy 视觉态）
	const generate = () => {
		if (!genCool()) {
			return;
		}
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

	// 任务页 ✎：把图加入编辑区并切到编辑页（走 switchTab，顺带刷新模板列表）
	const sendToEdit = (uri: string) => {
		vscode.postMessage({ type: 'editAddImages', uris: [uri] });
		switchTab('edit');
	};

	if (!config || !options) {
		return <div className="page">加载中…</div>;
	}

	// 任务标签角标数：进行中任务 + 历史中未读的任务。
	// 未读集合只经 pendingTasks 推送登记，「构建并复制」（requested=0）等旧口径任务不会在其中。
	const unseenCount = tasks.reduce((n, t) => (unreadTasks.has(t.folder) ? n + 1 : n), 0);
	const taskBadge = pendingTasks.length + unseenCount;

	return (
		<Tabs.Root
			className="tabs-root"
			// 控制缩略图 ⭐/✎ 按钮是否常驻：'true' 常显，'false' 仅 hover（CSS 据此切换）
			data-show-thumb-actions={config.showThumbActions ? 'true' : 'false'}
			value={tab}
			onValueChange={(v) => switchTab(v as TabId)}
		>
			<Tabs.List className="tabs" aria-label="功能切换">
				{TABS.map((t) => (
					<Tabs.Trigger
						key={t.id}
						value={t.id}
						className="tab"
						// 拖图悬停「编辑」标签即切页：缩略图与编辑区不在同一页，拖动中无法点击切换
						onDragEnter={t.id === 'edit' ? () => switchTab('edit') : undefined}
					>
						{t.label}
						{t.id === 'tasks' && taskBadge > 0 && (
							<span className="tab-badge">{taskBadge > 99 ? '99+' : taskBadge}</span>
						)}
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
					collections={collections}
					templates={templates}
					cols={config.workbenchCols}
					tabCols={config.workbenchTabCols}
					onChange={saveField}
					onChangeMany={saveFields}
					onGenerate={generate}
					onPreview={previewRequest}
					onAddLibrary={addLibrary}
					onRemoveLibrary={removeLibrary}
					onSendToEdit={sendToEdit}
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
					onChangeMany={saveFields}
					onError={(message) => setStatus({ text: message, error: true })}
				/>
			</Tabs.Content>
			<Tabs.Content value="tasks" forceMount className="tabpanel">
				<Tasks
					hidden={tab !== 'tasks'}
					tasks={tasks}
					pendingTasks={pendingTasks}
					collections={collections}
					cols={config.tasksCols}
					tabCols={config.tasksTabCols}
					unreadTasks={unreadTasks}
					onViewed={markTaskViewed}
					onSendToEdit={sendToEdit}
					reveal={reveal}
				/>
			</Tabs.Content>
			<Tabs.Content value="favorites" forceMount className="tabpanel">
				<Favorites
					hidden={tab !== 'favorites'}
					collections={collections}
					activeCollectionId={activeCollectionId}
					cols={config.favoritesCols}
					tabCols={config.favoritesTabCols}
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
