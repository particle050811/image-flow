// adapter 注册表：按 id 取图片 / 对话 adapter。加新协议在此登记一行。

import type { ImageAdapter, ChatAdapter } from './types';
import { grsaiAsync } from './grsaiAsync';
import { openaiImages } from './openaiImages';
import { geminiGenerate } from './geminiGenerate';
import { openaiChat } from './openaiChat';
import { jimengCli } from './jimengCli';

const IMAGE_ADAPTERS: Record<string, ImageAdapter> = {
	[grsaiAsync.id]: grsaiAsync,
	[openaiImages.id]: openaiImages,
	[geminiGenerate.id]: geminiGenerate,
	[jimengCli.id]: jimengCli,
};

const CHAT_ADAPTERS: Record<string, ChatAdapter> = {
	[openaiChat.id]: openaiChat,
};

/** 取图片 adapter；未知 id 抛错（settings.json 写了不存在的 adapter 时尽早暴露） */
export function getImageAdapter(id: string): ImageAdapter {
	const adapter = IMAGE_ADAPTERS[id];
	if (!adapter) {
		throw new Error(`未知的图片调用协议（adapter）：${id}`);
	}
	return adapter;
}

/** 取对话 adapter；未知 id 抛错 */
export function getChatAdapter(id: string): ChatAdapter {
	const adapter = CHAT_ADAPTERS[id];
	if (!adapter) {
		throw new Error(`未知的对话调用协议（adapter）：${id}`);
	}
	return adapter;
}

export * from './types';
