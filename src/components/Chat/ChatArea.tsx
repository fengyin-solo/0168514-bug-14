import { useCallback } from 'react';
import { message } from 'antd';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';
import { useChatStore } from '../../stores/chatStore';
import { useConfigStore } from '../../stores/configStore';
import { sendMessageStream } from '../../services/api';
import { createStreamHandler, toMessageStats } from '../../services/stream';
import { parseError, logError, shouldShowConfigPanel } from '../../services/errorHandler';
import { useUIStore } from '../../stores/uiStore';
import type { APIMessage } from '../../types';
import './ChatArea.css';

// 创建流处理器实例
const streamHandler = createStreamHandler();

/**
 * 聊天区域主组件
 */
export function ChatArea() {
  const {
    activeConversationId,
    isStreaming,
    streamingMessageId,
    getActiveConversation,
    addMessage,
    startStreaming,
    appendStreamContent,
    finishStreaming,
    cancelStreaming,
    createConversation,
  } = useChatStore();

  const { config, isValid: isConfigValid } = useConfigStore();
  const { setConfigPanelVisible } = useUIStore();

  const conversation = getActiveConversation();
  const messages = conversation?.messages || [];

  const handleSend = useCallback(
    async (content: string) => {
      if (!isConfigValid) {
        message.warning('请先配置 API Key');
        setConfigPanelVisible(true);
        return;
      }

      // 如果没有活动对话，自动创建一个
      let conversationId = activeConversationId;
      if (!conversationId) {
        conversationId = createConversation();
      }

      // 获取当前对话的历史消息（在添加新消息之前）
      const stateBeforeAdd = useChatStore.getState();
      const currentConversation = stateBeforeAdd.conversations.find(c => c.id === conversationId);
      const historyMessages = currentConversation?.messages || [];

      // 添加用户消息
      addMessage(conversationId, {
        role: 'user',
        content,
        status: 'complete',
      });

      // 准备 API 消息（历史消息 + 当前消息；失败/中断的消息不作为上下文）
      const apiMessages: APIMessage[] = [
        ...historyMessages
          .filter((msg) => msg.status !== 'error')
          .map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        { role: 'user' as const, content },
      ];

      // 开始流式响应（占位消息创建即落盘，返回其稳定 id）
      const assistantMessageId = startStreaming(conversationId);

      try {
        const stream = sendMessageStream(apiMessages, {
          ...config,
          stream: true,
        });

        await streamHandler.start(stream, {
          onChunk: (chunk) => {
            // 按会话/消息 id 定位：流式期间切换对话也不会写错记录
            appendStreamContent(conversationId, assistantMessageId, chunk);
          },
          onComplete: (stats) => {
            finishStreaming(conversationId, assistantMessageId, toMessageStats(stats));
          },
          onError: (error) => {
            const appError = parseError(error);
            logError(appError, 'ChatArea.handleSend');
            message.error(appError.message);
            // 超时等异常也保留已收到的部分内容
            cancelStreaming(conversationId, assistantMessageId);

            if (shouldShowConfigPanel(appError)) {
              setConfigPanelVisible(true);
            }
          },
        });
      } catch (error) {
        const appError = parseError(error);
        logError(appError, 'ChatArea.handleSend');
        message.error(appError.message);
        cancelStreaming(conversationId, assistantMessageId);

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

  const handleStop = useCallback(() => {
    const { streamingConversationId, streamingMessageId } = useChatStore.getState();
    streamHandler.abort();
    if (streamingConversationId && streamingMessageId) {
      cancelStreaming(streamingConversationId, streamingMessageId);
    }
    message.info('已停止响应');
  }, [cancelStreaming]);

  return (
    <div className="chat-area">
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        streamingMessageId={streamingMessageId}
      />
      <InputArea
        onSend={handleSend}
        onStop={handleStop}
        isLoading={false}
        isStreaming={isStreaming}
        disabled={false}
      />
    </div>
  );
}
