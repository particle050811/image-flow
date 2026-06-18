import { useState } from 'react';
import { vscode, type Config, type ConfigOptions } from './vscode';
import { Select, TextField, TextArea, Stepper, Checkbox } from './fields';

const GET_KEY_URL = 'https://grsai.ai/zh/dashboard/api-keys';

/** 设置页：API Key + 获取链接 + 节点 + 每行张数 + 模型注入提示词 */
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
	// 设置页独立选择要编辑哪个模型的注入提示词，默认当前工作台模型，与工作台选择解耦
	const [injectModel, setInjectModel] = useState(config.model);
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
			<div className="row">
				<Stepper
					label="工作台每行张数"
					value={config.workbenchCols}
					min={1}
					max={8}
					onChange={(v) => onChange('workbenchCols', v)}
				/>
				<Stepper
					label="任务栏每行张数"
					value={config.tasksCols}
					min={1}
					max={8}
					onChange={(v) => onChange('tasksCols', v)}
				/>
			</div>
			<Checkbox
				label="自动为编辑任务 AI 命名"
				checked={config.autoNameEdit}
				onChange={(v) => onChange('autoNameEdit', v)}
			/>
			<Select
				label="命名模型"
				value={config.namingModel}
				options={options.namingModel}
				onChange={(v) => onChange('namingModel', v)}
			/>
			<Select
				label="模型注入提示词 — 选择模型"
				value={injectModel}
				options={options.model}
				onChange={setInjectModel}
			/>
			<TextArea
				label={`注入到「${injectModel}」的提示词`}
				value={config.modelInjections[injectModel] ?? ''}
				placeholder="此模型无注入提示词，可在此填写"
				onChange={(v) =>
					onChange('modelInjections', { ...config.modelInjections, [injectModel]: v })
				}
			/>
		</div>
	);
}
