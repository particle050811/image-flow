import * as RadixSelect from '@radix-ui/react-select';
import type { ReactNode } from 'react';

/** Radix Select 封装：无样式注入、CSP 安全、可访问性达标，外观全走 .rx-select-* 类 */
export function NativeSelect({
	value,
	options,
	onChange,
	ariaLabel,
	title,
}: {
	value: string;
	options: readonly (string | { value: string; label: string })[];
	onChange: (value: string) => void;
	ariaLabel?: string;
	title?: string;
}) {
	return (
		<RadixSelect.Root value={value} onValueChange={onChange}>
			<RadixSelect.Trigger className="rx-select-trigger" aria-label={ariaLabel} title={title}>
				<RadixSelect.Value />
			</RadixSelect.Trigger>
			<RadixSelect.Portal>
				<RadixSelect.Content
					className="rx-select-content"
					position="popper"
					side="top"
					sideOffset={4}
				>
					<RadixSelect.Viewport className="rx-select-viewport">
						{options.map((opt) => {
							const v = typeof opt === 'string' ? opt : opt.value;
							const text = typeof opt === 'string' ? opt : opt.label;
							return (
								<RadixSelect.Item key={v} value={v} className="rx-select-item">
									<RadixSelect.ItemText>{text}</RadixSelect.ItemText>
									<RadixSelect.ItemIndicator className="rx-select-check">
										✓
									</RadixSelect.ItemIndicator>
								</RadixSelect.Item>
							);
						})}
					</RadixSelect.Viewport>
				</RadixSelect.Content>
			</RadixSelect.Portal>
		</RadixSelect.Root>
	);
}
