// 参数解析：op + 可选 md 位置参数 + --key=value 选项（--param=键=值 可重复）。
// 命令面定义（哪些 op、各 op 允许哪些 flag）集中在此，主入口只消费解析结果。

// 需要 md 位置参数的 op / 按 cwd 路由的 op（含 edit、favorite 这类有副作用的，与扩展侧 CWD_OPS 同名同集）
export const MD_OPS = ['list', 'fix', 'preview', 'submit'];
export const CWD_OPS = ['query_result', 'list_task', 'list_model', 'favorite', 'edit'];

// 各 op 允许的 --flag 白名单（拦 AI 手误）；list_model 的 --full 控制输出详略
export const ALLOWED_FLAGS = {
	// list/fix/preview 也支持 debug：--debug 的用途正是量各命令耗时，MD 类命令同样适用
	list: ['debug'],
	fix: ['debug'],
	preview: ['debug'],
	submit: ['model', 'ratio', 'resolution', 'generate_num', 'param', 'poll', 'debug'],
	edit: ['prompt', 'image', 'model', 'ratio', 'resolution', 'generate_num', 'param', 'poll', 'debug'],
	query_result: ['submit_id', 'poll', 'debug'],
	list_task: ['limit', 'debug'],
	list_model: ['full', 'debug'],
	favorite: ['path', 'note', 'debug'],
};

// 可裸写的布尔 flag（不用 --key=value 形式）：出现即视为 1。
// 注意 debug 也可用环境变量 IMGFLOW_DEBUG=1 开启（两者取其一）。
const BOOLEAN_FLAGS = new Set(['debug', 'full']);

// 解析 --flag 字符串为非负整数；非法即用法报错（与旧行为一致），合法返回数值
export function intFlag(flags, name, usageFail) {
	if (flags[name] === undefined) {
		return undefined;
	}
	const n = Number(flags[name]);
	if (!Number.isInteger(n) || n < 0) {
		usageFail(`--${name} 须为非负整数`);
	}
	return n;
}

/**
 * 解析全部命令行参数。
 * @param {string[]} argv process.argv.slice(2)
 * @param {(msg?: string) => never} usageFail 用法错误出口
 * @returns {{
 *   op: string,
 *   mdArg: string | undefined,
 *   flags: Record<string, string>,
 *   params: Record<string, string>,
 *   imageArgs: string[],
 * }}
 */
export function parseArgs(argv, usageFail) {
	const [op, ...rest] = argv;
	if (!MD_OPS.includes(op) && !CWD_OPS.includes(op)) {
		usageFail();
	}
	const flags = {};
	const params = {};
	/** --image 可重复：顺序即参考图编号顺序（同一次编辑的多张参考图） */
	const imageArgs = [];
	let mdArg;
	for (const a of rest) {
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq < 0) {
				// 裸布尔 flag：--debug / --full 出现即置 1
				const bare = a.slice(2);
				if (BOOLEAN_FLAGS.has(bare) && ALLOWED_FLAGS[op].includes(bare)) {
					flags[bare] = '1';
					continue;
				}
				usageFail(`选项 ${a} 须为 --key=value 形式`);
			}
			const key = a.slice(2, eq);
			const value = a.slice(eq + 1);
			if (!ALLOWED_FLAGS[op].includes(key)) {
				usageFail(`${op} 不支持选项 --${key}`);
			}
			if (key === 'param') {
				const eq2 = value.indexOf('=');
				if (eq2 <= 0) {
					usageFail('--param 须为 --param=键=值 形式');
				}
				params[value.slice(0, eq2)] = value.slice(eq2 + 1);
			} else if (key === 'image') {
				if (!value) {
					usageFail('--image 须带路径（--image=<图片路径>）');
				}
				imageArgs.push(value);
			} else if (key in flags) {
				usageFail(`选项 --${key} 重复`);
			} else {
				flags[key] = value;
			}
		} else if (MD_OPS.includes(op) && mdArg === undefined) {
			mdArg = a;
		} else {
			usageFail(`多余参数：${a}`);
		}
	}
	if (MD_OPS.includes(op) && !mdArg) {
		usageFail(`${op} 需要 <md路径> 参数`);
	}
	if (op === 'query_result' && !flags.submit_id) {
		usageFail('query_result 需要 --submit_id=yyMMdd/HHmmssSSS');
	}
	if (op === 'edit' && !flags.prompt) {
		usageFail('edit 需要 --prompt=<提示词正文>');
	}
	if (op === 'favorite' && !flags.path) {
		usageFail('favorite 需要 --path=<产物绝对路径>');
	}
	return { op, mdArg, flags, params, imageArgs };
}
