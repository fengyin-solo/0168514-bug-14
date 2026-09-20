import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Conversation, Message, CreateMessageParams } from '../types';
import {
  saveConversations,
  loadConversations,
  loadDeletedConversationIds,
  addDeletedConversationIds,
  saveDeletedConversationIds,
  compareConversations,
  dedupeAndReconcileMessages,
  dedupeMessagesById,
} from '../services/storage';
import { generateConversationTitle } from '../utils/formatters';

/** 流式分片落盘的节流间隔（毫秒） */
const STREAM_SAVE_INTERVAL = 400;

interface ChatState {
  /** 对话列表 */
  conversations: Conversation[];
  /** 当前活动对话 ID */
  activeConversationId: string | null;
  /** 是否正在流式响应 */
  isStreaming: boolean;
  /** 流式响应累积内容 */
  streamingContent: string;
  /** 流式响应所属对话 ID（与当前活动对话解耦，切走对话也不会写错位置） */
  streamingConversationId: string | null;
  /** 流式响应消息 ID */
  streamingMessageId: string | null;
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
  /**
   * 发起一轮对话：原子地写入用户消息与助手占位消息并立即落盘。
   * @returns 用户消息 ID、助手占位消息 ID
   */
  beginExchange: (
    conversationId: string,
    params: CreateMessageParams
  ) => { userMessageId: string; assistantMessageId: string };
  /** 追加流式内容（按消息 ID 精确写入所属对话） */
  appendStreamContent: (conversationId: string, messageId: string, content: string) => void;
  /** 完成流式响应 */
  finishStreaming: (
    conversationId: string,
    messageId: string,
    stats?: Message['stats']
  ) => void;
  /** 流式失败/超时：保留已接收正文，标记为错误并立即落盘 */
  failStreaming: (conversationId: string, messageId: string) => void;
  /** 用户主动取消流式响应：保留已接收正文并立即落盘 */
  cancelStreaming: (conversationId: string, messageId: string) => void;
  /** 获取当前活动对话 */
  getActiveConversation: () => Conversation | null;
  /** 清除所有对话 */
  clearAllConversations: () => void;
  /** 更新对话标题 */
  updateConversationTitle: (id: string, title: string) => void;
}

type ChatStore = ChatState & ChatActions;

// ---- 持久化调度 -------------------------------------------------------------
// 结构性变更（发消息、创建/删除、流式结束等）立即同步落盘；
// 流式分片高频更新走节流；页面隐藏/关闭前统一 flush 最新状态。

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSaveAt = 0;

function persistNow(conversations: Conversation[]): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  lastSaveAt = Date.now();
  try {
    // 已删除（含其他窗口删除）的对话绝不回写，避免在途节流保存把它带回
    const tombstones = loadDeletedConversationIds();
    const visible = tombstones.length > 0
      ? conversations.filter(c => !tombstones.includes(c.id))
      : conversations;
    saveConversations(visible);
  } catch (error) {
    console.error('Failed to save conversations:', error);
  }
}

function scheduleSave(getConversations: () => Conversation[]): void {
  if (saveTimeout) return;

  const elapsed = Date.now() - lastSaveAt;
  const delay = Math.max(0, STREAM_SAVE_INTERVAL - elapsed);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    persistNow(getConversations());
  }, delay);
}

function flushPendingSave(): void {
  if (!saveTimeout) return;
  saveTimeout = null;
  persistNow(useChatStore.getState().conversations);
}

// ---- 多窗口（跨标签页）同步 --------------------------------------------------

/**
 * 合并外部窗口写入的对话数据与本地数据。
 * - 已删除墓碑过滤掉被删对话；
 * - 本窗口正在生成的消息以本地为准，避免被其他窗口的滞后分片覆盖；
 * - 其余对话按 updatedAt 取较新版本。
 */
function mergeConversations(
  local: Conversation[],
  incoming: Conversation[],
  tombstones: string[],
  streamingConversationId: string | null,
  streamingMessageId: string | null
): Conversation[] {
  const byId = new Map<string, Conversation>();

  for (const conv of local) {
    byId.set(conv.id, conv);
  }

  for (const remote of incoming) {
    if (tombstones.includes(remote.id)) continue;

    const localConv = byId.get(remote.id);
    if (!localConv) {
      byId.set(remote.id, remote);
      continue;
    }

    const localIsLive =
      streamingConversationId === remote.id &&
      localConv.messages.some(msg => msg.id === streamingMessageId && msg.status === 'streaming');

    if (localIsLive) {
      // 本地正在生成：合并远端带来的、本地不存在的消息（多窗口各自发消息的场景）
      const localIds = new Set(localConv.messages.map(msg => msg.id));
      const extra = dedupeAndReconcileMessages(
        remote.messages.filter(msg => !localIds.has(msg.id) && msg.status !== 'streaming')
      );
      if (extra.length > 0) {
        byId.set(localConv.id, {
          ...localConv,
          messages: [...localConv.messages, ...extra],
        });
      }
    } else if (remote.updatedAt >= localConv.updatedAt) {
      byId.set(remote.id, remote);
    }
  }

  return [...byId.values()]
    .filter(conv => !tombstones.includes(conv.id))
    .sort(compareConversations);
}

function applyIncomingState(incoming: Conversation[], incomingTombstones: string[]): void {
  const state = useChatStore.getState();

  const localTombstones = loadDeletedConversationIds();
  const tombstones = [...new Set([...incomingTombstones, ...localTombstones])].slice(0, 200);
  if (
    incomingTombstones.some(id => !localTombstones.includes(id)) ||
    localTombstones.some(id => !incomingTombstones.includes(id))
  ) {
    saveDeletedConversationIds(tombstones);
  }

  const conversations = mergeConversations(
    state.conversations,
    incoming,
    tombstones,
    state.streamingConversationId,
    state.streamingMessageId
  );

  let activeConversationId = state.activeConversationId;
  if (activeConversationId && !conversations.some(c => c.id === activeConversationId)) {
    activeConversationId = conversations[0]?.id ?? null;
  }

  useChatStore.setState({ conversations, activeConversationId });
}

let syncListenersBound = false;

/** 绑定跨窗口 storage 同步与 bfcache 恢复、页面关闭前落盘 */
function bindSyncListeners(): void {
  if (syncListenersBound || typeof window === 'undefined') return;
  syncListenersBound = true;

  window.addEventListener('storage', (event) => {
    if (event.key !== 'react-chat-conversations' && event.key !== 'react-chat-deleted-conversations') {
      return;
    }
    if (!event.newValue) return;

    try {
      const incoming = event.key === 'react-chat-conversations'
        ? (JSON.parse(event.newValue) as Conversation[])
        : loadConversations();
      const tombstones = event.key === 'react-chat-deleted-conversations'
        ? (JSON.parse(event.newValue) as string[])
        : loadDeletedConversationIds();
      applyIncomingState(incoming, tombstones);
    } catch (error) {
      console.error('Failed to apply synced conversations:', error);
    }
  });

  // 从 bfcache 恢复（移动端返回上一页常见路径）：本窗口无进行中的流时，对齐最新记录
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    const state = useChatStore.getState();
    if (state.isStreaming) return;
    applyIncomingState(loadConversations(), loadDeletedConversationIds());
  });

  // 页面关闭/刷新/切后台前，把节流中未落盘的最新内容同步写入
  const flush = () => flushPendingSave();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

// ---- Store ------------------------------------------------------------------

export const useChatStore = create<ChatStore>((set, get) => ({
  // Initial state
  conversations: [],
  activeConversationId: null,
  isStreaming: false,
  streamingContent: '',
  streamingConversationId: null,
  streamingMessageId: null,
  initialized: false,

  // Actions
  initConversations: () => {
    bindSyncListeners();
    const conversations = loadConversations();
    const tombstones = loadDeletedConversationIds();
    const visible = conversations.filter(c => !tombstones.includes(c.id));
    const activeId = visible.length > 0 ? visible[0]?.id ?? null : null;

    set({
      conversations: visible,
      activeConversationId: activeId,
      initialized: true,
    });
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

    set(state => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: id,
    }));

    persistNow(get().conversations);
    return id;
  },

  deleteConversation: (id) => {
    set(state => {
      const conversations = state.conversations.filter(c => c.id !== id);

      // 如果删除的是当前活动对话，切换到第一个对话
      let activeConversationId = state.activeConversationId;
      if (activeConversationId === id) {
        activeConversationId = conversations[0]?.id ?? null;
      }

      // 删除正在生成回复的对话：清掉流式状态，回调再到达时按 id 找不到消息即自动忽略
      const isStreamingTarget =
        state.isStreaming && state.streamingConversationId === id;

      return isStreamingTarget
        ? {
            conversations,
            activeConversationId,
            isStreaming: false,
            streamingContent: '',
            streamingConversationId: null,
            streamingMessageId: null,
          }
        : {
            conversations,
            activeConversationId,
          };
    });

    persistNow(get().conversations);
    addDeletedConversationIds([id]);
  },

  setActiveConversation: (id) => {
    set({ activeConversationId: id });
  },

  beginExchange: (conversationId, params) => {
    const userMessageId = uuidv4();
    const assistantMessageId = uuidv4();
    const now = Date.now();

    const userMessage: Message = {
      id: userMessageId,
      role: params.role,
      content: params.content,
      timestamp: now,
      status: 'complete',
    };

    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: now + 1,
      status: 'streaming',
    };

    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        // 如果是第一条用户消息，自动生成标题
        const title =
          params.role === 'user' && conv.messages.length === 0
            ? generateConversationTitle(params.content)
            : conv.title;

        return {
          ...conv,
          // 幂等保护：同一 id 不重复追加（新消息状态原样保留，不做收敛）
          messages: dedupeMessagesById([
            ...conv.messages,
            userMessage,
            assistantMessage,
          ]),
          title,
          updatedAt: now,
        };
      });

      conversations.sort(compareConversations);

      return {
        conversations,
        isStreaming: true,
        streamingContent: '',
        streamingConversationId: conversationId,
        streamingMessageId: assistantMessageId,
      };
    });

    // 用户消息与助手占位同一次提交立即落盘，刷新/关闭也不会缺条
    persistNow(get().conversations);

    return { userMessageId, assistantMessageId };
  },

  appendStreamContent: (conversationId, messageId, content) => {
    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          return { ...msg, content: msg.content + content };
        });

        return { ...conv, messages };
      });

      const target = conversations.find(c => c.id === conversationId);
      const targetMessage = target?.messages.find(m => m.id === messageId);

      return {
        conversations,
        streamingContent: targetMessage?.content ?? state.streamingContent + content,
      };
    });

    // 分片内容节流落盘：中途关闭页面最多丢失一个节流窗口的尾巴
    scheduleSave(() => get().conversations);
  },

  finishStreaming: (conversationId, messageId, stats) => {
    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          return {
            ...msg,
            content: msg.content || state.streamingContent,
            status: 'complete' as const,
            stats,
          };
        });

        return { ...conv, messages };
      });

      return {
        conversations,
        isStreaming: false,
        streamingContent: '',
        streamingConversationId: null,
        streamingMessageId: null,
      };
    });

    persistNow(get().conversations);
  },

  failStreaming: (conversationId, messageId) => {
    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          // 保留已接收的部分正文；一条都没收到时给出中断提示，绝不删条
          return {
            ...msg,
            content: msg.content || state.streamingContent || '（响应超时，内容未完成）',
            status: 'error' as const,
          };
        });

        return { ...conv, messages };
      });

      return {
        conversations,
        isStreaming: false,
        streamingContent: '',
        streamingConversationId: null,
        streamingMessageId: null,
      };
    });

    // 超时/报错立即落盘，不经过防抖
    persistNow(get().conversations);
  },

  cancelStreaming: (conversationId, messageId) => {
    set(state => {
      const conversations = state.conversations.map(conv => {
        if (conv.id !== conversationId) return conv;

        const messages = conv.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          return {
            ...msg,
            content: msg.content || state.streamingContent || '（响应已中断）',
            status: 'error' as const,
          };
        });

        return { ...conv, messages };
      });

      return {
        conversations,
        isStreaming: false,
        streamingContent: '',
        streamingConversationId: null,
        streamingMessageId: null,
      };
    });

    persistNow(get().conversations);
  },

  getActiveConversation: () => {
    const { conversations, activeConversationId } = get();
    return conversations.find(c => c.id === activeConversationId) || null;
  },

  clearAllConversations: () => {
    const ids = get().conversations.map(c => c.id);
    set({
      conversations: [],
      activeConversationId: null,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      streamingMessageId: null,
    });
    persistNow([]);
    if (ids.length > 0) {
      addDeletedConversationIds(ids);
    }
  },

  updateConversationTitle: (id, title) => {
    set(state => ({
      conversations: state.conversations.map(conv =>
        conv.id !== id ? conv : { ...conv, title }
      ),
    }));

    persistNow(get().conversations);
  },
}));
