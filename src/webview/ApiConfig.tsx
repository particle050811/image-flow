import { useState } from 'react';
import { vscode, type Config, type ConfigOptions } from './vscode';
import { Select, TextArea, Stepper, Checkbox } from './fields';
import { NativeSelect } from './primitives';

const GET_KEY_URL = 'https://grsai.ai/zh/dashboard/api-keys';

/** 设置页：API Key + 获取链接 + 每行张数 + 模型注入提示词 */
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
			<div className="field">
				<div className="field-head field-head-inline">
					<label>API</label>
					<div className="field-head-grow">
						<NativeSelect
							value={config.providerId}
							options={options.providers.map((p) => ({ value: p.id, label: p.label }))}
							onChange={(id) => vscode.postMessage({ type: 'selectProvider', providerId: id })}
							ariaLabel="API"
						/>
					</div>
					{/* 内置 grsai 无 settings.json 配置文件，仅自定义 Provider 显示入口 */}
					{options.isCustom && (
						<button
							type="button"
							className="link link-inline"
							onClick={() => vscode.postMessage({ type: 'openProviderSettings' })}
						>
							打开配置文件
						</button>
					)}
				</div>
			</div>
			{/* 内置 grsai 的 API Key（走 secrets）；自定义 Provider 的 key 在 settings.json 每个模型里自带，故隐藏 */}
			{!options.isCustom && (
				<div className="field">
					<div className="field-head">
						<label>API Key</label>
						<button
							type="button"
							className="link link-inline"
							onClick={() => vscode.postMessage({ type: 'openExternal', url: GET_KEY_URL })}
						>
							获取
						</button>
					</div>
					<input
						type="password"
						value={config.apiKey}
						onChange={(e) => onChange('apiKey', e.target.value)}
					/>
				</div>
			)}
			<div className="row">
				<Stepper
					label="工作台图片每行张数"
					value={config.workbenchCols}
					min={1}
					max={8}
					onChange={(v) => onChange('workbenchCols', v)}
				/>
				<Stepper
					label="任务栏图片每行张数"
					value={config.tasksCols}
					min={1}
					max={8}
					onChange={(v) => onChange('tasksCols', v)}
				/>
				<Stepper
					label="收藏夹图片每行张数"
					value={config.favoritesCols}
					min={1}
					max={8}
					onChange={(v) => onChange('favoritesCols', v)}
				/>
			</div>
			<div className="row">
				<Stepper
					label="工作台标签每行个数"
					value={config.workbenchTabCols}
					min={1}
					max={8}
					onChange={(v) => onChange('workbenchTabCols', v)}
				/>
				<Stepper
					label="任务栏标签每行个数"
					value={config.tasksTabCols}
					min={1}
					max={8}
					onChange={(v) => onChange('tasksTabCols', v)}
				/>
			</div>
			<div className="row">
				<Stepper
					label="收藏夹标签每行个数"
					value={config.favoritesTabCols}
					min={1}
					max={8}
					onChange={(v) => onChange('favoritesTabCols', v)}
				/>
				<Stepper
					label="模板标签每行个数"
					value={config.templateCols}
					min={1}
					max={8}
					onChange={(v) => onChange('templateCols', v)}
				/>
			</div>
			<Checkbox
				label="缩略图常驻显示收藏/编辑按钮（关闭则仅 hover 出现）"
				checked={config.showThumbActions}
				onChange={(v) => onChange('showThumbActions', v)}
			/>
			<Checkbox
				label="自动为任务 AI 命名"
				checked={config.autoName}
				onChange={(v) => onChange('autoName', v)}
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
