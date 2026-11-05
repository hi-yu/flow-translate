import { send } from './messaging';
import {
  discordChannel,
  isLoopback,
  normalizePageDomain,
  pageDomainPattern,
  providerOrigin,
  validateProvider,
} from './settings';
import { el, errorText, languages, status } from './ui';
import type { Message, Provider, PublicSettings, Settings, TranslationResult } from './types';

let settings: Settings;
let selectedId = '';
let dirty = false;
let draftId: string | undefined;
let customDeepLUrl = '';
let editingDomain: string | undefined;
let domainSaving = false;
let modelRequest = 0;

const DEEPL_ENDPOINTS = {
  free: 'https://api-free.deepl.com/v2',
  pro: 'https://api.deepl.com/v2',
} as const;

const presets: Record<string, Omit<Provider, 'id' | 'apiKey'>> = {
  ollama: {
    name: '本地 Ollama',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'hy-mt2-7b:q6_k',
  },
  compatible: { name: '自定义兼容接口', kind: 'openai', baseUrl: '', model: '' },
  deepseek: {
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  qwen: {
    name: '通义千问',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  deepl: { name: 'DeepL', kind: 'deepl', baseUrl: DEEPL_ENDPOINTS.free, model: '' },
  gemini: {
    name: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: '',
  },
};

function current(): Provider {
  return settings.providers.find((provider) => provider.id === selectedId)!;
}

function discardDraft(): void {
  if (draftId)
    settings.providers = settings.providers.filter((provider) => provider.id !== draftId);
  draftId = undefined;
}

function readForm(requireModel = true): Provider {
  return validateProvider(
    {
      id: selectedId,
      name: el<HTMLInputElement>('provider-name').value,
      kind: current().kind,
      baseUrl: el<HTMLInputElement>('provider-url').value,
      model: el<HTMLInputElement>('provider-model').value,
      apiKey: el<HTMLInputElement>('provider-key').value,
    },
    { requireModel },
  );
}

function modelStatus(message: string, error = false): void {
  el('model-status').textContent = message;
  el('model-status').classList.toggle('error', error);
}

function useModelInput(): void {
  const input = el<HTMLInputElement>('provider-model');
  const select = el<HTMLSelectElement>('provider-model-select');
  input.hidden = false;
  input.disabled = false;
  select.hidden = true;
  select.disabled = true;
  select.required = false;
  el('model-label').setAttribute('for', 'provider-model');
  el('manual-model').hidden = true;
}

function resetModelList(): void {
  modelRequest++;
  useModelInput();
  el<HTMLButtonElement>('fetch-models').disabled = false;
  el('fetch-models-label').textContent = '拉取模型';
  el('model-field').setAttribute('aria-busy', 'false');
  el('provider-model-select').replaceChildren();
  modelStatus('可手动填写，或通过接口拉取模型列表。');
}

async function fetchModels(): Promise<void> {
  const request = ++modelRequest;
  const button = el<HTMLButtonElement>('fetch-models');
  try {
    const provider = readForm(false);
    if (!provider.apiKey) throw new Error('请先填写 API Key。');
    const permission = chrome.permissions.request({ origins: [providerOrigin(provider)] });
    button.disabled = true;
    el('fetch-models-label').textContent = '拉取中…';
    el('model-field').setAttribute('aria-busy', 'true');
    modelStatus('正在拉取模型列表…');
    if (!(await permission)) throw new Error('未授予此接口的访问权限。');
    if (request !== modelRequest) return;
    const models = await send<string[]>({ type: 'LIST_PROVIDER_MODELS', provider });
    if (request !== modelRequest) return;
    if (!models.length) throw new Error('接口返回的模型列表为空。');
    const input = el<HTMLInputElement>('provider-model');
    const select = el<HTMLSelectElement>('provider-model-select');
    const currentModel = input.value.trim();
    select.replaceChildren();
    if (!currentModel) select.add(new Option('请选择模型', ''));
    else if (!models.includes(currentModel))
      select.add(new Option(`${currentModel}（当前填写）`, currentModel));
    for (const model of models) select.add(new Option(model, model));
    select.value = currentModel;
    select.hidden = false;
    select.disabled = false;
    select.required = true;
    input.hidden = true;
    input.disabled = true;
    el('model-label').setAttribute('for', 'provider-model-select');
    el('manual-model').hidden = false;
    modelStatus(
      `已拉取 ${models.length} 个模型。${currentModel && !models.includes(currentModel) ? '当前填写的模型不在列表中，已保留。' : '请选择要使用的模型。'}`,
    );
  } catch (error) {
    if (request !== modelRequest) return;
    useModelInput();
    modelStatus('没有拉取到模型：' + errorText(error), true);
  } finally {
    if (request === modelRequest) {
      button.disabled = false;
      el('fetch-models-label').textContent = '拉取模型';
      el('model-field').setAttribute('aria-busy', 'false');
    }
  }
}

function hints(): void {
  const kind = current().kind;
  const customUrl = kind !== 'deepl' || el<HTMLSelectElement>('deepl-endpoint').value === 'custom';
  el('deepl-endpoint-field').hidden = kind !== 'deepl';
  el('provider-url-field').hidden = !customUrl;
  el<HTMLInputElement>('provider-url').disabled = !customUrl;
  el('provider-url-label').textContent = kind === 'deepl' ? '自定义 API 根地址' : 'API 根地址';
  el('deepl-key-help').hidden = kind !== 'deepl';
  el('model-field').hidden = kind === 'deepl';
  el<HTMLInputElement>('provider-model').required = kind !== 'deepl';
  el('url-hint').textContent =
    kind === 'deepl'
      ? '填写到 /v2，自定义地址需支持 DeepL 原生接口。'
      : kind === 'gemini'
        ? '填写到 /v1beta，并填写可用的 Gemini 模型 ID。'
        : '填写到 /v1，扩展会添加 /chat/completions。';
  let local = false;
  try {
    local = isLoopback(new URL(el<HTMLInputElement>('provider-url').value).hostname);
  } catch {
    /* Incomplete URL while typing. */
  }
  el('provider-tag').textContent = local ? '本机处理' : '远程接口';
  el('key-hint').textContent =
    kind === 'deepl'
      ? '密钥仅保存在当前浏览器，翻译内容会发送到所选 API 地址。'
      : local
        ? '填写此接口的 API Key。密钥仅保存在当前浏览器，不同步、不注入网页。'
        : '仅保存在当前浏览器，不同步、不注入网页。选择此接口时，原文会发送给此服务商。';
}

function renderList(): void {
  el('provider-count').textContent = String(settings.providers.length).padStart(2, '0');
  el('provider-list').replaceChildren(
    ...settings.providers.map((provider) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provider-item';
      button.setAttribute('aria-current', String(provider.id === selectedId));
      const icon = document.createElement('span');
      icon.className = 'provider-icon';
      icon.textContent = provider.kind === 'deepl' ? 'DL' : provider.kind === 'gemini' ? 'G' : '↗';
      let local = false;
      try {
        local = isLoopback(new URL(provider.baseUrl).hostname);
      } catch {
        /* Unsaved preset. */
      }
      if (local && provider.kind === 'openai') icon.textContent = '本';
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = provider.name;
      const info = document.createElement('small');
      info.textContent =
        provider.kind === 'openai'
          ? local
            ? '本地 · Ollama / 兼容接口'
            : 'OpenAI 兼容协议'
          : provider.kind === 'deepl'
            ? 'DeepL 原生协议'
            : 'Gemini 原生协议';
      text.append(name, info);
      button.append(icon, text);
      if (provider.id === settings.activeProviderId) {
        const badge = document.createElement('span');
        badge.textContent = '默认';
        badge.className = 'default-mark';
        button.append(badge);
      }
      button.onclick = () => {
        if (provider.id === selectedId) return;
        if (dirty && !confirm('当前接口有未保存的更改，确定切换并放弃这些更改吗？')) return;
        discardDraft();
        selectedId = provider.id;
        dirty = false;
        renderForm();
        renderList();
      };
      return button;
    }),
  );
}

function renderForm(): void {
  resetModelList();
  const provider = current();
  el('provider-title').textContent = provider.name;
  el<HTMLInputElement>('provider-name').value = provider.name;
  el<HTMLInputElement>('provider-url').value = provider.baseUrl;
  const endpoint = Object.entries(DEEPL_ENDPOINTS).find(([, url]) => url === provider.baseUrl)?.[0];
  el<HTMLSelectElement>('deepl-endpoint').value = endpoint ?? 'custom';
  customDeepLUrl = provider.kind === 'deepl' && !endpoint ? provider.baseUrl : '';
  el<HTMLInputElement>('provider-model').value = provider.model;
  el<HTMLInputElement>('provider-key').value = provider.apiKey;
  el<HTMLInputElement>('provider-key').type = 'password';
  el('show-key').textContent = '显示';
  el('show-key').setAttribute('aria-pressed', 'false');
  el<HTMLButtonElement>('set-default').disabled = provider.id === settings.activeProviderId;
  el('set-default').textContent =
    provider.id === settings.activeProviderId ? '当前默认' : '设为默认';
  el<HTMLButtonElement>('delete-provider').disabled = settings.providers.length === 1;
  el('test-result').hidden = true;
  status('form-status', '');
  hints();
}

async function save(): Promise<void> {
  const provider = readForm();
  // Must execute permissions.request during the button's user activation.
  const granted = await chrome.permissions.request({ origins: [providerOrigin(provider)] });
  if (!granted) throw new Error('未授予此接口的访问权限，配置尚未保存。');
  const next = {
    ...settings,
    providers: settings.providers.map((p) => (p.id === provider.id ? provider : p)),
  };
  await send({ type: 'SAVE_SETTINGS', settings: next });
  settings = await send<Settings>({ type: 'GET_SETTINGS' });
  dirty = false;
  draftId = undefined;
  renderList();
  el('provider-title').textContent = provider.name;
  status('form-status', '已保存。新请求将使用更新后的配置。');
}

function autoSummary(): void {
  el('auto-summary').textContent = settings.discordAutoChannels.length
    ? `已为 ${settings.discordAutoChannels.length} 个频道开启`
    : '自动翻译默认关闭';
  el<HTMLButtonElement>('disable-auto').disabled = settings.discordAutoChannels.length === 0;
  const list = el('discord-auto-channels');
  list.replaceChildren();
  if (!settings.discordAutoChannels.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = '尚未开启任何频道的自动翻译。';
    list.append(empty);
  }
  const links = new Map<string, HTMLAnchorElement>();
  for (const channel of settings.discordAutoChannels) {
    const [, , serverId, channelId] = channel.split('/');
    const row = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'channel-info';
    const link = document.createElement('a');
    link.href = 'https://discord.com' + channel;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${serverId === '@me' ? '私信' : '频道'} ${channelId}`;
    links.set(channel, link);
    const detail = document.createElement('small');
    detail.textContent = serverId === '@me' ? channel : `服务器 ${serverId} · 频道 ${channelId}`;
    info.append(link, detail);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = '关闭自动翻译';
    remove.setAttribute('aria-label', `关闭 ${channel} 的自动翻译`);
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        const saved = await send<PublicSettings>({
          type: 'SET_DISCORD_AUTO',
          channel,
          enabled: false,
        });
        settings.discordAutoChannels = saved.discordAutoChannels;
        autoSummary();
        status('discord-auto-status', '已关闭此频道的自动翻译。');
      } catch (error) {
        status('discord-auto-status', errorText(error), true);
        remove.disabled = false;
      }
    };
    row.append(info, remove);
    list.append(row);
  }
  // Use titles from open Discord tabs when available; closed channels retain their exact IDs.
  void chrome.tabs
    .query({
      url: ['https://discord.com/*', 'https://ptb.discord.com/*', 'https://canary.discord.com/*'],
    })
    .then((tabs) => {
      for (const tab of tabs) {
        const channel = tab.url ? discordChannel(new URL(tab.url).pathname) : null;
        const link = channel ? links.get(channel) : undefined;
        if (link?.isConnected && tab.title && tab.title !== 'Discord') link.textContent = tab.title;
      }
    })
    .catch(() => {});
}

function resetDomainEditor(): void {
  editingDomain = undefined;
  el<HTMLInputElement>('page-domain-input').value = '';
  el('save-page-domain').textContent = '添加网站';
  el('cancel-page-domain').hidden = true;
}

function setupPreferenceTabs(): void {
  const tabs = [el<HTMLButtonElement>('web-tab'), el<HTMLButtonElement>('discord-tab')];
  for (const [index, tab] of tabs.entries()) {
    tab.onclick = () => {
      for (const item of tabs) {
        const active = item === tab;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        el(item.getAttribute('aria-controls')!).hidden = !active;
      }
    };
    tab.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        tabs[
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (index + 1) % tabs.length
        ]!;
      next.click();
      next.focus();
    };
  }
}

function renderPageDomains(): void {
  const list = el('page-auto-domains');
  list.replaceChildren();
  if (!settings.pageAutoDomains.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = '尚未记住任何域名。';
    list.append(empty);
  }
  for (const domain of settings.pageAutoDomains) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = domain;
    const actions = document.createElement('div');
    actions.className = 'domain-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'text-button';
    edit.textContent = '编辑';
    edit.setAttribute('aria-label', `编辑 ${domain}`);
    edit.disabled = domainSaving;
    edit.onclick = () => {
      editingDomain = domain;
      const input = el<HTMLInputElement>('page-domain-input');
      input.value = domain;
      el('save-page-domain').textContent = '保存修改';
      el('cancel-page-domain').hidden = false;
      status('page-auto-status', '');
      input.focus();
      input.select();
    };
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = '取消自动翻译';
    remove.setAttribute('aria-label', `取消 ${domain} 的自动翻译`);
    remove.disabled = domainSaving;
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        const saved = await send<PublicSettings>({ type: 'SET_PAGE_AUTO', domain, enabled: false });
        settings.pageAutoDomains = saved.pageAutoDomains;
        if (editingDomain === domain) resetDomainEditor();
        renderPageDomains();
        status('page-auto-status', `已取消 ${domain} 的自动翻译。`);
      } catch (error) {
        status('page-auto-status', errorText(error), true);
        remove.disabled = false;
      }
    };
    actions.append(edit, remove);
    row.append(name, actions);
    list.append(row);
  }
}

async function main(): Promise<void> {
  settings = await send<Settings>({ type: 'GET_SETTINGS' });
  selectedId = settings.activeProviderId;
  languages(el('target-language'), settings.targetLanguage);
  languages(el('outgoing-target-language'), settings.outgoingTargetLanguage);
  el<HTMLSelectElement>('discord-display-mode').value = settings.discordDisplayMode;
  renderList();
  renderForm();
  autoSummary();
  renderPageDomains();
  setupPreferenceTabs();
  el('fetch-models').onclick = () => {
    void fetchModels();
  };
  el<HTMLSelectElement>('provider-model-select').onchange = () => {
    el<HTMLInputElement>('provider-model').value =
      el<HTMLSelectElement>('provider-model-select').value;
  };
  el('manual-model').onclick = () => {
    resetModelList();
    modelStatus('已切回手动填写，当前模型名称已保留。');
    el('provider-model').focus();
  };
  for (const id of ['provider-url', 'provider-key'])
    el(id).addEventListener('input', resetModelList);
  el('cancel-page-domain').onclick = () => {
    resetDomainEditor();
    status('page-auto-status', '');
    el('page-domain-input').focus();
  };
  el('page-domain-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (domainSaving) return;
    void (async () => {
      const input = el<HTMLInputElement>('page-domain-input');
      const domain = normalizePageDomain(input.value.trim());
      const previousDomain = editingDomain;
      if (domain !== previousDomain && settings.pageAutoDomains.includes(domain))
        throw new Error('此域名已在常用网站中。');
      // Request permission before awaiting any messaging so user activation is retained.
      const permission = chrome.permissions.request({ origins: [pageDomainPattern(domain)] });
      domainSaving = true;
      input.disabled = true;
      el<HTMLButtonElement>('save-page-domain').disabled = true;
      el<HTMLButtonElement>('cancel-page-domain').disabled = true;
      renderPageDomains();
      try {
        if (!(await permission)) throw new Error('未授予此网站的访问权限，常用网站未修改。');
        const saved = await send<PublicSettings>(
          previousDomain
            ? { type: 'EDIT_PAGE_AUTO', domain: previousDomain, nextDomain: domain }
            : { type: 'SET_PAGE_AUTO', domain, enabled: true },
        );
        settings.pageAutoDomains = saved.pageAutoDomains;
        resetDomainEditor();
        status(
          'page-auto-status',
          previousDomain
            ? `已将 ${previousDomain} 修改为 ${domain}。`
            : `已添加 ${domain}，访问时自动翻译。`,
        );
      } finally {
        domainSaving = false;
        input.disabled = false;
        el<HTMLButtonElement>('save-page-domain').disabled = false;
        el<HTMLButtonElement>('cancel-page-domain').disabled = false;
        renderPageDomains();
      }
    })().catch((error) => status('page-auto-status', errorText(error), true));
  });
  el<HTMLInputElement>('provider-url').addEventListener('input', () => {
    if (current().kind === 'deepl' && el<HTMLSelectElement>('deepl-endpoint').value === 'custom')
      customDeepLUrl = el<HTMLInputElement>('provider-url').value;
  });
  el<HTMLSelectElement>('deepl-endpoint').onchange = () => {
    const endpoint = el<HTMLSelectElement>('deepl-endpoint').value;
    el<HTMLInputElement>('provider-url').value =
      endpoint === 'free'
        ? DEEPL_ENDPOINTS.free
        : endpoint === 'pro'
          ? DEEPL_ENDPOINTS.pro
          : customDeepLUrl;
  };
  chrome.runtime.onMessage.addListener((message: Message) => {
    if (message.type === 'SETTINGS_CHANGED') {
      settings.discordAutoChannels = message.settings.discordAutoChannels;
      settings.pageAutoDomains = message.settings.pageAutoDomains;
      autoSummary();
      renderPageDomains();
    }
  });
  el('provider-form').addEventListener('input', () => {
    dirty = true;
    status('form-status', '有未保存的更改。');
    hints();
  });
  el('provider-form').addEventListener('change', () => {
    dirty = true;
    status('form-status', '有未保存的更改。');
    hints();
  });
  el('provider-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const button = el<HTMLButtonElement>('save');
    button.disabled = true;
    void save()
      .catch((error) => status('form-status', errorText(error), true))
      .finally(() => {
        button.disabled = false;
      });
  });
  el('show-key').onclick = () => {
    const input = el<HTMLInputElement>('provider-key');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    el('show-key').textContent = reveal ? '隐藏' : '显示';
    el('show-key').setAttribute('aria-pressed', String(reveal));
  };
  el('add-provider').onclick = () => {
    if (settings.providers.length >= 20) {
      status('form-status', '最多添加 20 个接口。', true);
      return;
    }
    if (dirty && !confirm('当前有未保存的更改，确定添加新接口吗？')) return;
    discardDraft();
    const preset = presets[el<HTMLSelectElement>('preset').value]!;
    const provider: Provider = { ...preset, id: crypto.randomUUID(), apiKey: '' };
    settings.providers.push(provider);
    selectedId = provider.id;
    draftId = provider.id;
    renderList();
    renderForm();
    dirty = true;
    status('form-status', '填写配置并保存后，此接口才能用于翻译。');
  };
  el('set-default').onclick = async () => {
    try {
      await save();
      await send({ type: 'SET_ACTIVE_PROVIDER', providerId: selectedId });
      settings.activeProviderId = selectedId;
      renderList();
      renderForm();
      status('form-status', '已设为默认接口。');
    } catch (error) {
      status('form-status', errorText(error), true);
    }
  };
  el('test-provider').onclick = async () => {
    const button = el<HTMLButtonElement>('test-provider');
    button.disabled = true;
    try {
      await save();
      status('form-status', '正在发送一段示例英文，测试接口连接…');
      const result = await send<TranslationResult>({
        type: 'TEST_PROVIDER',
        providerId: selectedId,
      });
      el('test-result').textContent = result.text;
      el('test-result').hidden = false;
      status('form-status', '连接成功，可以开始翻译。');
    } catch (error) {
      status('form-status', errorText(error), true);
    } finally {
      button.disabled = false;
    }
  };
  el('delete-provider').onclick = async () => {
    if (settings.providers.length === 1 || !confirm('删除此接口及保存在浏览器中的密钥？')) return;
    const providers = settings.providers.filter((provider) => provider.id !== selectedId);
    const next = {
      ...settings,
      providers,
      activeProviderId:
        settings.activeProviderId === selectedId ? providers[0]!.id : settings.activeProviderId,
    };
    try {
      await send({ type: 'SAVE_SETTINGS', settings: next });
      settings = await send({ type: 'GET_SETTINGS' });
      selectedId = settings.activeProviderId;
      dirty = false;
      draftId = undefined;
      renderList();
      renderForm();
    } catch (error) {
      status('form-status', errorText(error), true);
    }
  };
  el<HTMLSelectElement>('target-language').onchange = async () => {
    try {
      const fresh = await send<Settings>({ type: 'GET_SETTINGS' });
      fresh.targetLanguage = el<HTMLSelectElement>('target-language').value;
      await send({ type: 'SAVE_SETTINGS', settings: fresh });
      settings.targetLanguage = fresh.targetLanguage;
      status('form-status', '默认目标语言已更新。');
    } catch (error) {
      status('form-status', errorText(error), true);
    }
  };
  el('clear-cache').onclick = async () => {
    await send({ type: 'CLEAR_CACHE' });
    status('form-status', '本次会话的翻译缓存已清除。');
  };
  for (const [id, field] of [
    ['discord-display-mode', 'discordDisplayMode'],
    ['outgoing-target-language', 'outgoingTargetLanguage'],
  ] as const) {
    el<HTMLSelectElement>(id).onchange = async () => {
      try {
        const fresh = await send<Settings>({ type: 'GET_SETTINGS' });
        if (field === 'discordDisplayMode')
          fresh[field] = el<HTMLSelectElement>(id).value as Settings['discordDisplayMode'];
        else fresh[field] = el<HTMLSelectElement>(id).value;
        await send({ type: 'SAVE_SETTINGS', settings: fresh });
        settings = {
          ...settings,
          discordDisplayMode: fresh.discordDisplayMode,
          outgoingTargetLanguage: fresh.outgoingTargetLanguage,
        };
        status('discord-auto-status', '显示与发送偏好已保存。');
      } catch (error) {
        status('discord-auto-status', errorText(error), true);
      }
    };
  }
  el('disable-auto').onclick = async () => {
    el<HTMLButtonElement>('disable-auto').disabled = true;
    try {
      for (const channel of [...settings.discordAutoChannels])
        await send({ type: 'SET_DISCORD_AUTO', channel, enabled: false });
      const saved = await send<Settings>({ type: 'GET_SETTINGS' });
      settings.discordAutoChannels = saved.discordAutoChannels;
      status('discord-auto-status', '已关闭所有频道的自动翻译。');
    } catch (error) {
      status('discord-auto-status', errorText(error), true);
    } finally {
      autoSummary();
    }
  };
  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });
}

void main().catch((error) => status('form-status', errorText(error), true));
