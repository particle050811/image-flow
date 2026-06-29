import { type ReactNode, useState, useRef, useEffect } from 'react';
import { NativeSelect } from './primitives';

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

/** 比例下拉：触发器保持与其它字段一致的紧凑下拉外观，点开后弹出图形化网格。
 *  每个比例渲染成按比例缩放的小图形 + 比例文字，'auto' 渲染成「自适应」虚线按钮。 */
export function RatioSelect({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label: string;
	value: string;
	options: readonly string[];
	onChange: (value: string) => void;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	// 打开时点击外部或按 Esc 关闭
	useEffect(() => {
		if (!open) {
			return;
		}
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);
	return (
		<Field label={label} className={className}>
			<div className="ratio-select" ref={ref}>
				<button
					type="button"
					className="rx-select-trigger"
					aria-haspopup="listbox"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					<span>{ratioLabel(value)}</span>
				</button>
				{open && (
					<div className="ratio-pop" role="listbox" aria-label={label}>
						<div className="ratio-grid">
							{options.map((opt) => {
								const selected = opt === value;
								const isAuto = opt === 'auto';
								return (
									<button
										key={opt}
										type="button"
										role="option"
										aria-selected={selected}
										aria-label={ratioLabel(opt)}
										className={`ratio-item${selected ? ' selected' : ''}`}
										onClick={() => {
											onChange(opt);
											setOpen(false);
										}}
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
