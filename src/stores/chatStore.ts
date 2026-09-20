import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Conversation, Message, CreateMessageParams } from '../types';
import {
  saveConversations,
  loadConversations,
  mergeConversations,
} from '../services/storage';
import { generateConversationTitle } from '../utils/formatters';

interface ChatState {
  /** 对话列表 */
  conversations: Conversation[];
  /** 当前活动对话 ID */
  activeConversationId: string | null;
  /** 是否正在流式响应 */
  isStreaming: boolean;
  /** 流式响应累积内容 */
  streamingContent: string;
  /** 流式响应消息 ID */
  streamingMessageId: string | null;
  /** 流式响应所属对话 ID（流式期间切换对话也不会写错地方） */
  streamingConversationId: string | null;
  /** 是否已初始化 */
  initialized: boolean;
}

interface ChatActions {
  /** 初始化（从 localStorage 加载） */
  initConversations: () => void;
  /** 创建新对话 */
  createConversation: (title?: string) => string;
  /** 删除对话 */
  deleteConversation: (id: string) => void;
  /** 设置活动对话 */
  setActiveConversation: (id: string | null) => void;
  /** 添加消息到对话 */
  addMessage: (conversationId: string, params: CreateMessageParams) => string;
  /** 更新消息（按消息 id 定位，不改动时间戳与排序） */
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  /** 开始流式响应：创建占位消息并立即落盘，返回消息 ID */
  startStreaming: (conversationId: string) => string;
  /** 追加流式内容（按会话/消息 id 定位，节流落盘） */
  appendStreamContent: (conversationId: string, messageId: string, content: string) => void;
  /** 完成流式响应 */
  finishStreaming: (conversationId: string, messageId: string, stats?: Message['stats']) => void;
  /** 取消流式响应（保留已接收的部分内容） */
  cancelStreaming: (conversationId: string, messageId: string) => void;
  /** 获取当前活动对话 */
  getActiveConversation: () => Conversation | null;
  /** 清除所有对话 */
  clearAllConversations: () => void;
  /** 更新对话标题 */
  updateConversationTitle: (id: string, title: string) => void;
}

type ChatStore = ChatState & ChatActions;

// ---------------------------------------------------------------------------
// 持久化调度
//
// 关键点：任何时刻都保存“最新的完整快照”，而不是某次调用时闭包住的旧数组。
// - persistNow：同步落盘，用于消息创建 / 流开始 / 流结束 / 页面关闭前；
// - scheduleSave：节流落盘，用于流式过程中的高频内容追加；
// - latestRef：始终指向最近一次 set 产生的对话数组，保证关闭页面时
//   flush 出去的是包含未完成消息的最新数据，而不是几秒前的旧快照。
// ---------------------------------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaveAt = 0;
const SAVE_THROTTLE_MS = 400;
// 始终保存最新快照，避免防抖期间数据被旧快照覆盖
let latestConversations: Conversation[] = [];

function clearSaveTimer(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function persistNow(conversations: Conversation[]): void {
  latestConversations = conversations;
  clearSaveTimer();
  lastSaveAt = Date.now();
  try {
    saveConversations(conversations);
  } catch (error) {
    console.error('Failed to save conversations:', error);
  }
}

function scheduleSave(conversations: Conversation[]): void {
  latestConversations = conversations;

  if (saveTimer) {
    // 已有待执行的保存，无需重复调度；它执行时读取的是 latestConversations
    return;
  }

  const elapsed = Date.now() - lastSaveAt;
  const delay = Math.max(0, SAVE_THROTTLE_MS - elapsed);

  saveTimer = setTimeout(() => {
    saveTimer = null;
    lastSaveAt = Date.now();
    try {
      saveConversations(latestConversations);
    } catch (error) {
      console.error('Failed to save conversations:', error);
    }
  }, delay);
}

/**
 * 立即把尚未落盘的最新快照写入 localStorage。
 * 在页面刷新 / 关闭 / 切到后台前调用，确保正在生成的回复不丢失。
 */
export function flushPendingSaves(): void {
  clearSaveTimer();
  try {
    saveConversations(latestConversations);
  } catch (error) {
    console.error('Failed to flush conversations:', error);
  }
}

// ---------------------------------------------------------------------------
// 多窗口同步：其它窗口写入 localStorage 时，按消息 id 合并进当前窗口。
// storage 事件只在“其它”窗口触发，因此不会与本窗口的保存形成循环。
// ---------------------------------------------------------------------------
let storageListenerBound = false;

function bindStorageSync(): void {
  if (storageListenerBound || typeof window === 'undefined') {
    return;
  }
  storageListenerBound = true;

  window.addEventListener('storage', (event) => {
    if (event.key !== 'react-chat-conversations' || !event.newValue) {
      return;
    }

    try {
      const incoming = JSON.parse(event.newValue) as Conversation[];
      if (!Array.isArray(incoming)) {
        return;
      }

      const { conversations } = useChatStore.getState();
      // 先把可能被本窗口节流住的最新内存数据落盘合并，避免被对端快照盖掉
      const merged = mergeConversations(
        saveTimer ? latestConversations : conversations,
        incoming
      );

      useChatStore.setState((state) => ({
        conversations: merged,
        activeConversationId:
          state.activeConversationId && merged.some((c) => c.id === state.activeConversationId)
            ? state.activeConversationId
            : merged[0]?.id ?? null,
      }));
      latestConversations = merged;
    } catch (error) {
      console.error('Failed to sync conversations from storage event:', error);
    }
  });
}

// 页面被刷新、关闭或切走时，同步刷盘一次
function bindUnloadFlush(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const flush = () => flushPendingSaves();

  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  });
  window.addEventListener('pagehide', flush);
}

bindStorageSync();
bindUnloadFlush();

export const useChatStore = create<ChatStore>((set, get) => ({
  // Initial state
  conversations: [],
  activeConversationId: null,
  isStreaming: false,
  streamingContent: '',
  streamingMessageId: null,
  streamingConversationId: null,
  initialized: false,

  // Actions
  initConversations: () => {
    const conversations = loadConversations();
    // 重新进入时不应自动恢复流状态：加载阶段已把孤立的 streaming 消息
    // 归一化为 error（内容保留），这里确保内存标志也是干净的
    const previousActiveId = get().activeConversationId;
    const activeId =
      (previousActiveId && conversations.some((c) => c.id === previousActiveId)
        ? previousActiveId
        : null) || conversations[0]?.id || null;

    set({
      conversations,
      activeConversationId: activeId,
      isStreaming: false,
      streamingContent: '',
      streamingMessageId: null,
      streamingConversationId: null,
      initialized: true,
    });
    latestConversations = conversations;
  },

  createConversation: (title) => {
    const id = uuidv4();
    const now = Date.now();

    const newConversation: Conversation = {
      id,
      title: title || '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    set(state => {
      const conversations = [newConversation, ...state.conversations];
      persistNow(conversations);
      return {
        conversations,
        activeConversationId: id,
      };
    });

    return id;
  },

  deleteConversation: (id) => {
    set(state => {
      const conversations = state.conversations.filter(c => c.id !== id);
      persistNow(conversations);

      // 如果删除的是当前活动对话，切换到第一个对话
      let activeConversationId = state.activeConversationId;
      if (activeConversationId === id) {
        activeConversationId = conversations[0]?.id ?? null;
      }

      // 如果删除的对话正在流式响应，清理流式状态
      const streamingPatch =
        state.streamingConversationId === id
          ? {
              isStreaming: false,
              streamingContent: '',
              streamingMessageId: null,
              streamingConversationId: null,
            }
          : {};

      return {
        conversations,
        activeConversationId,
        ...streamingPatch,
      };
    });
  },

  setActiveConversation: (id) => {
    set({ activeConversationId: id });
  },

  addMessage: (conversationId, params) => {
    const messageId = uuidv4();
    const now = Date.now();

    const newMessage: Message = {
      id: messageId,
      role: params.role,
      content: params.content,
      timestamp: now,
      status: params.status || 'complete',
    };

    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        // 幂等保护：极端重复调用下也不会追加出第二条相同 id 的消息
        if (conv.messages.some((msg) => msg.id === messageId)) {
          return conv;
        }

        const messages = [...conv.messages, newMessage];

        // 如果是第一条用户消息，自动生成标题
        let title = conv.title;
        if (params.role === 'user' && conv.messages.length === 0) {
          title = generateConversationTitle(params.content);
        }

        return {
          ...conv,
          messages,
          title,
          updatedAt: now,
        };
      });

      // 重新排序（按更新时间降序）
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);

      // 用户消息必须立刻落盘，刷新/返回后不能丢
      persistNow(conversations);
      return { conversations };
    });

    return messageId;
  },

  updateMessage: (conversationId, messageId, updates) => {
    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          // 不允许通过更新改动消息 id / 创建时间；也不在这里调整 updatedAt，
          // 以免仅编辑消息内容就打乱既有对话排列次序
          const { id: _id, timestamp: _timestamp, ...safeUpdates } = updates;
          return { ...msg, ...safeUpdates };
        });

        return { ...conv, messages };
      });

      persistNow(conversations);
      return { conversations };
    });
  },

  startStreaming: (conversationId) => {
    const messageId = uuidv4();
    const now = Date.now();

    const streamingMessage: Message = {
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: now,
      status: 'streaming',
    };

    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        return {
          ...conv,
          messages: [...conv.messages, streamingMessage],
          updatedAt: now,
        };
      });
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);

      // 关键：占位消息“创建即落盘”。这样无论刷新、返回还是关闭重进，
      // 这条回复都已存在于同一份本地记录中，后续只按 id 更新内容，
      // 绝不会再追加出第二条。
      persistNow(conversations);

      return {
        conversations,
        isStreaming: true,
        streamingContent: '',
        streamingMessageId: messageId,
        streamingConversationId: conversationId,
      };
    });

    return messageId;
  },

  appendStreamContent: (conversationId, messageId, content) => {
    set(state => {
      let newContent = '';
      let changed = false;

      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          changed = true;
          newContent = msg.content + content;
          return { ...msg, content: newContent };
        });

        return { ...conv, messages };
      });

      if (!changed) {
        return {};
      }

      // 流式内容高频到达，节流落盘：即使接口随后超时或页面被关掉，
      // 已接收到的部分内容最多只差一个节流周期，且关闭前还会同步 flush
      scheduleSave(conversations);

      return {
        streamingContent: newContent,
        conversations,
      };
    });
  },

  finishStreaming: (conversationId, messageId, stats) => {
    set(state => {
      // 流已经不属于当前这次（例如被新的一轮取代）时，不能误改其它消息
      if (
        state.streamingConversationId !== conversationId ||
        state.streamingMessageId !== messageId
      ) {
        return {};
      }

      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          return {
            ...msg,
            content: msg.content,
            status: 'complete' as const,
            stats,
          };
        });

        return { ...conv, messages };
      });

      // 终态立即同步落盘，保证完成的回复在刷新/返回/其它窗口中一致
      persistNow(conversations);

      return {
        conversations,
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
        streamingConversationId: null,
      };
    });
  },

  cancelStreaming: (conversationId, messageId) => {
    set(state => {
      if (
        state.streamingConversationId !== conversationId ||
        state.streamingMessageId !== messageId
      ) {
        return {};
      }

      // 保留已接收的内容，但标记为错误状态
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          return {
            ...msg,
            content: msg.content || '（响应已中断）',
            status: 'error' as const,
          };
        });

        return { ...conv, messages };
      });

      // 接口超时等异常路径同样立即落盘，没写完的那条不会丢
      persistNow(conversations);

      return {
        conversations,
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
        streamingConversationId: null,
      };
    });
  },

  getActiveConversation: () => {
    const { conversations, activeConversationId } = get();
    return conversations.find(c => c.id === activeConversationId) || null;
  },

  clearAllConversations: () => {
    set({
      conversations: [],
      activeConversationId: null,
      isStreaming: false,
      streamingContent: '',
      streamingMessageId: null,
      streamingConversationId: null,
    });
    persistNow([]);
  },

  updateConversationTitle: (id, title) => {
    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== id) return conv;
        return { ...conv, title };
      });

      persistNow(conversations);
      return { conversations };
    });
  },
}));
