import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// 锁定 VS Code 测试实例版本，避免每次跟随 stable 频繁下载新版攒满 .vscode-test 缓存。
	// 需要升级时手动改这里即可。
	version: '1.126.0',
});
