import type { AppConfig, Conversation, Message, PromptTemplate } from '../types';
import { DEFAULT_CONFIG, DEFAULT_TEMPLATES } from '../types';

// Storage keys
const STORAGE_KEYS = {
  CONFIG: 'react-chat-config',
  CONVERSATIONS: 'react-chat-conversations',
  PROMPT_TEMPLATES: 'react-chat-prompt-templates',
} as const;

/**
 * 简单的加密函数（Base64 + 字符偏移）
 * 注意：这不是真正的加密，只是简单的混淆，防止明文存储
 */
function encrypt(text: string): string {
  if (!text) return '';
  
  // 先进行字符偏移
  const shifted = text
    .split('')
    .map(char => String.fromCharCode(char.charCodeAt(0) + 3))
    .join('');
  
  // 然后 Base64 编码
  return btoa(encodeURIComponent(shifted));
}

/**
 * 解密函数
 */
function decrypt(encoded: string): string {
  if (!encoded) return '';
  
  try {
    // 先 Base64 解码
    const shifted = decodeURIComponent(atob(encoded));
    
    // 然后字符偏移还原
    return shifted
      .split('')
      .map(char => String.fromCharCode(char.charCodeAt(0) - 3))
      .join('');
  } catch {
    return '';
  }
}

/**
 * 保存配置到 localStorage
 * @param config 应用配置
 */
export function saveConfig(config: AppConfig): void {
  try {
    // 加密 API Key
    const configToSave = {
      ...config,
      apiKey: encrypt(config.apiKey),
    };
    
    localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(configToSave));
  } catch (error) {
    console.error('Failed to save config:', error);
    throw new Error('保存配置失败');
  }
}

/**
 * 从 localStorage 加载配置
 * @returns 应用配置，如果不存在则返回默认配置
 */
export function loadConfig(): AppConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CONFIG);
    
    if (!stored) {
      return DEFAULT_CONFIG;
    }
    
    const parsed = JSON.parse(stored) as AppConfig;
    
    // 解密 API Key
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      apiKey: decrypt(parsed.apiKey),
    };
  } catch (error) {
    console.error('Failed to load config:', error);
    return DEFAULT_CONFIG;
  }
}

/**
 * 清除配置
 */
export function clearConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.CONFIG);
  } catch (error) {
    console.error('Failed to clear config:', error);
  }
}

/**
 * 归一化单条消息
 * 页面在流式响应过程中被关闭/刷新后，重新加载时该消息仍停留在
 * streaming/pending 状态，但当前页面已经没有活动的流连接，不可能再继续。
 * 将其标记为 error，保留已接收到的部分内容，避免出现“永远在转圈”
 * 或重复生成同一条回复的情况。时间戳与位置保持不变。
 */
function normalizeMessage(message: Message): Message {
  if (message.status === 'streaming' || message.status === 'pending') {
    return {
      ...message,
      content: message.content || '（响应未完成）',
      status: 'error' as const,
    };
  }
  return message;
}

/**
 * 归一化对话：清理无效消息、修复中断的流式消息
 */
function normalizeConversation(conv: Conversation): Conversation {
  const messages = (conv.messages || [])
    .filter((msg) => msg && msg.id && msg.role)
    .map(normalizeMessage);

  return {
    ...conv,
    messages,
    createdAt: conv.createdAt ?? conv.updatedAt ?? Date.now(),
    updatedAt: conv.updatedAt ?? conv.createdAt ?? Date.now(),
  };
}

/**
 * 保存对话列表到 localStorage
 * @param conversations 对话列表
 */
export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(conversations));
  } catch (error) {
    console.error('Failed to save conversations:', error);
    
    // 如果存储失败（可能是超出配额），尝试只保存最近的对话
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      const recentConversations = conversations.slice(0, 10);
      try {
        localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(recentConversations));
      } catch {
        throw new Error('存储空间不足，无法保存对话');
      }
    } else {
      throw new Error('保存对话失败');
    }
  }
}

/**
 * 从 localStorage 加载对话列表
 * @returns 对话列表
 */
export function loadConversations(): Conversation[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS);
    
    if (!stored) {
      return [];
    }
    
    const parsed = JSON.parse(stored) as Conversation[];
    
    // 验证数据结构
    if (!Array.isArray(parsed)) {
      return [];
    }
    
    // 验证数据结构、修复中断的流式消息，并按更新时间排序
    return parsed
      .filter(conv => conv && conv.id && Array.isArray(conv.messages))
      .map(normalizeConversation)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    console.error('Failed to load conversations:', error);
    return [];
  }
}

/**
 * 合并消息状态：绝不改写时间戳。
 * - complete 是终态，优先级最高（完成的回复不会被流式半截覆盖）；
 * - streaming 与 error 之间以已接收内容更长者为准（跨窗口 flush 时序）；
 * - 内容等长时 error 视为更稳定的状态。
 */
function mergeMessage(local: Message, remote: Message): Message {
  const pick = (winner: Message): Message => ({
    ...winner,
    // 时间戳是消息创建时刻，任何合并都不得改动
    timestamp: local.timestamp,
  });

  if (local.status === 'complete') return local;
  if (remote.status === 'complete') return pick(remote);

  if (local.status === remote.status) {
    const preferRemote =
      remote.content.length > local.content.length ||
      (!local.stats && !!remote.stats);
    return pick(preferRemote ? remote : local);
  }

  const isErrorLocal = local.status === 'error';
  const isErrorRemote = remote.status === 'error';

  if (isErrorLocal !== isErrorRemote) {
    const errorMsg = isErrorLocal ? local : remote;
    const streamingMsg = isErrorLocal ? remote : local;
    // 流式内容比中断提示更长时，保留更完整的那份
    return pick(streamingMsg.content.length > errorMsg.content.length ? streamingMsg : errorMsg);
  }

  return pick(remote.content.length > local.content.length ? remote : local);
}

/**
 * 合并两个对话快照（用于多窗口 storage 事件同步）
 *
 * 合并原则：
 * - 以消息 id 为唯一身份做去重，保证同一条回复不会出现两份；
 * - 保持消息的既有顺序与时间戳，新消息按时间戳追加到末尾；
 * - 任一方已有的消息都不会被丢弃（union 合并）。
 */
function mergeConversation(local: Conversation, remote: Conversation): Conversation {
  const merged = new Map<string, Message>();

  for (const msg of local.messages) {
    merged.set(msg.id, msg);
  }
  for (const msg of remote.messages) {
    const existing = merged.get(msg.id);
    merged.set(msg.id, existing ? mergeMessage(existing, msg) : msg);
  }

  const messages = Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);

  return {
    ...local,
    ...remote,
    title: remote.title || local.title,
    messages,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/**
 * 校验单个对话结构（不改动消息状态）
 * storage 事件对端传来的 streaming 消息可能确实仍在生成中，
 * 归一化为 error 只能发生在“本窗口启动加载”时，不能发生在同步路径上。
 */
function sanitizeConversation(conv: Conversation): Conversation | null {
  if (!conv || !conv.id || !Array.isArray(conv.messages)) {
    return null;
  }

  const messages = conv.messages.filter((msg) => msg && msg.id && msg.role);

  return {
    ...conv,
    messages,
    createdAt: conv.createdAt ?? conv.updatedAt ?? Date.now(),
    updatedAt: conv.updatedAt ?? conv.createdAt ?? Date.now(),
  };
}

/**
 * 将另一份对话快照合并进当前快照（跨窗口同步入口）
 *
 * 每次保存写入的都是全量快照，因此以 incoming 的会话集合为准：
 * - incoming 中缺失的会话视为已在其它窗口被删除，不做“复活”；
 * - 同 id 会话内按消息 id 去重合并，保证同一条回复不会出现两份；
 * - 保持消息既有顺序与时间戳，任一方已有的消息都不会被丢弃。
 *
 * @param local 当前窗口内存中的对话
 * @param incoming storage 事件带来的最新对话
 * @returns 合并后的对话列表（保持按 updatedAt 降序）
 */
export function mergeConversations(
  local: Conversation[],
  incoming: Conversation[]
): Conversation[] {
  return incoming
    .map((raw) => {
      const remote = sanitizeConversation(raw);
      if (!remote) return null;
      const existing = local.find((conv) => conv.id === remote.id);
      return existing ? mergeConversation(existing, remote) : remote;
    })
    .filter((conv): conv is Conversation => conv !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 清除所有对话
 */
export function clearConversations(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.CONVERSATIONS);
  } catch (error) {
    console.error('Failed to clear conversations:', error);
  }
}

/**
 * 清除所有存储数据
 */
export function clearAllStorage(): void {
  clearConfig();
  clearConversations();
}

/**
 * 获取存储使用情况
 * @returns 存储使用信息
 */
export function getStorageUsage(): { used: number; available: number } {
  let used = 0;
  
  try {
    for (const key of Object.values(STORAGE_KEYS)) {
      const item = localStorage.getItem(key);
      if (item) {
        used += item.length * 2; // UTF-16 编码，每个字符 2 字节
      }
    }
  } catch {
    // 忽略错误
  }
  
  // localStorage 通常限制为 5MB
  const available = 5 * 1024 * 1024 - used;
  
  return { used, available: Math.max(0, available) };
}

/**
 * 导出所有数据
 * @returns 导出的数据对象
 */
export function exportData(): { config: AppConfig; conversations: Conversation[] } {
  return {
    config: loadConfig(),
    conversations: loadConversations(),
  };
}

/**
 * 导入数据
 * @param data 要导入的数据
 */
export function importData(data: { config?: AppConfig; conversations?: Conversation[] }): void {
  if (data.config) {
    saveConfig(data.config);
  }
  
  if (data.conversations) {
    saveConversations(data.conversations);
  }
}

/**
 * 生成默认提示词模板
 * @returns 默认模板列表
 */
function generateDefaultTemplates(): PromptTemplate[] {
  const now = Date.now();
  return DEFAULT_TEMPLATES.map((template, index) => ({
    ...template,
    id: `default-${index}`,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * 保存提示词模板到 localStorage
 * @param templates 模板列表
 */
export function savePromptTemplates(templates: PromptTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.PROMPT_TEMPLATES, JSON.stringify(templates));
  } catch (error) {
    console.error('Failed to save prompt templates:', error);
    throw new Error('保存提示词模板失败');
  }
}

/**
 * 从 localStorage 加载提示词模板
 * @returns 模板列表，如果不存在则返回默认模板
 */
export function loadPromptTemplates(): PromptTemplate[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.PROMPT_TEMPLATES);
    
    if (!stored) {
      const defaultTemplates = generateDefaultTemplates();
      savePromptTemplates(defaultTemplates);
      return defaultTemplates;
    }
    
    const parsed = JSON.parse(stored) as PromptTemplate[];
    
    if (!Array.isArray(parsed)) {
      const defaultTemplates = generateDefaultTemplates();
      savePromptTemplates(defaultTemplates);
      return defaultTemplates;
    }
    
    return parsed
      .filter(t => t && t.id && t.name && t.content)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    console.error('Failed to load prompt templates:', error);
    return generateDefaultTemplates();
  }
}

/**
 * 清除所有提示词模板
 */
export function clearPromptTemplates(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.PROMPT_TEMPLATES);
  } catch (error) {
    console.error('Failed to clear prompt templates:', error);
  }
}

/**
 * 重置为默认提示词模板
 * @returns 重置后的模板列表
 */
export function resetPromptTemplates(): PromptTemplate[] {
  const defaultTemplates = generateDefaultTemplates();
  savePromptTemplates(defaultTemplates);
  return defaultTemplates;
}
