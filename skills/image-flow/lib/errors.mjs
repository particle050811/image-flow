// 统一的错误出口：fail=传输层/通用错误，usageFail=用法错误（附带 USAGE）。

export function fail(msg) {
	process.stderr.write(msg + '\n');
	process.exit(1);
}

export function usageFail(usage) {
	return (msg) => {
		process.stderr.write((msg ? msg + '\n' : '') + usage);
		process.exit(2);
	};
}
