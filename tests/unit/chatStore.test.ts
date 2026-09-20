import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../../src/stores/chatStore';
import {
  loadConversations,
  loadDeletedConversationIds,
} from '../../src/services/storage';

// localStorage mock（Node 环境无内置实现）
const memoryStore: Record<string, string> = {};
const windowListeners: Record<string, EventListener[]> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => (key in memoryStore ? memoryStore[key] : null),
  setItem: (key: string, value: string) => {
    memoryStore[key] = String(value);
  },
  removeItem: (key: string) => {
    delete memoryStore[key];
  },
  clear: () => {
    for (const key of Object.keys(memoryStore)) delete memoryStore[key];
  },
});
vi.stubGlobal('window', {
  addEventListener: (type: string, fn: EventListener) => {
    (windowListeners[type] ??= []).push(fn);
  },
  removeEventListener: () => undefined,
});
vi.stubGlobal('document', {
  addEventListener: () => undefined,
  visibilityState: 'visible',
});

/** 模拟其他窗口写入并派发 storage 事件 */
function emitStorage(key: string, value: string) {
  memoryStore[key] = value;
  for (const fn of windowListeners.storage ?? []) {
    fn({ key, newValue: value } as StorageEvent);
  }
}

function resetStore() {
  for (const key of Object.keys(memoryStore)) delete memoryStore[key];
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    streamingContent: '',
    streamingConversationId: null,
    streamingMessageId: null,
    initialized: false,
  });
}

function readRawStoredConversations(): any[] {
  const raw = memoryStore['react-chat-conversations'];
  return raw ? JSON.parse(raw) : [];
}

describe('chatStore 消息持久化与一致性', () => {
  beforeEach(resetStore);

  it('beginExchange 立即把用户消息与助手占位一起落盘', () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().beginExchange(cid, { role: 'user', content: '你好', status: 'complete' });

    // 直接读原始落盘内容（未经“刷新收敛”）
    const stored = readRawStoredConversations();
    expect(stored).toHaveLength(1);
    expect(stored[0].messages).toHaveLength(2);
    expect(stored[0].messages[0]).toMatchObject({ role: 'user', content: '你好', status: 'complete' });
    expect(stored[0].messages[1]).toMatchObject({ role: 'assistant', content: '', status: 'streaming' });
  });

  it('流式分片内容随节流落盘，刷新后能读到已接收的部分正文', async () => {
    vi.useFakeTimers();
    const cid = useChatStore.getState().createConversation();
    const { assistantMessageId } = useChatStore.getState().beginExchange(cid, {
      role: 'user',
      content: '问题',
      status: 'complete',
    });

    useChatStore.getState().appendStreamContent(cid, assistantMessageId, '第一句');
    useChatStore.getState().appendStreamContent(cid, assistantMessageId, '第二句');
    await vi.advanceTimersByTimeAsync(500);

    const stored = readRawStoredConversations();
    const assistant = stored[0].messages.find((m: any) => m.id === assistantMessageId);
    expect(assistant.content).toBe('第一句第二句');
    expect(assistant.status).toBe('streaming');
    vi.useRealTimers();
  });

  it('重新加载时未完成的消息只保留一条，正文不丢，状态收敛为 error', async () => {
    const cid = useChatStore.getState().createConversation();
    const { assistantMessageId } = useChatStore.getState().beginExchange(cid, {
      role: 'user',
      content: '问题',
      status: 'complete',
    });
    useChatStore.getState().appendStreamContent(cid, assistantMessageId, '已写一半');
    // 等节流落盘完成
    await new Promise(resolve => setTimeout(resolve, 500));

    // 模拟刷新：重新从 localStorage 初始化
    useChatStore.getState().initConversations();

    const conv = useChatStore.getState().conversations[0]!;
    expect(conv.messages).toHaveLength(2); // 用户 + 助手各一条，不重复
    const assistant = conv.messages.find(m => m.id === assistantMessageId)!;
    expect(assistant.status).toBe('error');
    expect(assistant.content).toBe('已写一半');
  });

  it('超时/失败保留部分正文并立即落盘', () => {
    const cid = useChatStore.getState().createConversation();
    const { assistantMessageId } = useChatStore.getState().beginExchange(cid, {
      role: 'user',
      content: '问题',
      status: 'complete',
    });
    useChatStore.getState().appendStreamContent(cid, assistantMessageId, '部分回复');
    useChatStore.getState().failStreaming(cid, assistantMessageId);

    const stored = loadConversations();
    const assistant = stored[0]!.messages.find(m => m.id === assistantMessageId)!;
    expect(assistant.status).toBe('error');
    expect(assistant.content).toBe('部分回复');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('流式过程中切换活动对话，分片仍写回原对话', () => {
    const cidA = useChatStore.getState().createConversation();
    const { assistantMessageId: idA } = useChatStore.getState().beginExchange(cidA, {
      role: 'user',
      content: 'A 的问题',
      status: 'complete',
    });

    const cidB = useChatStore.getState().createConversation();
    useChatStore.getState().setActiveConversation(cidB);

    useChatStore.getState().appendStreamContent(cidA, idA, 'A 的回复');
    useChatStore.getState().finishStreaming(cidA, idA);

    const convA = useChatStore.getState().conversations.find(c => c.id === cidA)!;
    const convB = useChatStore.getState().conversations.find(c => c.id === cidB)!;
    const assistantA = convA.messages.find(m => m.id === idA)!;
    expect(assistantA.content).toBe('A 的回复');
    expect(assistantA.status).toBe('complete');
    expect(convB.messages).toHaveLength(0);
  });

  it('连续两轮对话：上一条不被顶掉，顺序为 u1/a1/u2/a2', () => {
    const cid = useChatStore.getState().createConversation();

    const r1 = useChatStore.getState().beginExchange(cid, { role: 'user', content: '第一条', status: 'complete' });
    useChatStore.getState().appendStreamContent(cid, r1.assistantMessageId, '回复一');
    useChatStore.getState().finishStreaming(cid, r1.assistantMessageId);

    const r2 = useChatStore.getState().beginExchange(cid, { role: 'user', content: '第二条', status: 'complete' });
    useChatStore.getState().appendStreamContent(cid, r2.assistantMessageId, '回复二');
    useChatStore.getState().finishStreaming(cid, r2.assistantMessageId);

    const conv = useChatStore.getState().conversations.find(c => c.id === cid)!;
    expect(conv.messages.map(m => m.content)).toEqual(['第一条', '回复一', '第二条', '回复二']);
    expect(new Set(conv.messages.map(m => m.id)).size).toBe(4);

    // 刷新后一致
    useChatStore.getState().initConversations();
    const reloaded = useChatStore.getState().conversations.find(c => c.id === cid)!;
    expect(reloaded.messages.map(m => m.content)).toEqual(['第一条', '回复一', '第二条', '回复二']);
  });

  it('删除对话写入墓碑，多窗口同步时不会被旧数据带回', () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().beginExchange(cid, { role: 'user', content: 'x', status: 'complete' });
    useChatStore.getState().deleteConversation(cid);

    expect(loadConversations()).toHaveLength(0);
    expect(loadDeletedConversationIds()).toContain(cid);
  });

  it('多窗口：其他窗口新写入的对话通过 storage 事件同步到当前窗口', () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().initConversations();

    const remote = [{
      id: 'remote-conv',
      title: '另一窗口的对话',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        { id: 'rm1', role: 'user', content: '远程提问', timestamp: 1000, status: 'complete' },
        { id: 'rm2', role: 'assistant', content: '远程回复', timestamp: 1001, status: 'complete' },
      ],
    }];

    emitStorage('react-chat-conversations', JSON.stringify(remote));

    const ids = useChatStore.getState().conversations.map(c => c.id);
    expect(ids).toContain('remote-conv');
    expect(ids).toContain(cid); // 本地对话也在
    const synced = useChatStore.getState().conversations.find(c => c.id === 'remote-conv')!;
    expect(synced.messages.map(m => m.content)).toEqual(['远程提问', '远程回复']);
  });

  it('多窗口：其他窗口删除某对话后，当前窗口同步移除', () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().initConversations();
    expect(useChatStore.getState().conversations.some(c => c.id === cid)).toBe(true);

    emitStorage('react-chat-deleted-conversations', JSON.stringify([cid]));

    expect(useChatStore.getState().conversations.some(c => c.id === cid)).toBe(false);
  });

  it('多窗口：本窗口正在生成的消息不被其他窗口的滞后分片覆盖', () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().initConversations();
    const { assistantMessageId } = useChatStore.getState().beginExchange(cid, {
      role: 'user',
      content: '本地提问',
      status: 'complete',
    });
    useChatStore.getState().appendStreamContent(cid, assistantMessageId, '本地最新内容');

    // 另一个窗口带来同一对话的滞后版本
    const remote = [{
      id: cid,
      title: '新对话',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() + 10000, // 即使远端 updatedAt 更新
      messages: [
        { id: 'u1', role: 'user', content: '本地提问', timestamp: 1, status: 'complete' },
        { id: assistantMessageId, role: 'assistant', content: '滞后内容', timestamp: 2, status: 'streaming' },
      ],
    }];
    emitStorage('react-chat-conversations', JSON.stringify(remote));

    const conv = useChatStore.getState().conversations.find(c => c.id === cid)!;
    const assistant = conv.messages.find(m => m.id === assistantMessageId)!;
    expect(assistant.content).toBe('本地最新内容');
  });

  it('已有消息的时间戳在流式追加过程中不被改动', () => {
    const cid = useChatStore.getState().createConversation();
    const { userMessageId, assistantMessageId } = useChatStore.getState().beginExchange(cid, {
      role: 'user',
      content: '问题',
      status: 'complete',
    });

    const before = useChatStore.getState()
      .conversations.find(c => c.id === cid)!
      .messages.map(m => [m.id, m.timestamp] as const);

    useChatStore.getState().appendStreamContent(cid, assistantMessageId, '内容');
    useChatStore.getState().finishStreaming(cid, assistantMessageId);

    const after = useChatStore.getState()
      .conversations.find(c => c.id === cid)!
      .messages.map(m => [m.id, m.timestamp] as const);

    expect(after).toEqual(before);
    expect(after.find(([id]) => id === userMessageId)![1])
      .toBeLessThan(after.find(([id]) => id === assistantMessageId)![1]);
  });
});
