import type { MessageStats } from '../types';

/**
 * 响应统计信息
 */
export interface ResponseStats {
  /** 响应时间（毫秒） */
  responseTime: number;
  /** 估算的 Token 数量 */
  tokenCount: number;
  /** 首字节时间（毫秒） */
  firstByteTime?: number;
}

/**
 * 流处理器回调
 */
export interface StreamCallbacks {
  /** 收到内容片段时调用 */
  onChunk: (chunk: string) => void;
  /** 流完成时调用 */
  onComplete: (stats: ResponseStats) => void;
  /** 发生错误时调用（超时/网络错误等，不含主动中止） */
  onError: (error: Error) => void;
  /** 流被主动中止时调用（已接收的内容由调用方决定如何落盘） */
  onAbort?: () => void;
}

/**
 * 流处理器类
 * 管理流式响应的生命周期
 */
export class StreamHandler {
  private abortController: AbortController | null = null;
  private externalSignal: AbortSignal | null = null;
  private isActive = false;
  private startTime = 0;
  private firstByteTime: number | null = null;
  private accumulatedContent = '';

  private get aborted(): boolean {
    return this.abortController?.signal.aborted === true
      || this.externalSignal?.aborted === true;
  }

  /**
   * 开始处理流
   * @param stream 异步迭代器
   * @param callbacks 回调函数
   * @param signal 外部中止信号（可选，与内部 abort 共享生命周期）
   */
  async start(
    stream: AsyncGenerator<string, void, unknown>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.isActive) {
      this.abort();
    }

    this.abortController = new AbortController();
    this.externalSignal = signal ?? null;
    this.isActive = true;
    this.startTime = Date.now();
    this.firstByteTime = null;
    this.accumulatedContent = '';

    if (signal?.aborted) {
      this.isActive = false;
      this.abortController = null;
      callbacks.onAbort?.();
      return;
    }
    signal?.addEventListener('abort', () => this.abortController?.abort(), { once: true });

    try {
      for await (const chunk of stream) {
        // 检查是否已中止
        if (this.aborted) {
          break;
        }

        // 记录首字节时间
        if (this.firstByteTime === null) {
          this.firstByteTime = Date.now() - this.startTime;
        }

        this.accumulatedContent += chunk;
        callbacks.onChunk(chunk);
      }

      if (this.aborted) {
        callbacks.onAbort?.();
      } else {
        // 流正常完成
        const stats = this.calculateStats();
        callbacks.onComplete(stats);
      }
    } catch (error) {
      if (this.aborted) {
        callbacks.onAbort?.();
      } else {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.isActive = false;
      this.abortController = null;
      this.externalSignal = null;
    }
  }

  /**
   * 中止当前流
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.isActive = false;
    }
  }

  /**
   * 检查流是否正在处理
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * 获取已累积的内容
   */
  getAccumulatedContent(): string {
    return this.accumulatedContent;
  }

  /**
   * 计算响应统计信息
   */
  private calculateStats(): ResponseStats {
    const responseTime = Date.now() - this.startTime;
    const tokenCount = this.estimateTokens(this.accumulatedContent);

    return {
      responseTime,
      tokenCount,
      firstByteTime: this.firstByteTime ?? undefined,
    };
  }

  /**
   * 估算 Token 数量
   * 简化的估算方法
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;

    // 中文字符约 2 token
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    // 英文单词约 1 token
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    // 数字
    const numbers = (text.match(/\d+/g) || []).length;
    // 标点符号
    const punctuation = (text.match(/[^\w\s\u4e00-\u9fff]/g) || []).length;

    return chineseChars * 2 + englishWords + numbers + punctuation;
  }
}

/**
 * 创建流处理器实例
 */
export function createStreamHandler(): StreamHandler {
  return new StreamHandler();
}

/**
 * 将 ResponseStats 转换为 MessageStats
 */
export function toMessageStats(stats: ResponseStats): MessageStats {
  return {
    responseTime: stats.responseTime,
    tokenCount: stats.tokenCount,
  };
}
