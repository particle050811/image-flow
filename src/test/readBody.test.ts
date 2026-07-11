// readBodyLimited / readJsonLimited 回归测试（F100/F101）：
// 用手工构造的 Response 直测限量（预检 + 流式累计）与限时（挂起流断流抛 TransientError）行为，不走网络。
import * as assert from 'assert';
import { readBodyLimited, readJsonLimited, TransientError } from '../backend/api';

/** 把若干 chunk 包成流式 Response；onCancel 观察流是否被主动取消（资源释放断言用） */
function streamResponse(
	chunks: Uint8Array[],
	headers?: Record<string, string>,
	onCancel?: () => void
): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) {
				controller.enqueue(c);
			}
			controller.close();
		},
		cancel() {
			onCancel?.();
		},
	});
	return new Response(stream, { headers });
}

suite('readBodyLimited 限量限时读取', () => {
	test('正常体完整读回', async () => {
		const data = await readBodyLimited(streamResponse([Buffer.from('hello'), Buffer.from('world')]), '测试体');
		assert.strictEqual(Buffer.from(data).toString(), 'helloworld');
	});

	test('Content-Length 预检超限：不读体直接报错，且取消正文流（不占连接）', async () => {
		let cancelled = false;
		const res = streamResponse([Buffer.from('x')], { 'content-length': String(200 * 1024 * 1024) }, () => {
			cancelled = true;
		});
		await assert.rejects(() => readBodyLimited(res, '测试体'), /超过大小上限/);
		// cancel 是 fire-and-forget，让出一拍事件循环再断言
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(cancelled, true);
	});

	test('流式累计超限：无 Content-Length 也断流报错，且取消正文流', async () => {
		// 用 pull 逐块推送且不 close：close 后的流 cancel 是 no-op，观察不到取消
		let cancelled = false;
		const pending = [Buffer.alloc(6), Buffer.alloc(6)];
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = pending.shift();
				if (next) {
					controller.enqueue(next);
				}
			},
			cancel() {
				cancelled = true;
			},
		});
		await assert.rejects(() => readBodyLimited(new Response(stream), '测试体', 10), /超过大小上限/);
		assert.strictEqual(cancelled, true);
	});

	test('正文迟迟传不完：超时断流抛 TransientError（轮询按瞬时错误重试）', async () => {
		// 只发一个 chunk 后挂起不 close，模拟上游只发响应头/半截正文
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Buffer.from('partial'));
			},
		});
		await assert.rejects(
			() => readBodyLimited(new Response(stream), '测试体', 1024, 100),
			(err: unknown) => err instanceof TransientError && /读取超时/.test(err.message)
		);
	});

	test('readJsonLimited：非法 JSON 报带上下文的错误', async () => {
		await assert.rejects(
			() => readJsonLimited(streamResponse([Buffer.from('<html>oops</html>')]), '接口响应'),
			/接口响应不是合法 JSON/
		);
		assert.deepStrictEqual(await readJsonLimited(streamResponse([Buffer.from('{"a":1}')]), '接口响应'), { a: 1 });
	});

	test('readJsonLimited：带 UTF-8 BOM 的 JSON 与 Response.json() 等价（可解析）', async () => {
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		const res = streamResponse([Buffer.concat([bom, Buffer.from('{"a":1}')])]);
		assert.deepStrictEqual(await readJsonLimited(res, '接口响应'), { a: 1 });
	});
});
