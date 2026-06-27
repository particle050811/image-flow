// OpenAI 兼容对话协议（非流式）：POST /v1/chat/completions → choices[0].message.content。
// 当前用于 AI 任务命名。内置 grsai 的命名模型即走这里。

import { fetchWithTimeout, normalizeBase } from '../api';
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
				return undefined;
			}
			const data = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
			const content = data.choices?.[0]?.message?.content;
			return typeof content === 'string' ? content : undefined;
		} catch {
			return undefined;
		}
	},
};
