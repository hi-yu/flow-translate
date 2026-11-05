import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  normalizePageDomain,
  pageDomain,
  pageDomainPattern,
  validateSettings,
} from '../../src/settings';

describe('Discord preferences', () => {
  it('migrates existing settings to bilingual messages and English outgoing drafts', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS);
    Reflect.deleteProperty(legacy, 'discordDisplayMode');
    Reflect.deleteProperty(legacy, 'outgoingTargetLanguage');
    Reflect.deleteProperty(legacy, 'pageAutoDomains');
    const migrated = validateSettings(legacy);
    expect(migrated.discordDisplayMode).toBe('bilingual');
    expect(migrated.outgoingTargetLanguage).toBe('en');
    expect(migrated.providers).toEqual(legacy.providers);
    expect(migrated.pageAutoDomains).toEqual([]);
  });
  it('keeps incoming and outgoing target languages independent', () => {
    const saved = validateSettings({
      ...DEFAULT_SETTINGS,
      discordDisplayMode: 'translation-only',
      outgoingTargetLanguage: 'ja',
    });
    expect(saved.targetLanguage).toBe('zh-CN');
    expect(saved.outgoingTargetLanguage).toBe('ja');
    expect(saved.discordDisplayMode).toBe('translation-only');
  });
  it('rejects unsupported display modes and outgoing targets', () => {
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, discordDisplayMode: 'other' as 'bilingual' }),
    ).toThrow('显示方式');
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, outgoingTargetLanguage: 'invalid' }),
    ).toThrow('目标语言');
  });
});

describe('remembered webpage domains', () => {
  it('normalizes and deduplicates domains without combining subdomains', () => {
    const settings = validateSettings({
      ...DEFAULT_SETTINGS,
      pageAutoDomains: ['EXAMPLE.org', 'example.org', 'docs.example.org', '例子.测试'],
    });
    expect(settings.pageAutoDomains).toEqual([
      'example.org',
      'docs.example.org',
      'xn--fsqu00a.xn--0zwm56d',
    ]);
    expect(pageDomainPattern('docs.example.org')).toBe('*://docs.example.org/*');
  });
  it('extracts exact HTTP and HTTPS hostnames independently of paths and ports', () => {
    expect(pageDomain('https://docs.example.org:8443/guide?q=1')).toBe('docs.example.org');
    expect(pageDomain('http://example.org/article')).toBe('example.org');
    expect(pageDomain('https://discord.com/channels/1/2')).toBeNull();
    expect(pageDomain('chrome://extensions/')).toBeNull();
    expect(pageDomain('file:///tmp/article.html')).toBeNull();
  });
  it('rejects wildcard permissions, URLs, credentials and unsupported domain lists', () => {
    for (const domain of [
      '*.example.org',
      '*',
      '%2a.example.org',
      'https://example.org',
      'example.org/path',
      'user@example.org',
      'example.org:443',
      'example.org?x=1',
      'bad domain',
      'discord.com',
    ]) {
      expect(() => normalizePageDomain(domain)).toThrow();
    }
    expect(() =>
      validateSettings({
        ...DEFAULT_SETTINGS,
        pageAutoDomains: 'example.org' as unknown as string[],
      }),
    ).toThrow('域名配置');
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, pageAutoDomains: Array(501).fill('example.org') }),
    ).toThrow('500');
  });
});
