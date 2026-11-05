import type { Message, Reply } from './types';

export async function send<T>(message: Message): Promise<T> {
  let reply: Reply<T>;
  try {
    reply = (await chrome.runtime.sendMessage(message)) as Reply<T>;
  } catch {
    throw new Error('扩展已更新或连接中断，请刷新页面后重试。');
  }
  if (!reply?.ok) throw new Error(reply?.error ?? '扩展未返回结果，请刷新页面。');
  return reply.data;
}
