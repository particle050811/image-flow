import { useState } from 'react';
import { vscode, type Config, type ConfigOptions } from './vscode';
import { PanelSelect, TextArea, Stepper, Checkbox } from './fields';

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
	// 注入提示词按裸模型名索引（跨渠道同名模型共用一句），下拉去重
	const injectModels = [...new Set(options.imageModels.map((m) => m.model))];
	return (
		<div className="page" data-page="api" hidden={hidden}>
			{/* 自定义渠道的模型在 ~/.image-flow/settings.json 配置，模型下拉按渠道分组展示全部 */}
			<div className="field">
				<div className="field-head field-head-inline">
					<label>自定义 API 模型</label>
					<button
						type="button"
						className="link link-inline"
						onClick={() => vscode.postMessage({ type: 'openProviderSettings' })}
					>
						打开配置文件
					</button>
				</div>
			</div>
			{/* 内置 grsai 的 API Key（走 secrets）；自定义渠道的 key 在 settings.json 每个模型里自带 */}
			<div className="field">
				<div className="field-head">
					<label>Grsai API Key</label>
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
			{/* 即梦渠道走本机 dreamina CLI 登录态：按钮让扩展在终端自动执行登录（未安装则先弹安装引导） */}
			<div className="field">
				<div className="field-head field-head-inline">
					<label>即梦 CLI（dreamina）</label>
					<button
						type="button"
						className="link link-inline"
						onClick={() => vscode.postMessage({ type: 'jimengLogin' })}
					>
						登录
					</button>
				</div>
			</div>
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
				label="缩略图常驻显示收藏/编辑按钮（关闭则仅鼠标移到图上时出现）"
				checked={config.showThumbActions}
				onChange={(v) => onChange('showThumbActions', v)}
			/>
			<Checkbox
				label="自动为任务 AI 命名"
				checked={config.autoName}
				onChange={(v) => onChange('autoName', v)}
			/>
			<Checkbox
				label="工作台素材库显示音频/视频（关闭则只列图片）"
				checked={config.showAudioVideo}
				onChange={(v) => onChange('showAudioVideo', v)}
			/>
			<Checkbox
				label="启动时清理一天前的无产物任务文件夹"
				checked={config.cleanEmptyTasksOnStartup}
				onChange={(v) => onChange('cleanEmptyTasksOnStartup', v)}
			/>
			<Checkbox
				label="视频模型仅允许文件名以 v.md 结尾的 Markdown 生成（防误触发付费视频任务）"
				checked={config.videoOnlyVmd}
				onChange={(v) => onChange('videoOnlyVmd', v)}
			/>
			<PanelSelect
				label="模型注入提示词 — 选择模型"
				value={injectModel}
				options={injectModels}
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
