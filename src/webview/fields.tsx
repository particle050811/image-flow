import { useEffect, useState, type ReactNode } from 'react';

/** 带标签的字段容器 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="field">
			<label>{label}</label>
			{children}
		</div>
	);
}

/** 下拉选择，选项可为字符串或 {value,label} */
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
			<select value={value} onChange={(e) => onChange(e.target.value)}>
				{options.map((opt) => {
					const v = typeof opt === 'string' ? opt : opt.value;
					const text = typeof opt === 'string' ? opt : `${opt.label}（${opt.value}）`;
					return (
						<option key={v} value={v}>
							{text}
						</option>
					);
				})}
			</select>
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

/** 数字输入框：编辑时保留原始文本，失焦才按 [min,max] 约束并提交，避免边打字边被夹断 */
export function NumberField({
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
	const [text, setText] = useState(String(value));
	// 外部值变化（如初始加载）时同步本地文本
	useEffect(() => setText(String(value)), [value]);

	const commit = () => {
		const n = Number(text);
		const clamped = Math.max(min, Math.min(max, Number.isNaN(n) ? value : n));
		setText(String(clamped));
		if (clamped !== value) {
			onChange(clamped);
		}
	};

	return (
		<Field label={label}>
			<input
				type="number"
				min={min}
				max={max}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.currentTarget.blur();
					}
				}}
			/>
		</Field>
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
