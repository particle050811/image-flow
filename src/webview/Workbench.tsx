import type { Config, ConfigOptions } from './vscode';
import { Select, Stepper } from './fields';

export function Workbench({
	hidden,
	config,
	options,
	activeMd,
	busy,
	status,
	onChange,
	onGenerate,
}: {
	hidden: boolean;
	config: Config;
	options: ConfigOptions;
	activeMd: string | null;
	busy: boolean;
	status: { text: string; error: boolean };
	onChange: <K extends keyof Config>(key: K, value: Config[K]) => void;
	onGenerate: () => void;
}) {
	return (
		<div className="page" data-page="workbench" hidden={hidden}>
			<div className="active-md">
				{activeMd ? `当前文件：${activeMd}` : '未打开 Markdown 文件'}
			</div>

			<div className="gallery-placeholder">素材库（即将上线）</div>

			<div className="dock">
				<div className="row">
					<Select
						label="模型"
						value={config.model}
						options={options.model}
						onChange={(v) => onChange('model', v)}
					/>
					<Select
						label="比例"
						value={config.aspectRatio}
						options={options.aspectRatio}
						onChange={(v) => onChange('aspectRatio', v)}
					/>
					<Stepper
						label="并发数"
						value={config.concurrency}
						min={1}
						max={10}
						onChange={(v) => onChange('concurrency', v)}
					/>
				</div>

				<button className="gen-btn" disabled={busy} onClick={onGenerate}>
					{busy ? '生成中…' : '对当前 Markdown 生成'}
				</button>

				<div className={`status${status.error ? ' error' : ''}`}>{status.text}</div>
			</div>
		</div>
	);
}
