import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepTranslationAlive, onPortDisconnect, send } from '../../src/messaging';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mockRuntime() {
  let disconnected: (() => void) | undefined;
  const readError = vi.fn(() => ({ message: 'The message channel is closed.' }));
  const port = {
    onDisconnect: { addListener: vi.fn((listener: () => void) => (disconnected = listener)) },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
  const connect = vi.fn(() => port);
  vi.stubGlobal('chrome', {
    runtime: {
      connect,
      get lastError() {
        return readError();
      },
    },
  });
  return { port, connect, readError, disconnect: () => disconnected?.() };
}

describe('translation ports', () => {
  it('consumes disconnect errors and stops heartbeats when a cached page loses its port', () => {
    vi.useFakeTimers();
    const runtime = mockRuntime();
    const stop = keepTranslationAlive();
    expect(runtime.connect).toHaveBeenCalledWith({ name: 'flow-translation' });
    vi.advanceTimersByTime(15_000);
    expect(runtime.port.postMessage).toHaveBeenCalledTimes(1);

    runtime.disconnect();
    vi.advanceTimersByTime(30_000);
    stop();
    expect(runtime.readError).toHaveBeenCalledTimes(1);
    expect(runtime.port.postMessage).toHaveBeenCalledTimes(1);
    expect(runtime.port.disconnect).not.toHaveBeenCalled();
  });

  it('closes a live port once and consumes errors on the receiving side', () => {
    vi.useFakeTimers();
    const runtime = mockRuntime();
    const stop = keepTranslationAlive();
    stop();
    stop();
    expect(runtime.port.disconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(runtime.port.postMessage).not.toHaveBeenCalled();

    const callback = vi.fn();
    onPortDisconnect(runtime.port as unknown as chrome.runtime.Port, callback);
    runtime.disconnect();
    expect(runtime.readError).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('stops heartbeats when posting to a disconnected port throws', () => {
    vi.useFakeTimers();
    const runtime = mockRuntime();
    runtime.port.postMessage.mockImplementation(() => {
      throw new Error('Port is disconnected');
    });
    const stop = keepTranslationAlive();
    vi.advanceTimersByTime(60_000);
    stop();
    expect(runtime.port.postMessage).toHaveBeenCalledTimes(1);
    expect(runtime.port.disconnect).not.toHaveBeenCalled();
  });

  it('cancels pending requests when a page is cached and permits new requests after restoration', async () => {
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, data: 'restored' });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const pending = send({ type: 'GET_PUBLIC_SETTINGS' });
    const pagehide = new Event('pagehide');
    Object.defineProperty(pagehide, 'persisted', { value: true });
    window.dispatchEvent(pagehide);
    await expect(pending).rejects.toThrow('页面已进入浏览器缓存');
    const pageshow = new Event('pageshow');
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    await expect(send({ type: 'GET_PUBLIC_SETTINGS' })).resolves.toBe('restored');
  });
});
