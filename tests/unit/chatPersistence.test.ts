import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../../src/stores/chatStore';
import { loadConversations } from '../../src/services/storage';
import { localStorageMock, documentMock } from '../setup-node';

const STORAGE_KEY = 'react-chat-conversations';

function readPersisted(): ReturnType<typeof loadConversations> {
  return loadConversations();
}

function resetStore() {
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    streamingContent: '',
    streamingMessageId: null,
    streamingConversationId: null,
    initialized: false,
  });
}

describe('消息持久化：流式回复与已完成回复落到同一份本地记录', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetStore();
    vi.useRealTimers();
  });

  it('用户消息与流式占位消息创建后立即落盘（刷新/返回后仍在）', () => {
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '你好' });

    // startStreaming 之后，即便一个流片段都还没收到，也必须已持久化
    const assistantId = useChatStore.getState().startStreaming(convId);

    const persisted = readPersisted();
    expect(persisted).toHaveLength(1);
    const messages = persisted[0]!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好', status: 'complete' });
    // 经“重新加载”语义读取时，孤立的 streaming 会被归一化为 error 但消息仍在
    expect(messages[1]).toMatchObject({ id: assistantId, role: 'assistant', status: 'error' });

    // 当前页面内存里它仍是 streaming（同一份记录，只是生命周期状态不同）
    const live = useChatStore.getState().conversations[0]!.messages[1]!;
    expect(live.status).toBe('streaming');

    // 原始存储中占位消息确实已立即写入
    const raw = JSON.parse(localStorageMock.getItem(STORAGE_KEY) || '[]');
    expect(raw[0].messages[1]).toMatchObject({ id: assistantId, role: 'assistant', status: 'streaming' });
  });

  it('流式追加的内容会写入本地记录，完成后刷新仍保持同一条消息（不重复）', async () => {
    vi.useFakeTimers();
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '问题' });
    const assistantId = useChatStore.getState().startStreaming(convId);

    useChatStore.getState().appendStreamContent(convId, assistantId, '第一');
    useChatStore.getState().appendStreamContent(convId, assistantId, '二段');
    await vi.advanceTimersByTimeAsync(500);

    useChatStore
      .getState()
      .finishStreaming(convId, assistantId, { responseTime: 10, tokenCount: 4 });

    const persisted = readPersisted();
    const messages = persisted[0]!.messages;
    // 条数一致：用户 1 条 + 助手 1 条，绝不能出现两条助手回复
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: assistantId,
      role: 'assistant',
      content: '第一二段',
      status: 'complete',
    });
  });

  it('生成中途刷新（重新加载）：消息只出现一次，且保留已接收的部分内容', async () => {
    vi.useFakeTimers();
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '问题' });
    const assistantId = useChatStore.getState().startStreaming(convId);

    useChatStore.getState().appendStreamContent(convId, assistantId, '已经写出的内容');
    await vi.advanceTimersByTimeAsync(500);

    // 模拟关闭/刷新页面：可见性切到 hidden 会同步 flush
    documentMock.setVisibility('hidden');

    // 新页面实例：重新从 localStorage 初始化
    resetStore();
    useChatStore.getState().initConversations();
    const state = useChatStore.getState();

    const messages = state.conversations[0]!.messages;
    expect(messages).toHaveLength(2);
    const assistant = messages.find((m) => m.id === assistantId)!;
    expect(assistant).toBeDefined();
    expect(assistant.content).toBe('已经写出的内容');
    // 孤立的流式消息被归一化为 error，而不是重新生成出第二条
    expect(assistant.status).toBe('error');
    expect(state.isStreaming).toBe(false);
    expect(state.streamingMessageId).toBeNull();
  });

  it('接口超时（onError）时，没写完的那条及其部分内容不丢失', async () => {
    vi.useFakeTimers();
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '问题' });
    const assistantId = useChatStore.getState().startStreaming(convId);
    useChatStore.getState().appendStreamContent(convId, assistantId, '半截回复');

    // 节流保存尚未触发，接口直接报错
    useChatStore.getState().cancelStreaming(convId, assistantId);

    const persisted = readPersisted();
    const assistant = persisted[0]!.messages.find((m) => m.id === assistantId)!;
    expect(assistant.content).toBe('半截回复');
    expect(assistant.status).toBe('error');
    expect(persisted[0]!.messages).toHaveLength(2);
  });

  it('beforeunload 时会把最新（含未节流落盘的）内容同步刷盘', async () => {
    vi.useFakeTimers();
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '问题' });
    const assistantId = useChatStore.getState().startStreaming(convId);
    useChatStore.getState().appendStreamContent(convId, assistantId, '即将刷新前的内容');

    // 不推进定时器，直接触发 beforeunload
    (window as unknown as { dispatchEvent: (type: string) => void }).dispatchEvent('beforeunload');

    const raw = JSON.parse(localStorageMock.getItem(STORAGE_KEY) || '[]');
    expect(raw[0].messages).toHaveLength(2);
    expect(raw[0].messages[1]).toMatchObject({
      id: assistantId,
      content: '即将刷新前的内容',
    });
  });

  it('流期间切换到别的对话，内容仍写入原对话（不串话）', async () => {
    vi.useFakeTimers();
    const convA = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convA, { role: 'user', content: 'A 的问题' });
    const assistantA = useChatStore.getState().startStreaming(convA);

    const convB = useChatStore.getState().createConversation();
    useChatStore.getState().setActiveConversation(convB);

    useChatStore.getState().appendStreamContent(convA, assistantA, '给 A 的回复');
    await vi.advanceTimersByTimeAsync(500);

    const state = useChatStore.getState();
    const a = state.conversations.find((c) => c.id === convA)!;
    const b = state.conversations.find((c) => c.id === convB)!;
    expect(a.messages[1]).toMatchObject({ id: assistantA, content: '给 A 的回复' });
    expect(b.messages).toHaveLength(0);
  });

  it('接着发下一条不会顶掉上一条，消息条数与顺序累积', () => {
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '第一条' });
    const a1 = useChatStore.getState().startStreaming(convId);
    useChatStore
      .getState()
      .finishStreaming(convId, a1, { responseTime: 1, tokenCount: 1 });

    useChatStore.getState().addMessage(convId, { role: 'user', content: '第二条' });
    const a2 = useChatStore.getState().startStreaming(convId);
    useChatStore
      .getState()
      .finishStreaming(convId, a2, { responseTime: 1, tokenCount: 1 });

    const messages = readPersisted()[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.map((m) => m.content)).toEqual(['第一条', '', '第二条', '']);
    // 时间戳严格递增，顺序未被重排
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i]!.timestamp).toBeGreaterThanOrEqual(messages[i - 1]!.timestamp);
    }
  });
});

describe('多窗口同步', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetStore();
    vi.useRealTimers();
  });

  it('其它窗口写入的完整回复会通过 storage 事件合并过来，且不产生重复', () => {
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '本地问题' });
    const assistantId = useChatStore.getState().startStreaming(convId);

    // 模拟“另一个窗口”完成了同一条回复后写入全量快照
    const snapshot = [
      {
        id: convId,
        title: '本地问题',
        createdAt: 1,
        updatedAt: 2,
        messages: [
          {
            id: useChatStore.getState().conversations[0]!.messages[0]!.id,
            role: 'user',
            content: '本地问题',
            timestamp: 1,
            status: 'complete',
          },
          {
            id: assistantId,
            role: 'assistant',
            content: '来自另一窗口的完整回复',
            timestamp: 2,
            status: 'complete',
            stats: { responseTime: 100, tokenCount: 10 },
          },
        ],
      },
    ];

    localStorageMock.emitStorage(STORAGE_KEY, JSON.stringify(snapshot), null);

    const state = useChatStore.getState();
    const messages = state.conversations.find((c) => c.id === convId)!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: assistantId,
      content: '来自另一窗口的完整回复',
      status: 'complete',
    });
  });

  it('另一窗口删除了会话，本窗口同步后不会把它“复活”', () => {
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: 'x' });
    expect(useChatStore.getState().conversations).toHaveLength(1);

    localStorageMock.emitStorage(STORAGE_KEY, JSON.stringify([]), null);

    expect(useChatStore.getState().conversations).toHaveLength(0);
  });
});

describe('时间与排序不被改动', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetStore();
  });

  it('updateMessage 不允许改写消息时间戳，也不改变对话 updatedAt 排序', () => {
    const convId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(convId, { role: 'user', content: '内容' });
    const msgId = useChatStore.getState().conversations[0]!.messages[0]!.id;
    const beforeConv = useChatStore.getState().conversations[0]!;
    const originalUpdatedAt = beforeConv.updatedAt;
    const originalTimestamp = beforeConv.messages[0]!.timestamp;

    // 尝试通过更新同时改掉时间戳与 updatedAt
    useChatStore
      .getState()
      .updateMessage(convId, msgId, { content: '改过的内容', timestamp: originalTimestamp + 99999 } as never);

    const conv = useChatStore.getState().conversations[0]!;
    expect(conv.messages[0]!.timestamp).toBe(originalTimestamp);
    expect(conv.messages[0]!.content).toBe('改过的内容');
    expect(conv.updatedAt).toBe(originalUpdatedAt);
  });
});
