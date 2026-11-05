import { describe, expect, it, vi } from 'vitest';
import { TranslationEngine } from '../../src/translation-engine';
import { DEFAULT_SETTINGS } from '../../src/settings';
import type { TranslationInput } from '../../src/types';

const provider = { ...DEFAULT_SETTINGS.providers[0]!, apiKey: 'not-a-real-key' };
const input = (text: string, automatic = false): TranslationInput => ({
  text,
  source: 'discord',
  automatic,
});

describe('translation scheduling', () => {
  it('deduplicates concurrent requests and caches per provider and language', async () => {
    const translate = vi.fn(async () => '你好');
    const engine = new TranslationEngine(translate);
    const [first, second] = await Promise.all([
      engine.request(input('Hello'), provider, 'zh-CN', '1'),
      engine.request(input('Hello'), provider, 'zh-CN', '1'),
    ]);
    expect(first.text).toBe(second.text);
    expect(translate).toHaveBeenCalledTimes(1);
    expect((await engine.request(input('Hello'), provider, 'zh-CN', '2')).cached).toBe(true);
    await engine.request(input('Hello'), { ...provider, id: 'other' }, 'zh-CN', '1');
    await engine.request(input('Hello'), provider, 'ja', '1');
    expect(translate).toHaveBeenCalledTimes(3);
  });
  it('never caches failed translations and allows forced retries', async () => {
    const translate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('你好');
    const engine = new TranslationEngine(translate);
    await expect(engine.request(input('Hello'), provider, 'zh-CN', '1')).rejects.toThrow('offline');
    await engine.request(input('Hello'), provider, 'zh-CN', '1');
    await engine.request({ ...input('Hello'), bypassCache: true }, provider, 'zh-CN', '1');
    expect(translate).toHaveBeenCalledTimes(3);
  });
  it('prioritizes manual work and cancels queued auto requests for a disabled channel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const engine = new TranslationEngine(async (_provider, text) => {
      order.push(text);
      if (text === 'first') await gate;
      return text;
    });
    const first = engine.request(input('first'), provider, 'zh-CN', '1:/channels/1/2');
    const automatic = engine
      .request(input('automatic', true), provider, 'zh-CN', '2:/channels/1/2')
      .catch((error) => error.message as string);
    const other = engine.request(
      input('other automatic', true),
      provider,
      'zh-CN',
      '2:/channels/1/3',
    );
    const manual = engine.request(input('manual'), provider, 'zh-CN', '3');
    engine.cancelAutomatic('/channels/1/2');
    release();
    expect(await automatic).toContain('关闭');
    await Promise.all([first, other, manual]);
    expect(order).toEqual(['first', 'manual', 'other automatic']);
  });
  it('does not refill cleared caches with requests started before a credential change', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const translate = vi.fn(async () => {
      await gate;
      return '你好';
    });
    const engine = new TranslationEngine(translate);
    const first = engine.request(input('Hello'), provider, 'zh-CN', '1');
    engine.clearCache();
    release();
    await first;
    await engine.request(input('Hello'), provider, 'zh-CN', '1');
    expect(translate).toHaveBeenCalledTimes(2);
  });
  it('shares partial output with concurrent subscribers before inference finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new TranslationEngine(async (_p, _text, _target, _signal, progress) => {
      progress?.('正在');
      await gate;
      progress?.('正在翻译');
      return '正在翻译';
    });
    const first = vi.fn(),
      second = vi.fn();
    const a = engine.request(input('Streaming'), provider, 'zh-CN', '1', first);
    const b = engine.request(input('Streaming'), provider, 'zh-CN', '1', second);
    expect(first).toHaveBeenCalledWith('正在');
    expect(second).toHaveBeenCalledWith('正在');
    release();
    await Promise.all([a, b]);
    expect(first).toHaveBeenLastCalledWith('正在翻译');
    expect(second).toHaveBeenLastCalledWith('正在翻译');
  });
  it('reuses completed translations when duplicates were queued by different tabs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const translate = vi.fn(async () => {
      await gate;
      return '你好';
    });
    const engine = new TranslationEngine(translate);
    const a = engine.request(input('Same source'), provider, 'zh-CN', '1');
    const b = engine.request(input('Same source'), provider, 'zh-CN', '2');
    release();
    await a;
    expect((await b).cached).toBe(true);
    expect(translate).toHaveBeenCalledTimes(1);
  });
  it('restores an in-memory session cache without storing provider credentials', async () => {
    const engine = new TranslationEngine(async () => '你好');
    engine.clearCache();
    await engine.request(input('Hello'), provider, 'zh-CN', '1');
    const snapshot = engine.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(provider.apiKey);
    const translate = vi.fn(async () => '新译文');
    const restored = new TranslationEngine(translate);
    restored.restore(snapshot);
    expect((await restored.request(input('Hello'), provider, 'zh-CN', '2')).cached).toBe(true);
    expect(translate).not.toHaveBeenCalled();
    restored.clearCache();
    expect((await restored.request(input('Hello'), provider, 'zh-CN', '2')).text).toBe('新译文');
  });
});
