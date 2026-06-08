import { vscode, type Config, type ConfigOptions } from './vscode';
import { Select, TextField, NumberField } from './fields';

const GET_KEY_URL = 'https://grsai.ai/zh/dashboard/api-keys';

/** 设置页：API Key + 获取链接 + 节点 + 缩略图尺寸 + 当前文件预览请求 */
export function ApiConfig({
	hidden,
	config,
	options,
	activeMd,
	onChange,
	onPreview,
}: {
	hidden: boolean;
	config: Config;
	options: ConfigOptions;
	activeMd: string | null;
	onChange: <K extends keyof Config>(key: K, value: Config[K]) => void;
	onPreview: () => void;
}) {
	return (
		<div className="page" data-page="api" hidden={hidden}>
			<TextField
				label="API Key"
				type="password"
				value={config.apiKey}
				onChange={(v) => onChange('apiKey', v)}
			/>
			<button
				type="button"
				className="link"
				onClick={() => vscode.postMessage({ type: 'openExternal', url: GET_KEY_URL })}
			>
				获取 API Key →
			</button>
			<Select
				label="节点"
				value={config.baseUrl}
				options={options.baseUrl}
				onChange={(v) => onChange('baseUrl', v)}
			/>
			<NumberField
				label="工作台缩略图（px）"
				value={config.workbenchThumbSize}
				min={40}
				max={400}
				onChange={(v) => onChange('workbenchThumbSize', v)}
			/>
			<NumberField
				label="任务栏缩略图（px）"
				value={config.tasksThumbSize}
				min={40}
				max={400}
				onChange={(v) => onChange('tasksThumbSize', v)}
			/>
			<div className="preview-row">
				<span className="active-md">
					{activeMd ? `默认对最左侧 MD 生效：${activeMd}` : '未打开 Markdown 文件'}
				</span>
				<button className="preview-btn" onClick={onPreview}>
					预览请求
				</button>
			</div>
		</div>
	);
}
