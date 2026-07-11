import { type ReactNode, useState, useRef, useEffect } from 'react';
import { NativeSelect } from './primitives';
import type { CustomParam, WebviewImageModel } from '../shared';
import { qualifiedModel } from '../modelOptions';

/** 带标签的字段容器；className 可叠加（如参数行里给自定义参数列单独配宽度） */
export function Field({
	label,
	children,
	className,
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={className ? `field ${className}` : 'field'}>
			<label>{label}</label>
			{children}
		</div>
	);
}

/** 下拉选择，选项可为字符串或 {value,label}；底层用 Radix Select（可访问、键盘可达） */
export function Select({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label: string;
	value: string;
	options: readonly (string | { value: string; label: string })[];
	onChange: (value: string) => void;
	className?: string;
}) {
	return (
		<Field label={label} className={className}>
			<NativeSelect value={value} options={options} onChange={onChange} ariaLabel={label} />
		</Field>
	);
}

/** 把 "W:H" 解析成在 box 见方内按比例缩放的图形尺寸；非法或非数字比例回退为正方 */
function ratioShapeStyle(ratio: string): { width: string; height: string } {
	const box = 22;
	const [w, h] = ratio.split(':').map(Number);
	if (!w || !h) {
		return { width: `${box}px`, height: `${box}px` };
	}
	if (w >= h) {
		return { width: `${box}px`, height: `${Math.round((box * h) / w)}px` };
	}
	return { width: `${Math.round((box * w) / h)}px`, height: `${box}px` };
}

/** 'auto' 显示为「自适应」，其余比例原样显示 */
function ratioLabel(ratio: string): string {
	return ratio === 'auto' ? '自适应' : ratio;
}

/** 弹层开关公共逻辑：点击外部（pointerdown 捕获，Radix 弹层打开时也不受影响）或 Esc 关闭 */
function usePopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) {
			return;
		}
		const onDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setOpen(false);
			}
		};
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);
	return { open, setOpen, ref };
}

/**
 * 「模型」弹层：与「参数」弹层同风格的面板，按渠道分节、每行两个模型卡片，
 * 选中项蓝框高亮（同比例卡片的选中态）。点选后关闭（单选一次完成）。
 */
export function ModelSelect({
	label,
	provider,
	model,
	models,
	onChange,
}: {
	label: string;
	provider: string;
	model: string;
	models: readonly WebviewImageModel[];
	onChange: (qualified: string) => void;
}) {
	const { open, setOpen, ref } = usePopover();
	const current = models.find((m) => m.provider === provider && m.model === model);
	// 按渠道分节（保持后端下发顺序）
	const groups: { label: string; items: WebviewImageModel[] }[] = [];
	for (const m of models) {
		const g = groups.find((x) => x.label === m.providerLabel);
		if (g) {
			g.items.push(m);
		} else {
			groups.push({ label: m.providerLabel, items: [m] });
		}
	}
	return (
		<Field label={label}>
			<div className="ratio-select" ref={ref}>
				<button
					type="button"
					className="rx-select-trigger"
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					<span>{current?.label ?? model}</span>
				</button>
				{open && (
					<div className="ratio-pop param-pop model-pop" role="dialog" aria-label={label}>
						{groups.map((g) => (
							<div className="param-section" key={g.label}>
								<div className="param-title">{g.label}</div>
								<div className="model-grid">
									{g.items.map((m) => {
										const selected = m.provider === provider && m.model === model;
										return (
											<button
												key={qualifiedModel(m.provider, m.model)}
												type="button"
												aria-pressed={selected}
												className={`param-chip model-item${selected ? ' selected' : ''}`}
												onClick={() => {
													onChange(qualifiedModel(m.provider, m.model));
													setOpen(false);
												}}
											>
												{m.label}
											</button>
										);
									})}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</Field>
	);
}

/**
 * 「参数」弹层：把比例、分辨率与当前模型的自定义参数收进同一个弹出面板。
 * 触发器显示当前值摘要（如 3:4 · 1K · high），点开后分区调整；单一弹层也杜绝了
 * 旧「比例弹层 + 分辨率 Radix 下拉」能同时打开的问题。选择不自动关闭（常要连调多项），
 * 点击外部或 Esc 关闭。外部点击监听用 pointerdown 捕获阶段——Radix 弹层（如模型下拉）
 * 打开时会吞掉 mousedown，捕获阶段的 pointerdown 不受影响。
 */
export function ParamsSelect({
	label,
	aspectRatio,
	ratioOptions,
	imageSize,
	sizeOptions,
	customParams,
	paramValues,
	onChangeRatio,
	onChangeSize,
	onChangeParam,
}: {
	label: string;
	aspectRatio: string;
	ratioOptions: readonly string[];
	imageSize: string;
	sizeOptions: readonly string[];
	customParams: readonly CustomParam[];
	paramValues: Record<string, string>;
	onChangeRatio: (value: string) => void;
	onChangeSize: (value: string) => void;
	onChangeParam: (key: string, value: string) => void;
}) {
	const { open, setOpen, ref } = usePopover();
	const summary = [ratioLabel(aspectRatio), imageSize, ...customParams.map((p) => paramValues[p.key] ?? p.default)]
		.filter(Boolean)
		.join(' · ');
	// 「自适应」卡片宽度与位置会随文字变动，固定排到最后，避免影响前面数字比例的排布
	const sortedRatios = [...ratioOptions.filter((o) => o !== 'auto'), ...ratioOptions.filter((o) => o === 'auto')];
	return (
		<Field label={label}>
			<div className="ratio-select" ref={ref}>
				<button
					type="button"
					className="rx-select-trigger"
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					<span>{summary}</span>
				</button>
				{open && (
					<div className="ratio-pop param-pop" role="dialog" aria-label={label}>
						<div className="param-section">
							<div className="param-title">构图比例</div>
							<div className="ratio-grid">
								{sortedRatios.map((opt) => {
									const selected = opt === aspectRatio;
									const isAuto = opt === 'auto';
									return (
										<button
											key={opt}
											type="button"
											aria-pressed={selected}
											aria-label={ratioLabel(opt)}
											className={`ratio-item${selected ? ' selected' : ''}`}
											onClick={() => onChangeRatio(opt)}
										>
											<span className="ratio-shape-box">
												{isAuto ? (
													<span className="ratio-shape ratio-shape-auto" />
												) : (
													<span className="ratio-shape" style={ratioShapeStyle(opt)} />
												)}
											</span>
											<span className="ratio-text">{isAuto ? '自适应' : opt}</span>
										</button>
									);
								})}
							</div>
						</div>
						<div className="param-section">
							<div className="param-title">分辨率</div>
							<div className="param-chips">
								{sizeOptions.map((opt) => (
									<button
										key={opt}
										type="button"
										aria-pressed={opt === imageSize}
										className={`param-chip${opt === imageSize ? ' selected' : ''}`}
										onClick={() => onChangeSize(opt)}
									>
										{opt}
									</button>
								))}
							</div>
						</div>
						{customParams.map((p) => (
							<div className="param-section" key={p.key}>
								<div className="param-title">{p.label}</div>
								<div className="param-chips">
									{p.options.map((opt) => {
										const selected = opt === (paramValues[p.key] ?? p.default);
										return (
											<button
												key={opt}
												type="button"
												aria-pressed={selected}
												className={`param-chip${selected ? ' selected' : ''}`}
												onClick={() => onChangeParam(p.key, opt)}
											>
												{opt}
											</button>
										);
									})}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</Field>
	);
}

/** 文本输入 */
export function TextField({
	label,
	value,
	type = 'text',
	onChange,
}: {
	label: string;
	value: string;
	type?: string;
	onChange: (value: string) => void;
}) {
	return (
		<Field label={label}>
			<input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
		</Field>
	);
}

/** 多行文本输入 */
export function TextArea({
	label,
	value,
	placeholder,
	onChange,
}: {
	label: string;
	value: string;
	placeholder?: string;
	onChange: (value: string) => void;
}) {
	return (
		<Field label={label}>
			<textarea
				rows={3}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
			/>
		</Field>
	);
}

/** 复选框：标签在右，整体可点击 */
export function Checkbox({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="checkbox-field">
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
			<span>{label}</span>
		</label>
	);
}

/** 数字步进器：两侧加减按钮，受 [min,max] 约束 */
export function Stepper({
	label,
	value,
	min,
	max,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
}) {
	const clamp = (n: number) => Math.max(min, Math.min(max, n));
	const commit = (n: number) => onChange(clamp(Number.isNaN(n) ? min : n));
	return (
		<Field label={label}>
			<div className="stepper">
				<button type="button" className="step" onClick={() => commit(value - 1)}>
					−
				</button>
				<input
					type="number"
					min={min}
					max={max}
					value={value}
					onChange={(e) => commit(Number(e.target.value))}
				/>
				<button type="button" className="step" onClick={() => commit(value + 1)}>
					+
				</button>
			</div>
		</Field>
	);
}
