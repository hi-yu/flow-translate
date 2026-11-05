import type { Provider, PublicSettings, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  activeProviderId: 'local-ollama',
  targetLanguage: 'zh-CN',
  discordAutoChannels: [],
  pageAutoDomains: [],
  discordDisplayMode: 'bilingual',
  outgoingTargetLanguage: 'en',
  providers: [
    {
      id: 'local-ollama',
      name: '本地 Ollama',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'hy-mt2-7b:q6_k',
      apiKey: '',
    },
  ],
};

export const LANGUAGES = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
] as const;

export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validateProvider(
  provider: Provider,
  { requireModel = true }: { requireModel?: boolean } = {},
): Provider {
  if (!provider || !/^[a-zA-Z0-9_-]{1,80}$/.test(provider.id)) throw new Error('接口 ID 无效。');
  if (!provider.name?.trim() || provider.name.length > 80)
    throw new Error('请填写接口名称（最多 80 字）。');
  if (!['openai', 'deepl', 'gemini'].includes(provider.kind)) throw new Error('不支持的接口类型。');
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new Error('请填写完整的 API 根地址。');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('API 地址不能包含账号、密码、查询参数或锚点。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('远程接口必须使用 HTTPS；仅本机接口允许 HTTP。');
  }
  if (
    typeof provider.model !== 'string' ||
    (requireModel && provider.kind !== 'deepl' && !provider.model.trim())
  )
    throw new Error('请填写模型名称。');
  if (
    typeof provider.apiKey !== 'string' ||
    provider.apiKey.length > 4096 ||
    /[\r\n]/.test(provider.apiKey)
  )
    throw new Error('API Key 格式无效。');
  return {
    ...provider,
    name: provider.name.trim(),
    baseUrl: url.href.replace(/\/$/, ''),
    model: provider.model.trim(),
    apiKey: provider.apiKey.trim(),
  };
}

export function validateSettings(value: Settings): Settings {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.providers) ||
    !value.providers.length ||
    value.providers.length > 20
  )
    throw new Error('请保留 1 至 20 个翻译接口。');
  const providers = value.providers.map((provider) => validateProvider(provider));
  if (new Set(providers.map((p) => p.id)).size !== providers.length)
    throw new Error('接口 ID 不能重复。');
  if (!providers.some((p) => p.id === value.activeProviderId))
    throw new Error('请选择有效的默认接口。');
  if (!LANGUAGES.some(([code]) => code === value.targetLanguage)) throw new Error('目标语言无效。');
  const discordDisplayMode = value.discordDisplayMode ?? 'bilingual';
  const outgoingTargetLanguage = value.outgoingTargetLanguage ?? 'en';
  if (!['bilingual', 'translation-only'].includes(discordDisplayMode))
    throw new Error('Discord 显示方式无效。');
  if (!LANGUAGES.some(([code]) => code === outgoingTargetLanguage))
    throw new Error('发送前翻译的目标语言无效。');
  if (
    !Array.isArray(value.discordAutoChannels) ||
    value.discordAutoChannels.length > 500 ||
    value.discordAutoChannels.some((c) => !/^\/channels\/(?:@me|\d+)\/\d+$/.test(c))
  )
    throw new Error('Discord 频道配置无效。');
  const pageAutoDomains = value.pageAutoDomains ?? [];
  if (!Array.isArray(pageAutoDomains) || pageAutoDomains.length > 500)
    throw new Error('自动翻译域名配置无效（最多 500 个）。');
  return {
    version: 1,
    providers,
    activeProviderId: value.activeProviderId,
    targetLanguage: value.targetLanguage,
    discordAutoChannels: [...new Set(value.discordAutoChannels)],
    pageAutoDomains: [...new Set(pageAutoDomains.map(normalizePageDomain))],
    discordDisplayMode,
    outgoingTargetLanguage,
  };
}

export function publicSettings(settings: Settings): PublicSettings {
  return {
    ...settings,
    providers: settings.providers.map(({ apiKey: _key, ...provider }) => provider),
  };
}

export function providerOrigin(provider: Pick<Provider, 'baseUrl'>): string {
  return new URL(provider.baseUrl).origin + '/*';
}

export function isDiscordHost(host: string): boolean {
  return ['discord.com', 'ptb.discord.com', 'canary.discord.com'].includes(host);
}

export function discordChannel(path: string): string | null {
  return path.match(/^\/channels\/(?:@me|\d+)\/\d+/)?.[0] ?? null;
}

export function normalizePageDomain(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\s*:/@?#\\]/u.test(value))
    throw new Error('自动翻译域名无效。');
  let domain: string;
  try {
    domain = new URL('https://' + value).hostname;
  } catch {
    throw new Error('自动翻译域名无效。');
  }
  if (!domain || /[*:]/u.test(domain)) throw new Error('自动翻译域名无效。');
  if (isDiscordHost(domain)) throw new Error('Discord 请使用频道自动翻译开关。');
  return domain;
}

export function pageDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol)
      ? normalizePageDomain(parsed.hostname)
      : null;
  } catch {
    return null;
  }
}

export function pageDomainPattern(domain: string): string {
  return `*://${normalizePageDomain(domain)}/*`;
}

export function languageName(code: string): string {
  return LANGUAGES.find(([id]) => id === code)?.[1] ?? code;
}

export async function readSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings');
  return result.settings
    ? validateSettings(result.settings as Settings)
    : structuredClone(DEFAULT_SETTINGS);
}
