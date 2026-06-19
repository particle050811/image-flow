import { useEffect, useState } from 'react';
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
	const [genCooling, genCool] = useCooldown(500);
	const [status, setStatus] = useState<StatusState>({ text: '', error: false });

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
					setTasks(msg.tasks);
					// 缺缩略图的大图（带 thumbKey）入队生成回传，下次推送即可用缩略图
					requestThumbs(msg.tasks.flatMap((t) => t.images));
					// 任务完成会带来新的大图，节流清一次资源缓存，限制长会话内的磁盘增长
					clearResourceCachesThrottled();
					break;
				case 'pendingTasks':
					setPendingTasks(msg.tasks);
					requestThumbs(msg.tasks.flatMap((t) => t.images));
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
				case 'status':
					setStatus({ text: msg.message, error: false });
					break;
				case 'error':
					setStatus({ text: msg.message, error: true });
					break;
				case 'busy':
					setBusy(msg.busy);
					break;
				case 'navigate':
					switchTab(msg.tab);
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

	// 注意：navigate 消息处理器（空依赖 useEffect）持有首渲染的本函数实例，
	// 此函数只能调 setter/postMessage，不得读取 state，否则会拿到首渲染快照
	const switchTab = (id: TabId) => {
		setTab(id);
		if (id === 'tasks') {
			vscode.postMessage({ type: 'refreshHistory' });
		}
		if (id === 'edit') {
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

	return (
		<Tabs.Root
			className="tabs-root"
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
					cols={config.workbenchCols}
					onChange={saveField}
					onGenerate={generate}
					onPreview={previewRequest}
					onAddLibrary={addLibrary}
					onRemoveLibrary={removeLibrary}
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
					onSendToEdit={sendToEdit}
				/>
			</Tabs.Content>
			<Tabs.Content value="favorites" forceMount className="tabpanel">
				<Favorites
					hidden={tab !== 'favorites'}
					collections={collections}
					activeCollectionId={activeCollectionId}
					cols={config.favoritesCols}
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
