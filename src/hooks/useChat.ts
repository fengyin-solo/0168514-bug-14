import { useCallback } from 'react';
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
    streamingConversationId,
    getActiveConversation,
    createConversation,
    deleteConversation,
    setActiveConversation,
    addMessage,
    startStreaming,
    appendStreamContent,
    finishStreaming,
    cancelStreaming,
  } = useChatStore();

  const { config, isValid: isConfigValid } = useConfigStore();
  const { setConfigPanelVisible } = useUIStore();

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

      // 添加用户消息
      addMessage(activeConversationId, {
        role: 'user',
        content,
        status: 'complete',
      });

      // 准备 API 消息（失败/中断的消息不作为上下文发送）
      const apiMessages: APIMessage[] = [
        ...messages
          .filter((msg) => msg.status !== 'error')
          .map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        { role: 'user' as const, content },
      ];

      // 开始流式响应（占位消息创建即落盘，返回其稳定 id）
      const assistantMessageId = startStreaming(activeConversationId);

      try {
        const stream = sendMessageStream(apiMessages, {
          ...config,
          stream: true,
        });

        await streamHandler.start(stream, {
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
            // 超时等异常也保留已收到的部分内容
            cancelStreaming(activeConversationId, assistantMessageId);

            if (shouldShowConfigPanel(appError)) {
              setConfigPanelVisible(true);
            }
          },
        });
      } catch (error) {
        const appError = parseError(error);
        logError(appError, 'useChat.sendMessage');
        message.error(appError.message);
        cancelStreaming(activeConversationId, assistantMessageId);

        if (shouldShowConfigPanel(appError)) {
          setConfigPanelVisible(true);
        }
      }
    },
    [
      activeConversationId,
      isConfigValid,
      config,
      messages,
      addMessage,
      startStreaming,
      appendStreamContent,
      finishStreaming,
      cancelStreaming,
      setConfigPanelVisible,
    ]
  );

  /**
   * 停止流式响应
   */
  const stopStreaming = useCallback(() => {
    streamHandler.abort();
    const state = useChatStore.getState();
    if (state.streamingConversationId && state.streamingMessageId) {
      cancelStreaming(state.streamingConversationId, state.streamingMessageId);
    }
    message.info('已停止响应');
  }, [cancelStreaming]);

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
    streamingConversationId,
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
