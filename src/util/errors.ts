/** 把任意抛出物（Error / 字符串 / 其它）收敛为可展示的错误消息字符串 */
export function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
