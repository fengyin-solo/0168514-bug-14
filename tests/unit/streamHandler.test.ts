import { describe, it, expect, vi } from 'vitest';
import { StreamHandler } from '../../src/services/stream';

async function* makeStream(chunks: string[], signal?: { aborted: boolean}): AsyncGenerator<string> {
  for (const chunk of chunks) {
    yield chunk;
    if (signal?.aborted) return;
  }
}

describe('StreamHandler 生命周期', () => {
  it('正常结束时回调 onComplete，累积内容完整', async () => {
    const handler = new StreamHandler();
    const onChunk = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const onAbort = vi.fn();

    await handler.start(
      makeStream(['a', 'b', 'c']),
      {
        onChunk,
        onComplete,
        onError,
        onAbort,
      }
    );

    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    expect(handler.getAccumulatedContent()).toBe('abc');
    expect(handler.getIsActive()).toBe(false);
  });

  it('外部 signal 中止时只回调 onAbort，已收到的分片不丢', async () => {
    const handler = new StreamHandler();
    const controller = new AbortController();
    const received: string[] = [];

    const startPromise = handler.start(
      (async function* () {
        yield '已接收';
        // 模拟网络读取期间被中止
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 10));
        yield '不应到达';
      })(),
      {
        onChunk: (c) => received.push(c),
        onComplete: () => expect.fail('不应完成'),
        onError: () => expect.fail('不应报错'),
        onAbort: vi.fn(),
      },
      controller.signal
    );

    await startPromise;
    expect(received).toEqual(['已接收']);
    expect(handler.getIsActive()).toBe(false);
  });

  it('流抛错（超时/网络错误）时回调 onError', async () => {
    const handler = new StreamHandler();
    const onError = vi.fn();
    const onAbort = vi.fn();

    await handler.start(
      (async function* () {
        yield '半截';
        throw new Error('Request timed out');
      })(),
      {
        onChunk: vi.fn(),
        onComplete: vi.fn(),
        onError,
        onAbort,
      }
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onAbort).not.toHaveBeenCalled();
  });
});
