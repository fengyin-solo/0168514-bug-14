import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Conversation, Message } from '../../src/types';
import { mergeConversations } from '../../src/services/storage';

interface MergeFixture {
  local: Conversation[];
  remote: Conversation[];
  sharedIds: Set<string>;
  allIds: Set<string>;
}

/**
 * 构造一对“同一对话在两个窗口中的快照”：
 * - 一部分消息 id 两边都有（模拟流式消息被两端分别更新）；
 * - 一部分消息只在远端存在（模拟另一窗口新增的回复）。
 */
const fixtureArb: fc.Arbitrary<MergeFixture> = fc
  .tuple(
    fc.integer({ min: 0, max: 6 }),
    fc.integer({ min: 0, max: 6 }),
    fc.integer({ min: 0, max: 4 })
  )
  .chain(([sharedCount, extraCount, variantCount]) =>
    fc
      .tuple(
        fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), { maxLength: sharedCount }),
        fc.uniqueArray(fc.integer({ min: 100001, max: 200000 }), { maxLength: extraCount }),
        fc.array(fc.integer({ min: 1, max: 100000 }), { maxLength: variantCount })
      )
      .map(([sharedIdsN, extraIdsN, variantIdsN]): MergeFixture => {
        const sharedIds = new Set(sharedIdsN.map((n) => `m${n}`));
        const allIds = new Set([
          ...sharedIdsN.map((n) => `m${n}`),
          ...extraIdsN.map((n) => `m${n}`),
        ]);

        const localMessages: Message[] = sharedIdsN.map((n) => ({
          id: `m${n}`,
          role: 'user',
          content: `local-${n}`,
          timestamp: n,
          status: 'complete',
        }));

        const sharedVariants: Message[] = sharedIdsN.map((n) => ({
          id: `m${n}`,
          role: 'assistant',
          content: `remote-version-${n}`.repeat(n % 3),
          timestamp: n, // 时间戳与本地一致，合并不应改写它
          status: n % 2 === 0 ? 'complete' : 'streaming',
        }));

        const errorOverrides: Message[] = variantIdsN.map((n) => ({
          id: `m${n}`,
          role: 'assistant',
          content: 'x'.repeat(n % 5),
          timestamp: n,
          status: 'error',
        }));

        const remoteOnly: Message[] = extraIdsN.map((n) => ({
          id: `m${n}`,
          role: 'assistant',
          content: `remote-only-${n}`,
          timestamp: n,
          status: 'complete',
        }));

        return {
          local: [
            {
              id: 'conv-1',
              title: 't',
              createdAt: 0,
              updatedAt: 0,
              messages: localMessages,
            },
          ],
          remote: [
            {
              id: 'conv-1',
              title: 't',
              createdAt: 0,
              updatedAt: 100,
              messages: [...sharedVariants, ...errorOverrides, ...remoteOnly],
            },
          ],
          sharedIds,
          allIds,
        };
      })
  );

describe('mergeConversations 不变量（property-based）', () => {
  it('不丢消息、不重复、不改时间戳、按时间戳有序', () => {
    fc.assert(
      fc.property(fixtureArb, ({ local, remote, sharedIds, allIds }) => {
        const merged = mergeConversations(local, remote);
        const messages = merged[0]!.messages;

        // 1. 消息 id 唯一：同一条回复绝不会出现两份
        const ids = messages.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);

        // 2. 任一方已有的消息都不会丢
        for (const id of allIds) {
          expect(ids).toContain(id);
        }

        // 3. 共享消息的时间戳绝不被合并改写
        for (const msg of messages) {
          if (sharedIds.has(msg.id)) {
            expect(msg.timestamp).toBe(Number(msg.id.slice(1)));
          }
        }

        // 4. 顺序按时间戳稳定升序
        for (let i = 1; i < messages.length; i += 1) {
          expect(messages[i]!.timestamp).toBeGreaterThanOrEqual(messages[i - 1]!.timestamp);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('多次合并满足幂等：消息身份集合不再变化', () => {
    fc.assert(
      fc.property(fixtureArb, ({ local, remote }) => {
        const once = mergeConversations(local, remote);
        const twice = mergeConversations(once, remote);
        expect(twice[0]!.messages.map((m) => m.id)).toEqual(once[0]!.messages.map((m) => m.id));
      }),
      { numRuns: 100 }
    );
  });
});
