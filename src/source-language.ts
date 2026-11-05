export interface SourceLanguage {
  code: string;
  reliable: boolean;
}

const cache = new Map<string, Promise<SourceLanguage>>();

function scriptHint(text: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/\p{Script=Latin}/u.test(text)) return 'en';
  if (/\p{Script=Han}/u.test(text) && !/\p{L}/u.test(text.replace(/\p{Script=Han}/gu, '')))
    return 'zh';
  return 'und';
}

export async function detectSourceLanguage(text: string): Promise<SourceLanguage> {
  const existing = cache.get(text);
  if (existing) return existing;
  const pending = (async () => {
    const hint = scriptHint(text);
    if (hint === 'ja' || hint === 'ko') return { code: hint, reliable: true };
    try {
      const detected = await chrome.i18n.detectLanguage(text);
      const first = detected.languages.find((language) => language.language !== 'und');
      if (detected.isReliable && first && first.percentage >= 60)
        return { code: first.language, reliable: true };
    } catch {
      /* Offline detection can be unavailable; providers still auto-detect the source. */
    }
    return { code: hint, reliable: hint === 'zh' };
  })();
  cache.set(text, pending);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return pending;
}

export function sourceLanguageLabel(source: SourceLanguage): string {
  if (source.code === 'und') return '未确定';
  return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(source.code) ?? '自动识别';
}
