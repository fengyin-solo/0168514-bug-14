import OpenAI from 'openai';
import type { APIConfig, APIMessage } from '../types';

/**
 * 创建 OpenAI 客户端实例
 */
function createClient(config: APIConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    dangerouslyAllowBrowser: true, // 允许在浏览器中使用
  });
}

/**
 * 发送消息并获取流式响应
 * @param messages 消息数组
 * @param config API 配置
 * @returns 异步迭代器，产出响应内容片段
 */
export async function* sendMessageStream(
  messages: APIMessage[],
  config: APIConfig,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const client = createClient(config);

  const stream = await client.chat.completions.create(
    {
      model: config.model,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: true,
    },
    { signal }
  );
  
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }
}

/**
 * 发送消息并获取完整响应（非流式）
 * @param messages 消息数组
 * @param config API 配置
 * @returns 响应内容和使用统计
 */
export async function sendMessage(
  messages: APIMessage[],
  config: APIConfig
): Promise<{
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}> {
  const client = createClient(config);
  
  const response = await client.chat.completions.create({
    model: config.model,
    messages: messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    })),
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: false,
  });
  
  const content = response.choices[0]?.message?.content || '';
  const usage = response.usage
    ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;
  
  return { content, usage };
}

/**
 * 验证 API Key 是否有效
 * @param apiKey API 密钥
 * @param baseUrl API 基础 URL
 * @returns 是否有效
 */
export async function validateAPIKeyOnline(
  apiKey: string,
  baseUrl: string
): Promise<boolean> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      dangerouslyAllowBrowser: true,
    });
    
    // 发送一个简单的请求来验证 API Key
    await client.models.list();
    return true;
  } catch (error) {
    console.error('API Key validation failed:', error);
    return false;
  }
}

/**
 * 获取可用模型列表
 * @param apiKey API 密钥
 * @param baseUrl API 基础 URL
 * @returns 模型列表
 */
export async function fetchAvailableModels(
  apiKey: string,
  baseUrl: string
): Promise<string[]> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      dangerouslyAllowBrowser: true,
    });
    
    const response = await client.models.list();
    return response.data.map(model => model.id);
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return [];
  }
}
