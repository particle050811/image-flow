// OpenAI 兼容对话协议（非流式）：POST /v1/chat/completions → choices[0].message.content。
// 当前用于 AI 任务命名。内置 grsai 的命名模型即走这里。

import { fetchWithTimeout, readBodyLimited, readJsonLimited, normalizeBase, CONTROL_BODY_BYTES, CONTROL_BODY_TIMEOUT } from '../api';
import { log } from '../../util/log';
import type { ChatAdapter, ChatContext, ChatMessage } from './types';

/** 命名失败日志里错误响应体的截断长度：够看清错误码/信息即可，防超长体刷屏 */
const ERROR_BODY_SNIPPET = 300;

/** openai 兼容对话 adapter */
export const openaiChat: ChatAdapter = {
	id: 'openai-chat',

	async chat(
		ctx: ChatContext,
		model: string,
		messages: ChatMessage[],
		maxTokens: number
	): Promise<string | undefined> {
		try {
			const response = await fetchWithTimeout(`${normalizeBase(ctx.baseUrl)}/v1/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${ctx.apiKey}`,
				},
				body: JSON.stringify({
					model,
					stream: false,
					max_tokens: maxTokens,
					// 关闭思考模式（DeepSeek 思考型模型默认开启，思考 token 计入 max_tokens
					// 且非流式要等思考完才返回，命名这种短任务会超时/超额）。
					// 非 DeepSeek 的 OpenAI 兼容后端按惯例忽略未知字段。
					thinking: { type: 'disabled' },
					messages,
				}),
			});
			if (!response.ok) {
				// 读一小段错误体进日志后放弃命名（读体本身也把连接释放了；错误体未必是 JSON，按原文截断）
				let detail = '';
				try {
					const bytes = await readBodyLimited(response, '命名错误响应', CONTROL_BODY_BYTES, CONTROL_BODY_TIMEOUT);
					detail = Buffer.from(bytes).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_SNIPPET);
				} catch {
					void response.body?.cancel().catch(() => {});
				}
				log(`命名请求失败：HTTP ${response.status}（模型 ${model}）${detail ? `：${detail}` : ''}`);
				return undefined;
			}
			// 命名回复只有一小段文本：按控制面小上限读
			const data = (await readJsonLimited(response, '命名响应', CONTROL_BODY_BYTES, CONTROL_BODY_TIMEOUT)) as {
					choices?: { message?: { content?: unknown } }[];
				};
			const content = data.choices?.[0]?.message?.content;
			if (typeof content !== 'string') {
				log(`命名响应无文本内容（模型 ${model}）：choices[0].message.content 缺失或非字符串`);
				return undefined;
			}
			return content;
		} catch (err) {
			log(`命名请求异常（模型 ${model}）：${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	},
};
