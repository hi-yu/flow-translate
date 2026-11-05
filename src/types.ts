export type ProviderKind = 'openai' | 'deepl' | 'gemini';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Settings {
  version: 1;
  providers: Provider[];
  activeProviderId: string;
  targetLanguage: string;
  discordAutoChannels: string[];
  pageAutoDomains: string[];
  discordDisplayMode: 'bilingual' | 'translation-only';
  outgoingTargetLanguage: string;
}

export type PublicProvider = Omit<Provider, 'apiKey'>;
export interface PublicSettings extends Omit<Settings, 'providers'> {
  providers: PublicProvider[];
}

export interface TranslationInput {
  text: string;
  providerId?: string;
  targetLanguage?: string;
  source: 'page' | 'discord' | 'selection' | 'test' | 'draft';
  channel?: string;
  automatic?: boolean;
  bypassCache?: boolean;
  requestId?: string;
}

export interface TranslationResult {
  text: string;
  providerId: string;
  providerName: string;
  cached: boolean;
}

export interface DraftSnapshot {
  token: string;
  text: string;
  channel: string;
  canReplace: boolean;
}

export type Message =
  | { type: 'GET_PUBLIC_SETTINGS' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Settings }
  | { type: 'SET_ACTIVE_PROVIDER'; providerId: string }
  | { type: 'SET_OUTGOING_LANGUAGE'; language: string; channel?: string }
  | { type: 'SET_DISCORD_AUTO'; channel: string; enabled: boolean }
  | { type: 'SET_PAGE_AUTO'; domain: string; enabled: boolean }
  | { type: 'EDIT_PAGE_AUTO'; domain: string; nextDomain: string }
  | { type: 'TRANSLATE'; input: TranslationInput }
  | { type: 'TRANSLATION_PROGRESS'; requestId: string; text: string }
  | { type: 'TEST_PROVIDER'; providerId: string }
  | { type: 'LIST_PROVIDER_MODELS'; provider: Provider }
  | { type: 'CLEAR_CACHE' }
  | { type: 'GET_STATUS' }
  | { type: 'TRANSLATE_PAGE' }
  | { type: 'RESTORE_PAGE' }
  | { type: 'TRANSLATE_SELECTION'; text: string }
  | { type: 'READ_DRAFT' }
  | { type: 'APPLY_DRAFT'; token: string; text: string }
  | { type: 'SETTINGS_CHANGED'; settings: PublicSettings };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
