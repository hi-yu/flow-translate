import type { Message, Reply } from './types';

class PageCachedError extends Error {}

function whilePageActive<T>(promise: Promise<T>): Promise<T> {
  if (typeof window === 'undefined') return promise;
  return new Promise((resolve, reject) => {
    const pagehide = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      window.removeEventListener('pagehide', pagehide);
      reject(new PageCachedError('页面已进入浏览器缓存。'));
    };
    window.addEventListener('pagehide', pagehide);
    promise.then(
      (value) => {
        window.removeEventListener('pagehide', pagehide);
        resolve(value);
      },
      (error: unknown) => {
        window.removeEventListener('pagehide', pagehide);
        reject(error);
      },
    );
  });
}

export function onPortDisconnect(port: chrome.runtime.Port, callback: () => void): void {
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    callback();
  });
}

export function keepTranslationAlive(): () => void {
  const port = chrome.runtime.connect({ name: 'flow-translation' });
  let connected = true;
  const timer = setInterval(() => {
    try {
      port.postMessage({ alive: true });
    } catch {
      connected = false;
      clearInterval(timer);
    }
  }, 15_000);
  onPortDisconnect(port, () => {
    connected = false;
    clearInterval(timer);
  });
  return () => {
    clearInterval(timer);
    if (!connected) return;
    connected = false;
    try {
      port.disconnect();
    } catch {
      // The extension may have been reloaded while the request was pending.
    }
  };
}

export async function send<T>(message: Message): Promise<T> {
  let reply: Reply<T>;
  try {
    reply = (await whilePageActive(chrome.runtime.sendMessage(message))) as Reply<T>;
  } catch (error) {
    if (error instanceof PageCachedError) throw error;
    throw new Error('扩展已更新或连接中断，请刷新页面后重试。');
  }
  if (!reply?.ok) throw new Error(reply?.error ?? '扩展未返回结果，请刷新页面。');
  return reply.data;
}
