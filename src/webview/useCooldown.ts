import { useState } from 'react';

/** 防连点冷却：trigger() 在冷却中为 no-op，否则置冷却态并在 ms 后自动解除。
 *  返回 [cooling, trigger]，由调用方决定怎么用 cooling（禁用按钮 / 内部早退）。 */
export function useCooldown(ms: number): [boolean, () => boolean] {
	const [cooling, setCooling] = useState(false);
	const trigger = () => {
		if (cooling) {
			return false;
		}
		setCooling(true);
		setTimeout(() => setCooling(false), ms);
		return true;
	};
	return [cooling, trigger];
}
