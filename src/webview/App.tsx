import { useEffect, useState } from 'react';
import {
	vscode,
	type Config,
	type ConfigOptions,
	type InboundMessage,
	type WebviewTask,
	type WebviewPendingTask,
	type WebviewLibrary,
} from './vscode';
import { Workbench } from './Workbench';
import { Tasks } from './Tasks';
import { ApiConfig } from './ApiConfig';

type TabId = 'workbench' | 'tasks' | 'api';

const TABS: { id: TabId; label: string }[] = [
	{ id: 'workbench', label: '工作台' },
	{ id: 'tasks', label: '任务' },
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
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false });

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
					break;
				case 'pendingTasks':
					setPendingTasks(msg.tasks);
					break;
				case 'libraries':
					setLibraries(msg.libraries);
					break;
				case 'autoLibraries':
					setAutoLibraries(msg.libraries);
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

	const switchTab = (id: TabId) => {
		setTab(id);
		if (id === 'tasks') {
			vscode.postMessage({ type: 'refreshHistory' });
		}
	};

	const generate = () => {
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

	if (!config || !options) {
		return <div className="page">加载中…</div>;
	}

	return (
		<>
			<div className="tabs">
				{TABS.map((t) => (
					<button
						key={t.id}
						className={`tab${tab === t.id ? ' active' : ''}`}
						onClick={() => switchTab(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>

			<Workbench
				hidden={tab !== 'workbench'}
				config={config}
				options={options}
				activeMd={activeMd}
				busy={busy}
				status={status}
				libraries={libraries}
				autoLibraries={autoLibraries}
				thumbSize={config.workbenchThumbSize}
				onChange={saveField}
				onGenerate={generate}
				onPreview={previewRequest}
				onAddLibrary={addLibrary}
				onRemoveLibrary={removeLibrary}
			/>
			<Tasks
				hidden={tab !== 'tasks'}
				tasks={tasks}
				pendingTasks={pendingTasks}
				thumbSize={config.tasksThumbSize}
			/>
			<ApiConfig
				hidden={tab !== 'api'}
				config={config}
				options={options}
				activeMd={activeMd}
				onChange={saveField}
				onPreview={previewRequest}
			/>
		</>
	);
}
