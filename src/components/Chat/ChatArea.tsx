import { useCallback, useRef } from 'react';
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
    beginExchange,
    appendStreamContent,
    finishStreaming,
    failStreaming,
    cancelStreaming,
    createConversation,
  } = useChatStore();

  const { config, isValid: isConfigValid } = useConfigStore();
  const { setConfigPanelVisible } = useUIStore();

  // 当前流的中止控制器（组件实例级，停止按钮与卸载时使用）
  const abortControllerRef = useRef<AbortController | null>(null);

  const conversation = getActiveConversation();
  const messages = conversation?.messages || [];
  // 仅当查看的就是正在生成回复的对话时才展示流式状态
  const isViewingStreaming =
    isStreaming && conversation?.id === useChatStore.getState().streamingConversationId;
  const viewStreamingMessageId = isViewingStreaming ? streamingMessageId : null;

  const handleSend = useCallback(
    async (content: string) => {
      if (!isConfigValid) {
        message.warning('请先配置 API Key');
        setConfigPanelVisible(true);
        return;
      }

      // 上一条还在生成时不允许发下一条，避免占位消息互相顶掉
      if (useChatStore.getState().isStreaming) {
        return;
      }

      // 如果没有活动对话，自动创建一个
      let conversationId = activeConversationId;
      if (!conversationId) {
        conversationId = createConversation();
      }

      // 获取当前对话的历史消息（在写入本轮消息之前）
      const currentConversation = useChatStore
        .getState()
        .conversations.find(c => c.id === conversationId);
      const historyMessages = currentConversation?.messages || [];

      // 原子写入：用户消息 + 助手占位消息，同一次提交立即落盘
      const { assistantMessageId } = beginExchange(conversationId, {
        role: 'user',
        content,
        status: 'complete',
      });

      // 准备 API 消息（历史消息 + 当前消息）
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
              // 按对话 id + 消息 id 精确写入；即使中途切换活动对话也不会写错位置
              appendStreamContent(conversationId, assistantMessageId, chunk);
            },
            onComplete: (stats) => {
              finishStreaming(conversationId, assistantMessageId, toMessageStats(stats));
            },
            onError: (error) => {
              // 超时/网络错误：保留已接收的部分正文并立即落盘
              const appError = parseError(error);
              logError(appError, 'ChatArea.handleSend');
              message.error(appError.message);
              failStreaming(conversationId, assistantMessageId);

              if (shouldShowConfigPanel(appError)) {
                setConfigPanelVisible(true);
              }
            },
            onAbort: () => {
              // 用户主动停止：已接收正文原样保留
              cancelStreaming(conversationId, assistantMessageId);
            },
          },
          abortController.signal
        );
      } catch (error) {
        const appError = parseError(error);
        logError(appError, 'ChatArea.handleSend');
        message.error(appError.message);
        failStreaming(conversationId, assistantMessageId);

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
      createConversation,
      setConfigPanelVisible,
    ]
  );

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
    streamHandler.abort();
    message.info('已停止响应');
  }, []);

  return (
    <div className="chat-area">
      <MessageList
        messages={messages}
        isStreaming={isViewingStreaming}
        streamingMessageId={viewStreamingMessageId}
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
