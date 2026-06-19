import { useState } from 'react';

/** 选择栏模式状态：维护选中 key，并在选中失效（列表刷新/项被移除）时回落到第一项。
 *  chip 渲染留在各页（长相不同），这里只抽「selected 状态 + 失效回落」这段公共逻辑。
 *  initialKey 表达各页不同的初值（Favorites 用 activeCollectionId，其余为 null）。 */
export function usePicker<T>(
	items: T[],
	keyOf: (item: T) => string,
	initialKey: string | null = null,
): { current: T | undefined; setSelected: (key: string) => void } {
	const [selectedKey, setSelected] = useState<string | null>(initialKey);
	const current = items.find((i) => keyOf(i) === selectedKey) ?? items[0];
	return { current, setSelected };
}
