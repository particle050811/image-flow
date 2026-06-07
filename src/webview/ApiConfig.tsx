import { vscode, type Config, type ConfigOptions } from './vscode';
import { Select, TextField } from './fields';

const GET_KEY_URL = 'https://grsai.ai/zh/dashboard/api-keys';

/** API 配置页：Key + 获取链接 + 节点 + 分辨率 */
export function ApiConfig({
	hidden,
	config,
	options,
	onChange,
}: {
	hidden: boolean;
	config: Config;
	options: ConfigOptions;
	onChange: <K extends keyof Config>(key: K, value: Config[K]) => void;
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
			<Select
				label="分辨率"
				value={config.imageSize}
				options={options.imageSize}
				onChange={(v) => onChange('imageSize', v)}
			/>
		</div>
	);
}
