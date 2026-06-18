import { type ReactNode } from 'react';
import { NativeSelect } from './primitives';

/** 带标签的字段容器 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="field">
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
}: {
	label: string;
	value: string;
	options: readonly (string | { value: string; label: string })[];
	onChange: (value: string) => void;
}) {
	return (
		<Field label={label}>
			<NativeSelect value={value} options={options} onChange={onChange} ariaLabel={label} />
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
