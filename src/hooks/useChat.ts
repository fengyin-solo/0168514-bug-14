import { useCallback, useRef } from 'react';
import { message } from 'antd';
import { useChatStore } from '../stores/chatStore';
import { useConfigStore } from '../stores/configStore';
import { useUIStore } from '../stores/uiStore';
import { sendMessageStream } from '../services/api';
import { createStreamHandler, toMessageStats } from '../services/stream';
import { parseError, logError, shouldShowConfigPanel } from '../services/errorHandler';
import type { APIMessage } from '../types';

// 创建流处理器实例
const streamHandler = createStreamHandler();

/**
 * 聊天功能 Hook
 */
export function useChat() {
  const {
    conversations,
    activeConversationId,
    isStreaming,
    streamingMessageId,
    getActiveConversation,
    createConversation,
    deleteConversation,
    setActiveConversation,
    beginExchange,
    appendStreamContent,
    finishStreaming,
    failStreaming,
    cancelStreaming,
  } = useChatStore();

  const { config, isValid: isConfigValid } = useConfigStore();
  const { setConfigPanelVisible } = useUIStore();
  const abortControllerRef = useRef<AbortController | null>(null);

  const conversation = getActiveConversation();
  const messages = conversation?.messages || [];

  /**
   * 发送消息
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!activeConversationId) {
        message.warning('请先创建或选择一个对话');
        return;
      }

      if (!isConfigValid) {
        message.warning('请先配置 API Key');
        setConfigPanelVisible(true);
        return;
      }

      if (useChatStore.getState().isStreaming) {
        return;
      }

      // 获取当前对话的历史消息（在写入本轮消息之前）
      const currentConversation = useChatStore
        .getState()
        .conversations.find(c => c.id === activeConversationId);
      const historyMessages = currentConversation?.messages || [];

      // 原子写入：用户消息 + 助手占位消息，同一次提交立即落盘
      const { assistantMessageId } = beginExchange(activeConversationId, {
        role: 'user',
        content,
        status: 'complete',
      });

      // 准备 API 消息
      const apiMessages: APIMessage[] = [
        ...historyMessages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        { role: 'user' as const, content },
      ];

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const stream = sendMessageStream(
          apiMessages,
          {
            ...config,
            stream: true,
          },
          abortController.signal
        );

        await streamHandler.start(
          stream,
          {
            onChunk: (chunk) => {
              appendStreamContent(activeConversationId, assistantMessageId, chunk);
            },
            onComplete: (stats) => {
              finishStreaming(activeConversationId, assistantMessageId, toMessageStats(stats));
            },
            onError: (error) => {
              const appError = parseError(error);
              logError(appError, 'useChat.sendMessage');
              message.error(appError.message);
              failStreaming(activeConversationId, assistantMessageId);

              if (shouldShowConfigPanel(appError)) {
                setConfigPanelVisible(true);
              }
            },
            onAbort: () => {
              cancelStreaming(activeConversationId, assistantMessageId);
            },
          },
          abortController.signal
        );
      } catch (error) {
        const appError = parseError(error);
        logError(appError, 'useChat.sendMessage');
        message.error(appError.message);
        failStreaming(activeConversationId, assistantMessageId);

        if (shouldShowConfigPanel(appError)) {
          setConfigPanelVisible(true);
        }
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
      }
    },
    [
      activeConversationId,
      isConfigValid,
      config,
      beginExchange,
      appendStreamContent,
      finishStreaming,
      failStreaming,
      cancelStreaming,
      setConfigPanelVisible,
    ]
  );

  /**
   * 停止流式响应
   */
  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    streamHandler.abort();
    message.info('已停止响应');
  }, []);

  /**
   * 创建新对话并发送消息
   */
  const startNewChat = useCallback(
    async (content?: string) => {
      const id = createConversation();
      if (content) {
        // 等待状态更新后发送消息
        setTimeout(() => {
          sendMessage(content);
        }, 0);
      }
      return id;
    },
    [createConversation, sendMessage]
  );

  return {
    // State
    conversations,
    activeConversationId,
    conversation,
    messages,
    isStreaming,
    streamingMessageId,
    isConfigValid,

    // Actions
    sendMessage,
    stopStreaming,
    startNewChat,
    createConversation,
    deleteConversation,
    setActiveConversation,
  };
}
