import { send } from './messaging';
import { discordChannel, isDiscordHost, pageDomain, pageDomainPattern } from './settings';
import { el, errorText, languages, status } from './ui';
import type {
  DraftSnapshot,
  Message,
  PublicSettings,
  Reply,
  Settings,
  TranslationResult,
} from './types';
import type { PageTranslationStatus } from './page-translator';

let settings: PublicSettings;
let tab: chrome.tabs.Tab | undefined;
let channel: string | null = null;
let reportPageProgress = false;
let discordRefresh = 0;
let draftRevision = 0;
let draft: DraftSnapshot | undefined;
let lastNotice = '';

function invalidateDraft(message = ''): void {
  draftRevision++;
  draft = undefined;
  el<HTMLTextAreaElement>('draft-output').value = '';
  el('draft-preview').hidden = true;
  el<HTMLButtonElement>('apply-draft').disabled = true;
  el<HTMLButtonElement>('copy-draft').disabled = true;
  el<HTMLButtonElement>('translate-draft').disabled = false;
  status('draft-status', message);
}

async function draftAction<T>(message: Message): Promise<T> {
  await ensureContent();
  const reply = (await chrome.tabs.sendMessage(tab!.id!, message)) as Reply<T>;
  if (!reply?.ok) throw new Error(reply?.error ?? '无法读取消息输入框，请刷新 Discord 后重试。');
  return reply.data;
}

async function translateDraft(): Promise<void> {
  invalidateDraft();
  const revision = draftRevision;
  const button = el<HTMLButtonElement>('translate-draft');
  button.disabled = true;
  status('draft-status', '正在翻译草稿…');
  try {
    const snapshot = await draftAction<DraftSnapshot>({ type: 'READ_DRAFT' });
    const result = await send<TranslationResult>({
      type: 'TRANSLATE',
      input: {
        text: snapshot.text,
        source: 'draft',
        channel: snapshot.channel,
        providerId: el<HTMLSelectElement>('provider').value,
        targetLanguage: el<HTMLSelectElement>('outgoing-language').value,
      },
    });
    const currentTab = await chrome.tabs.get(tab!.id!);
    if (revision !== draftRevision) return;
    if (discordChannel(new URL(currentTab.url ?? 'about:blank').pathname) !== snapshot.channel)
      throw new Error('频道已变化，请重新翻译当前草稿。');
    draft = snapshot;
    el<HTMLTextAreaElement>('draft-output').value = result.text;
    el('draft-preview').hidden = false;
    el<HTMLButtonElement>('apply-draft').disabled = !snapshot.canReplace;
    el<HTMLButtonElement>('copy-draft').disabled = false;
    status(
      'draft-status',
      snapshot.canReplace
        ? '检查译文后，可替换草稿并自行发送。'
        : '草稿包含提及或特殊内容，请复制译文后手动编辑。',
    );
  } catch (error) {
    if (revision === draftRevision) status('draft-status', errorText(error), true);
  } finally {
    if (revision === draftRevision) button.disabled = false;
  }
}

async function refreshDiscordContext(): Promise<string | null> {
  if (tab?.id == null) return null;
  const revision = ++discordRefresh;
  const currentTab = await chrome.tabs.get(tab.id);
  const currentSettings = await send<PublicSettings>({ type: 'GET_PUBLIC_SETTINGS' });
  const url = new URL(currentTab.url ?? 'about:blank');
  const currentChannel = isDiscordHost(url.hostname) ? discordChannel(url.pathname) : null;
  if (revision !== discordRefresh) return currentChannel;
  tab = currentTab;
  if (channel !== currentChannel) invalidateDraft('频道已切换，请重新翻译当前草稿。');
  channel = currentChannel;
  settings = currentSettings;
  el('discord-controls').hidden = !channel;
  el('draft-panel').hidden = !channel;
  const toggle = el<HTMLInputElement>('discord-auto');
  if (!toggle.disabled)
    toggle.checked = Boolean(channel && settings.discordAutoChannels.includes(channel));
  try {
    const state = (await chrome.tabs.sendMessage(tab.id!, { type: 'GET_STATUS' })) as {
      notice?: string;
    };
    if (revision === discordRefresh && state.notice && state.notice !== lastNotice) {
      lastNotice = state.notice;
      status('status', state.notice, state.notice.startsWith('自动翻译已暂停'));
    }
  } catch {
    /* An uninjected or reloading tab has no content status yet. */
  }
  return currentChannel;
}

async function pageProgress(): Promise<void> {
  if (tab?.id == null) return;
  try {
    const response = (await chrome.tabs.sendMessage(tab.id, {
      type: 'GET_STATUS',
    } satisfies Message)) as { page?: PageTranslationStatus };
    const progress = response.page;
    if (!progress || !reportPageProgress) return;
    if (progress.error) status('status', '翻译已暂停：' + progress.error, true);
    else if (progress.enabled)
      status(
        'status',
        `已翻译 ${progress.translated} 处文字${progress.pending ? `，还有 ${progress.pending} 处正在处理。` : '，滚动时继续翻译。'}${progress.skipped ? ` ${progress.skipped} 处由网站管理，保留原文。` : ''}`,
      );
  } catch {
    /* Pages without an injected content script have no translation status yet. */
  }
}

async function ensureContent(): Promise<void> {
  if (tab?.id == null || !tab.url || !/^https?:/.test(tab.url))
    throw new Error('此页面不允许扩展注入，请打开普通网页或 Discord 网页版。');
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  // start() initializes asynchronously after injection.
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' } satisfies Message);
      return;
    } catch {
      if (i === 9) throw new Error('页面尚未就绪，请刷新后重试。');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function pageAction(type: 'TRANSLATE_PAGE' | 'RESTORE_PAGE'): Promise<void> {
  await ensureContent();
  await chrome.tabs.sendMessage(tab!.id!, { type } satisfies Message);
}

async function main(): Promise<void> {
  settings = await send<PublicSettings>({ type: 'GET_PUBLIC_SETTINGS' });
  const providers = el<HTMLSelectElement>('provider');
  providers.replaceChildren(
    ...settings.providers.map((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name;
      return option;
    }),
  );
  providers.value = settings.activeProviderId;
  languages(el('language'), settings.targetLanguage);
  languages(el('outgoing-language'), settings.outgoingTargetLanguage);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let discord = false;
  if (tab?.url?.startsWith('http')) {
    const url = new URL(tab.url);
    discord = isDiscordHost(url.hostname);
    channel = discord ? discordChannel(url.pathname) : null;
    el('site-name').textContent = url.hostname;
    el('context-label').textContent = discord ? 'Discord 会话' : '当前网页';
    el('context-hint').textContent = discord
      ? settings.discordDisplayMode === 'translation-only'
        ? '消息仅显示译文，可在设置切回双语对照。'
        : '消息双语对照，可在设置切换显示方式。'
      : '在原位置显示译文，保留页面布局和交互。';
  } else {
    el('site-name').textContent = '先打开一个网页';
    el<HTMLButtonElement>('translate').disabled = true;
  }
  el('discord-controls').hidden = !channel;
  el('draft-panel').hidden = !channel;
  el<HTMLInputElement>('discord-auto').checked = Boolean(
    channel && settings.discordAutoChannels.includes(channel),
  );
  const domain = pageDomain(tab?.url ?? '');
  el('page-auto-controls').hidden = !domain;
  el('page-auto-domain').textContent = domain ? `${domain} · 下次访问也自动翻译` : '';
  const pageAuto = el<HTMLInputElement>('page-auto');
  pageAuto.checked = Boolean(domain && settings.pageAutoDomains.includes(domain));
  chrome.runtime.onMessage.addListener((message: Message) => {
    if (message.type === 'SETTINGS_CHANGED') {
      if (settings.outgoingTargetLanguage !== message.settings.outgoingTargetLanguage) {
        settings.outgoingTargetLanguage = message.settings.outgoingTargetLanguage;
        el<HTMLSelectElement>('outgoing-language').value = settings.outgoingTargetLanguage;
        invalidateDraft();
      }
      settings.pageAutoDomains = message.settings.pageAutoDomains;
      if (!pageAuto.disabled)
        pageAuto.checked = Boolean(domain && settings.pageAutoDomains.includes(domain));
    }
  });
  pageAuto.onchange = async () => {
    if (!domain || tab?.id == null) return;
    const enabled = pageAuto.checked;
    pageAuto.disabled = true;
    try {
      if (enabled && !(await chrome.permissions.request({ origins: [pageDomainPattern(domain)] })))
        throw new Error('未授予此域名的访问权限，自动翻译尚未开启。');
      const current = await chrome.tabs.get(tab.id);
      if (pageDomain(current.url ?? '') !== domain)
        throw new Error('网页已切换，请重新打开扩展弹窗。');
      settings = await send({ type: 'SET_PAGE_AUTO', domain, enabled });
      status(
        'status',
        enabled ? `已记住 ${domain}，访问时自动翻译。` : '已关闭此域名的自动翻译，并恢复原文。',
      );
    } catch (error) {
      status('status', errorText(error), true);
    } finally {
      pageAuto.checked = settings.pageAutoDomains.includes(domain);
      pageAuto.disabled = false;
    }
  };
  el('translate').textContent = discord ? '翻译可见消息' : '翻译此网页';
  el('restore').textContent = discord ? '移除消息译文' : '显示原文';
  if (!discord) {
    reportPageProgress = true;
    void pageProgress();
    setInterval(() => {
      if (reportPageProgress) void pageProgress();
    }, 750);
  } else {
    setInterval(() => {
      void refreshDiscordContext().catch(() => {});
    }, 750);
  }
  providers.onchange = async () => {
    invalidateDraft();
    try {
      settings = await send({ type: 'SET_ACTIVE_PROVIDER', providerId: providers.value });
      status('status', '已切换接口，新请求将使用此接口。');
    } catch (error) {
      status('status', errorText(error), true);
    }
  };
  el<HTMLSelectElement>('outgoing-language').onchange = async () => {
    invalidateDraft();
    try {
      settings = await send({
        type: 'SET_OUTGOING_LANGUAGE',
        language: el<HTMLSelectElement>('outgoing-language').value,
      });
    } catch (error) {
      status('draft-status', errorText(error), true);
    }
  };
  el('translate-draft').onclick = () => void translateDraft();
  el('apply-draft').onclick = async () => {
    if (!draft) return;
    const button = el<HTMLButtonElement>('apply-draft');
    button.disabled = true;
    try {
      await draftAction({
        type: 'APPLY_DRAFT',
        token: draft.token,
        text: el<HTMLTextAreaElement>('draft-output').value,
      });
      draft = undefined;
      status('draft-status', '已替换输入框草稿，请回到 Discord 检查并发送。');
    } catch (error) {
      draft = undefined;
      status('draft-status', errorText(error), true);
    }
  };
  el('copy-draft').onclick = async () => {
    try {
      await navigator.clipboard.writeText(el<HTMLTextAreaElement>('draft-output').value);
      status('draft-status', '译文已复制，可回到 Discord 粘贴。');
    } catch {
      status('draft-status', '复制失败，请选中译文手动复制。', true);
    }
  };
  el<HTMLSelectElement>('language').onchange = async () => {
    try {
      const current = await send<Settings>({ type: 'GET_SETTINGS' });
      current.targetLanguage = el<HTMLSelectElement>('language').value;
      settings = await send({ type: 'SAVE_SETTINGS', settings: current });
      status('status', '目标语言已更新，可重译已有内容。');
    } catch (error) {
      status('status', errorText(error), true);
    }
  };
  el<HTMLInputElement>('discord-auto').onchange = async () => {
    const toggle = el<HTMLInputElement>('discord-auto');
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      await ensureContent();
      const currentChannel = await refreshDiscordContext();
      if (!currentChannel) throw new Error('请先打开一个 Discord 频道。');
      settings = await send({
        type: 'SET_DISCORD_AUTO',
        channel: currentChannel,
        enabled,
      });
      status('status', enabled ? '已开启此频道的自动翻译。' : '已关闭此频道的自动翻译。');
    } catch (error) {
      status('status', errorText(error), true);
    } finally {
      toggle.disabled = false;
      await refreshDiscordContext().catch(() => {});
    }
  };
  for (const [id, type] of [
    ['translate', 'TRANSLATE_PAGE'],
    ['restore', 'RESTORE_PAGE'],
  ] as const) {
    el<HTMLButtonElement>(id).onclick = async () => {
      const button = el<HTMLButtonElement>(id);
      button.disabled = true;
      try {
        await pageAction(type);
        reportPageProgress = type === 'TRANSLATE_PAGE';
        status(
          'status',
          type === 'TRANSLATE_PAGE'
            ? discord
              ? '已开始翻译可见消息。'
              : '已开始翻译，译文直接显示在原位置。'
            : discord
              ? '已移除消息译文。'
              : domain && settings.pageAutoDomains.includes(domain)
                ? '已显示原文；此页暂不自动翻译，刷新后按域名偏好继续。'
                : '已显示原文。',
        );
      } catch (error) {
        status('status', errorText(error), true);
      } finally {
        button.disabled = false;
      }
    };
  }
  el('test').onclick = async () => {
    reportPageProgress = false;
    const button = el<HTMLButtonElement>('test');
    button.disabled = true;
    status('status', '正在连接所选接口…');
    try {
      const result = await send<TranslationResult>({
        type: 'TEST_PROVIDER',
        providerId: providers.value,
      });
      status('status', '连接成功：' + result.text);
    } catch (error) {
      status('status', errorText(error), true);
    } finally {
      button.disabled = false;
    }
  };
}

el('open-settings').onclick = () => void chrome.runtime.openOptionsPage();
void main().catch((error) => status('status', errorText(error), true));
