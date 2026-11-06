import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  discordChannel,
  normalizePageDomain,
  pageDomain,
  pageDomainPattern,
  providerOrigin,
  publicSettings,
  readSettings,
  validateSettings,
  validateProvider,
} from './settings';
import { listProviderModels } from './providers';
import { TranslationEngine, type CacheSnapshot } from './translation-engine';
import { discordSenderChannel } from './discord-context';
import { authorizedPageDomains, registerPageDomains } from './page-auto';
import { onPortDisconnect } from './messaging';
import type { Message, PublicSettings, Settings, TranslationInput } from './types';

let cacheWrites = Promise.resolve();
const engine = new TranslationEngine(undefined, () => {
  cacheWrites = cacheWrites
    .then(() => chrome.storage.session.set({ translationCache: engine.snapshot() }))
    .catch(() => {});
});
// Content scripts receive only explicitly redacted settings through messaging.
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]).then(async () => {
  const saved = await chrome.storage.session.get('translationCache');
  engine.restore(saved.translationCache as CacheSnapshot | undefined);
});
let settingsWrite = Promise.resolve();

function isExtensionUI(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')))
  );
}

function requireUI(sender: chrome.runtime.MessageSender): void {
  if (!isExtensionUI(sender)) throw new Error('此操作仅限扩展设置页面。');
}

async function broadcast(settings: Settings): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled([
    chrome.runtime.sendMessage({
      type: 'SETTINGS_CHANGED',
      settings: publicSettings(settings),
    } satisfies Message),
    ...tabs
      .filter((tab) => tab.id != null)
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id!, {
          type: 'SETTINGS_CHANGED',
          settings: publicSettings(settings),
        } satisfies Message),
      ),
  ]);
}

async function updateSettings(update: (settings: Settings) => Settings): Promise<PublicSettings> {
  let saved!: Settings;
  const task = settingsWrite.then(async () => {
    const previous = await readSettings();
    saved = validateSettings(update(previous));
    const domainsChanged =
      JSON.stringify(previous.pageAutoDomains) !== JSON.stringify(saved.pageAutoDomains);
    if (domainsChanged) {
      const authorized = await authorizedPageDomains(saved.pageAutoDomains);
      if (authorized.length !== saved.pageAutoDomains.length)
        throw new Error('尚未授权此域名，请在扩展弹窗或设置中授予访问权限。');
      await registerPageDomains(saved.pageAutoDomains);
    }
    await chrome.storage.local.set({ settings: saved });
    for (const domain of previous.pageAutoDomains)
      if (!saved.pageAutoDomains.includes(domain)) engine.cancelAutomatic('page:' + domain);
    if (JSON.stringify(previous.providers) !== JSON.stringify(saved.providers)) {
      engine.clearCache();
      await cacheWrites;
    }
    const added = saved.pageAutoDomains.filter(
      (domain) => !previous.pageAutoDomains.includes(domain),
    );
    if (added.length) {
      const tabs = await chrome.tabs.query({ url: added.map(pageDomainPattern) });
      await Promise.allSettled(
        tabs
          .filter((tab) => tab.id != null && added.includes(pageDomain(tab.url ?? '') ?? ''))
          .map((tab) => inject(tab.id!)),
      );
    }
    await broadcast(saved);
  });
  settingsWrite = task.catch(() => {});
  await task;
  return publicSettings(saved);
}

function validateInput(input: TranslationInput): void {
  if (
    !input ||
    typeof input.text !== 'string' ||
    !['page', 'discord', 'selection', 'test', 'draft'].includes(input.source)
  )
    throw new Error('翻译请求无效。');
  if (input.targetLanguage && !LANGUAGES.some(([code]) => code === input.targetLanguage))
    throw new Error('目标语言无效。');
  if (input.requestId && !/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId))
    throw new Error('请求 ID 无效。');
}

async function translate(input: TranslationInput, sender: chrome.runtime.MessageSender) {
  validateInput(input);
  if (
    input.source === 'draft' &&
    (input.automatic ||
      (!isExtensionUI(sender) &&
        (!input.channel || (await discordSenderChannel(sender)) !== input.channel)))
  )
    throw new Error('此操作仅限扩展弹窗或当前 Discord 频道。');
  const settings = await readSettings();
  const provider = settings.providers.find(
    (p) => p.id === (input.providerId ?? settings.activeProviderId),
  );
  if (!provider) throw new Error('翻译接口不存在，请重新选择。');
  if (!(await chrome.permissions.contains({ origins: [providerOrigin(provider)] })))
    throw new Error('尚未授权此接口地址，请到设置中保存并授权。');
  let automaticDomain: string | null = null;
  if (input.automatic && input.source === 'page') {
    automaticDomain = pageDomain(sender.url ?? '');
    if (
      sender.tab?.id == null ||
      sender.frameId !== 0 ||
      !automaticDomain ||
      !settings.pageAutoDomains.includes(automaticDomain) ||
      !(await chrome.permissions.contains({ origins: [pageDomainPattern(automaticDomain)] }))
    )
      throw new Error('当前域名未开启自动翻译。');
  } else if (input.automatic) {
    if (
      input.source !== 'discord' ||
      (await discordSenderChannel(sender)) !== input.channel ||
      !settings.discordAutoChannels.includes(input.channel ?? '')
    )
      throw new Error('当前频道未开启自动翻译。');
  }
  const owner = `${sender.tab?.id ?? 'ui'}:${automaticDomain ? 'page:' + automaticDomain : (input.channel ?? 'page')}`;
  const onProgress =
    input.requestId && sender.tab?.id != null
      ? (text: string) => {
          void chrome.tabs
            .sendMessage(
              sender.tab!.id!,
              {
                type: 'TRANSLATION_PROGRESS',
                requestId: input.requestId!,
                text,
              } satisfies Message,
              { frameId: sender.frameId ?? 0 },
            )
            .catch(() => {});
        }
      : undefined;
  return engine.request(
    input,
    provider,
    input.targetLanguage ?? settings.targetLanguage,
    owner,
    onProgress,
  );
}

async function handle(message: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await storageReady;
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string')
    throw new Error('无效的扩展请求。');
  switch (message.type) {
    case 'GET_PUBLIC_SETTINGS':
      return publicSettings(await readSettings());
    case 'GET_SETTINGS':
      requireUI(sender);
      return readSettings();
    case 'SAVE_SETTINGS': {
      requireUI(sender);
      const validated = validateSettings(message.settings);
      // UI snapshots must not overwrite concurrently changed automatic translation switches.
      return updateSettings((current) => ({
        ...validated,
        discordAutoChannels: current.discordAutoChannels,
        pageAutoDomains: current.pageAutoDomains,
      }));
    }
    case 'SET_ACTIVE_PROVIDER':
      requireUI(sender);
      return updateSettings((settings) => ({ ...settings, activeProviderId: message.providerId }));
    case 'SET_OUTGOING_LANGUAGE':
      if (
        !isExtensionUI(sender) &&
        (!message.channel || (await discordSenderChannel(sender)) !== message.channel)
      )
        throw new Error('只能更改当前 Discord 频道的发送目标语言。');
      if (!LANGUAGES.some(([code]) => code === message.language))
        throw new Error('发送目标语言无效。');
      return updateSettings((settings) => ({
        ...settings,
        outgoingTargetLanguage: message.language,
      }));
    case 'SET_DISCORD_AUTO': {
      const channel = discordChannel(message.channel ?? '');
      if (!channel || channel !== message.channel) throw new Error('请选择有效的 Discord 频道。');
      if (!isExtensionUI(sender)) {
        if ((await discordSenderChannel(sender)) !== channel)
          throw new Error('只能更改当前 Discord 频道。');
      }
      if (!message.enabled) engine.cancelAutomatic(channel);
      return updateSettings((settings) => ({
        ...settings,
        discordAutoChannels: message.enabled
          ? [...new Set([...settings.discordAutoChannels, channel])]
          : settings.discordAutoChannels.filter((value) => value !== channel),
      }));
    }
    case 'SET_PAGE_AUTO': {
      requireUI(sender);
      const domain = normalizePageDomain(message.domain);
      if (typeof message.enabled !== 'boolean') throw new Error('自动翻译开关无效。');
      return updateSettings((settings) => ({
        ...settings,
        pageAutoDomains: message.enabled
          ? [...new Set([...settings.pageAutoDomains, domain])]
          : settings.pageAutoDomains.filter((value) => value !== domain),
      }));
    }
    case 'EDIT_PAGE_AUTO': {
      requireUI(sender);
      const domain = normalizePageDomain(message.domain);
      const nextDomain = normalizePageDomain(message.nextDomain);
      return updateSettings((settings) => {
        if (!settings.pageAutoDomains.includes(domain))
          throw new Error('此网站已被移除，请刷新列表后重试。');
        if (nextDomain !== domain && settings.pageAutoDomains.includes(nextDomain))
          throw new Error('此域名已在常用网站中。');
        return {
          ...settings,
          pageAutoDomains: settings.pageAutoDomains.map((value) =>
            value === domain ? nextDomain : value,
          ),
        };
      });
    }
    case 'TRANSLATE':
      return translate(message.input, sender);
    case 'TEST_PROVIDER':
      requireUI(sender);
      return translate(
        {
          text: 'The connection is working. Have a wonderful day!',
          providerId: message.providerId,
          source: 'test',
          bypassCache: true,
        },
        sender,
      );
    case 'LIST_PROVIDER_MODELS': {
      requireUI(sender);
      const provider = validateProvider(message.provider, { requireModel: false });
      if (!(await chrome.permissions.contains({ origins: [providerOrigin(provider)] })))
        throw new Error('尚未授予此接口的访问权限。');
      return listProviderModels(provider);
    }
    case 'CLEAR_CACHE':
      requireUI(sender);
      engine.clearCache();
      await cacheWrites;
      return null;
    default:
      throw new Error('不支持的扩展操作。');
  }
}

chrome.runtime.onMessage.addListener((message: Message, sender, respond) => {
  void handle(message, sender)
    .then((data) => respond({ ok: true, data }))
    .catch((error: unknown) => {
      respond({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' });
    });
  return true;
});

// Port messages keep MV3 alive while the content script waits for queued work.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'flow-translation' && port.sender?.id === chrome.runtime.id) {
    port.onMessage.addListener(() => {});
    onPortDisconnect(port, () => {});
  }
});

async function inject(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function sendPageAction(tabId: number, message: Message): Promise<void> {
  await inject(tabId);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' } satisfies Message);
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await chrome.tabs.sendMessage(tabId, message);
}

chrome.runtime.onInstalled.addListener(() => {
  void storageReady.then(async () => {
    const stored = await chrome.storage.local.get('settings');
    if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'flow-selection',
      title: '用译流翻译选中文字',
      contexts: ['selection'],
    });
  });
});

function refreshPageDomains(): Promise<void> {
  const task = settingsWrite.then(async () => {
    const settings = await readSettings();
    const authorized = await authorizedPageDomains(settings.pageAutoDomains);
    await registerPageDomains(authorized);
    if (authorized.length !== settings.pageAutoDomains.length) {
      for (const domain of settings.pageAutoDomains)
        if (!authorized.includes(domain)) engine.cancelAutomatic('page:' + domain);
      settings.pageAutoDomains = authorized;
      await chrome.storage.local.set({ settings });
      await broadcast(settings);
    }
  });
  settingsWrite = task.catch(() => {});
  return task;
}

// Persistent registrations inject on future navigations without waiting for a popup or worker.
void storageReady.then(refreshPageDomains).catch(() => {});
chrome.permissions.onRemoved.addListener(() => {
  void storageReady.then(refreshPageDomains).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'flow-selection' && tab?.id != null && info.selectionText) {
    void sendPageAction(tab.id, { type: 'TRANSLATE_SELECTION', text: info.selectionText }).catch(
      () => {},
    );
  }
});

chrome.commands.onCommand.addListener((command) => {
  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(async (tabs) => {
      if (tabs[0]?.id == null) return;
      await sendPageAction(tabs[0].id, {
        type: command === 'restore-page' ? 'RESTORE_PAGE' : 'TRANSLATE_PAGE',
      });
    })
    .catch(() => {});
});
