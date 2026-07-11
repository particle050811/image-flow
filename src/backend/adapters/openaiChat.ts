// OpenAI 兼容对话协议（非流式）：POST /v1/chat/completions → choices[0].message.content。
// 当前用于 AI 任务命名。内置 grsai 的命名模型即走这里。

import { fetchWithTimeout, readJsonLimited, normalizeBase, CONTROL_BODY_BYTES, CONTROL_BODY_TIMEOUT } from '../api';
import type { ChatAdapter, ChatContext, ChatMessage } from './types';

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
					messages,
				}),
			});
			if (!response.ok) {
				// 不读错误体直接放弃命名：先取消正文释放连接
				void response.body?.cancel().catch(() => {});
				return undefined;
			}
			// 命名回复只有一小段文本：按控制面小上限读
			const data = (await readJsonLimited(response, '命名响应', CONTROL_BODY_BYTES, CONTROL_BODY_TIMEOUT)) as {
					choices?: { message?: { content?: unknown } }[];
				};
			const content = data.choices?.[0]?.message?.content;
			return typeof content === 'string' ? content : undefined;
		} catch {
			return undefined;
		}
	},
};
