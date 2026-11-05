import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSourceLanguage, sourceLanguageLabel } from '../../src/source-language';

afterEach(() => vi.unstubAllGlobals());

describe('offline source language detection', () => {
  it('uses local browser detection for other Latin languages', async () => {
    const detect = vi
      .fn()
      .mockResolvedValue({ isReliable: true, languages: [{ language: 'fr', percentage: 98 }] });
    vi.stubGlobal('chrome', { i18n: { detectLanguage: detect } });
    const source = await detectSourceLanguage(
      'Bonjour à tous, la prochaine version sera publiée vendredi.',
    );
    expect(source).toEqual({ code: 'fr', reliable: true });
    expect(sourceLanguageLabel(source)).toBe('法语');
  });
  it('recognizes Japanese and Korean without a network or detector call', async () => {
    vi.stubGlobal('chrome', { i18n: { detectLanguage: vi.fn() } });
    expect((await detectSourceLanguage('こんにちは、世界')).code).toBe('ja');
    expect((await detectSourceLanguage('안녕하세요, 세계')).code).toBe('ko');
    expect(chrome.i18n.detectLanguage).not.toHaveBeenCalled();
  });
  it('prefers English for uncertain Latin text and leaves unknown scripts automatic', async () => {
    vi.stubGlobal('chrome', {
      i18n: { detectLanguage: vi.fn().mockRejectedValue(new Error('unavailable')) },
    });
    expect(await detectSourceLanguage('Hi there')).toEqual({ code: 'en', reliable: false });
    expect(await detectSourceLanguage('Привет')).toEqual({ code: 'und', reliable: false });
    expect(sourceLanguageLabel({ code: 'en', reliable: false })).toBe('英语');
    expect(sourceLanguageLabel({ code: 'ja', reliable: true })).toBe('日语');
    expect(sourceLanguageLabel({ code: 'und', reliable: false })).toBe('未确定');
  });
});
