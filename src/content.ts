import { collectDiscordMessages, readableText, shouldTranslate, splitText, visible } from './dom';
import { discordChannel, isDiscordHost } from './settings';
import { send } from './messaging';
import { detectSourceLanguage, sourceLanguageLabel } from './source-language';
import { PageTranslator, type PageOptions } from './page-translator';
import { DiscordDraft } from './discord-draft';
import { DiscordComposer } from './discord-composer';
import type { Message, PublicSettings, TranslationResult } from './types';

interface Entry {
  element: HTMLElement;
  original: string;
  host: HTMLElement;
  output: HTMLDivElement;
  select: HTMLSelectElement;
  button: HTMLButtonElement;
  status: HTMLSpanElement;
  providerId: string;
  version: number;
  busy: boolean;
  translated: boolean;
  queued: boolean;
  sourceHidden: boolean;
  sourceDisplay?: { value: string; priority: string };
}

const STYLE = `
:host{--ft-accent:#0b6b53;--ft-bg:#f3f8f5;--ft-text:#182d27;--ft-muted:#50695f;--ft-border:#c9dbd2;--ft-error:#b3312c;display:block;color:var(--ft-text);font:13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:start;letter-spacing:normal;color-scheme:light}
:host([data-theme=dark]){--ft-accent:#83d9b4;--ft-bg:#242c29;--ft-text:#eff7f2;--ft-muted:#b2c8bc;--ft-border:#43584c;--ft-error:#ffb3a9;color-scheme:dark}
*{box-sizing:border-box}button,select{font:inherit;color:inherit}button,select{border:1px solid var(--ft-border);background:var(--ft-bg);border-radius:6px;min-height:28px;padding:3px 8px;cursor:pointer}button:hover,select:hover{border-color:var(--ft-accent)}button:disabled{opacity:.6;cursor:wait}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--ft-accent);outline-offset:3px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.meta{font-size:11px;color:var(--ft-muted)}.entry{margin:7px 0 4px;padding:0 0 0 10px;border-left:2px solid var(--ft-border)}.entry select{max-width:180px}.output{white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0;color:var(--ft-text)}.output:empty{display:none}.error{color:var(--ft-error)}@media(prefers-reduced-motion:no-preference){button{transition:border-color 150ms,opacity 150ms}}
`;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text) result.textContent = text;
  return result;
}

function shadow(host: HTMLElement): ShadowRoot {
  host.dataset.flowUi = '';
  if (
    document.querySelector('.theme-dark,.theme-midnight,[data-theme="dark"]') ||
    matchMedia('(prefers-color-scheme: dark)').matches
  )
    host.dataset.theme = 'dark';
  const root = host.attachShadow({ mode: 'open' });
  const style = node('style');
  style.textContent = STYLE;
  root.append(style);
  return root;
}

class Translator {
  private runtime = chrome.runtime;
  private stopped = false;
  private events = new AbortController();
  private mutations?: MutationObserver;
  private scheduled?: ReturnType<typeof setTimeout>;
  private routeTimer?: ReturnType<typeof setInterval>;
  private messageListener?: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  private settings!: PublicSettings;
  private entries = new Map<HTMLElement, Entry>();
  private queue: { entry: Entry; automatic: boolean; force: boolean }[] = [];
  private running = false;
  private page?: PageTranslator;
  private channel = discordChannel(location.pathname);
  private discord = isDiscordHost(location.hostname);
  private epoch = 0;
  private progressHandlers = new Map<string, (text: string) => void>();
  private notice = '';
  private draft = new DiscordDraft();
  private composer?: DiscordComposer;
  private pageObserver = new IntersectionObserver(
    (items) => {
      for (const item of items) {
        const entry = this.entries.get(item.target as HTMLElement);
        if (item.isIntersecting && entry && !entry.translated && this.autoEnabled())
          this.enqueue(entry, this.discord);
      }
    },
    { rootMargin: '0px' },
  );

  async start(): Promise<void> {
    this.settings = await send<PublicSettings>({ type: 'GET_PUBLIC_SETTINGS' });
    if (this.stopped) return;
    // A reloaded extension leaves DOM behind; remove its inactive controls before mounting again.
    document
      .querySelectorAll(
        'flow-translation[data-flow-ui],flow-toolbar[data-flow-ui],flow-composer[data-flow-ui]',
      )
      .forEach((element) => element.remove());
    if (this.discord) this.composer = new DiscordComposer(this.settings, () => this.active);
    if (!this.discord)
      this.page = new PageTranslator(this.pageOptions(), (text, options, partial, current) =>
        this.translatePageText(text, options, partial, current),
      );
    this.messageListener = (message: Message, _sender, respond) => {
      if (!this.active) return false;
      if (this.syncChannel()) this.scan();
      if (message.type === 'TRANSLATION_PROGRESS') {
        this.progressHandlers.get(message.requestId)?.(message.text);
      } else if (message.type === 'GET_STATUS') {
        respond({
          discord: this.discord,
          channel: this.channel,
          auto: this.autoEnabled(),
          pageEnabled: this.page?.status.enabled ?? false,
          page: this.page?.status,
          notice: this.notice,
        });
      } else if (message.type === 'TRANSLATE_PAGE') {
        this.translatePage();
        respond({ ok: true });
      } else if (message.type === 'RESTORE_PAGE') {
        void this.restore();
        respond({ ok: true });
      } else if (message.type === 'TRANSLATE_SELECTION') {
        this.selection(message.text);
        respond({ ok: true });
      } else if (message.type === 'READ_DRAFT' || message.type === 'APPLY_DRAFT') {
        if (_sender.id !== this.runtime.id || !_sender.url?.startsWith(this.runtime.getURL(''))) {
          respond({ ok: false, error: '此操作仅限扩展弹窗。' });
        } else {
          void (async () => {
            if (!this.discord) throw new Error('请先打开 Discord。');
            const data =
              message.type === 'READ_DRAFT'
                ? this.draft.read()
                : await this.draft.apply(message.token, message.text);
            respond({ ok: true, data });
          })().catch((error) => {
            respond({
              ok: false,
              error: error instanceof Error ? error.message : '草稿操作失败。',
            });
          });
          return true;
        }
      } else if (message.type === 'SETTINGS_CHANGED') {
        this.applySettings(message.settings);
      }
      return false;
    };
    this.runtime.onMessage.addListener(this.messageListener);
    const scheduleScan = () => {
      if (!this.scheduled && this.active)
        this.scheduled = setTimeout(() => {
          this.scheduled = undefined;
          this.scan();
        }, 80);
    };
    this.mutations = new MutationObserver((records) => {
      const fromPage = records.some((record) => {
        if (record.target instanceof Element && record.target.closest('[data-flow-ui]'))
          return false;
        if (record.type === 'characterData')
          return (
            !this.page?.ownsMutation(record.target) &&
            !record.target.parentElement?.closest('[data-flow-ui]')
          );
        if (record.type === 'attributes')
          return !this.page?.ownsMutation(record.target, record.attributeName);
        return [...record.addedNodes, ...record.removedNodes].some(
          (item) => !(item instanceof Element && item.matches('[data-flow-ui]')),
        );
      });
      if (fromPage) scheduleScan();
    });
    this.mutations.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      ...(!this.discord
        ? {
            attributes: true,
            attributeFilter: [
              'hidden',
              'inert',
              'type',
              'aria-hidden',
              'contenteditable',
              'translate',
              'class',
              'style',
              'role',
              'lang',
              'placeholder',
              'title',
              'aria-selected',
              'aria-expanded',
              'open',
              'popover',
            ],
          }
        : {}),
    });
    document.addEventListener(
      'scroll',
      () => {
        if (this.page?.status.enabled || this.autoEnabled()) scheduleScan();
      },
      { capture: true, passive: true, signal: this.events.signal },
    );
    window.addEventListener('resize', scheduleScan, { signal: this.events.signal });
    if (!this.discord) {
      for (const event of ['click', 'keydown', 'pointerover', 'focusin'])
        document.addEventListener(
          event,
          (event) => {
            if (!event.isTrusted || !this.page?.status.enabled) return;
            if (event.type === 'pointerover' || event.type === 'focusin') {
              const control =
                event.target instanceof Element
                  ? event.target.closest(
                      'a,button,summary,input,textarea,[role="tab"],[role="button"]',
                    )
                  : null;
              if (!control) return;
              const previous = (event as MouseEvent | FocusEvent).relatedTarget;
              if (previous instanceof Node && control.contains(previous)) return;
            }
            if (
              event instanceof KeyboardEvent &&
              ![
                'Enter',
                ' ',
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
                'Home',
                'End',
              ].includes(event.key)
            )
              return;
            this.page.resumeAfterInteraction();
            scheduleScan();
          },
          { capture: true, signal: this.events.signal },
        );
      // Popover state and CSS :hover/:focus can change visibility without a DOM mutation.
      for (const event of ['toggle', 'mouseover'])
        document.addEventListener(
          event,
          () => {
            if (this.page?.status.enabled) scheduleScan();
          },
          { capture: true, passive: true, signal: this.events.signal },
        );
    }
    this.routeTimer = setInterval(() => {
      if (!this.active) {
        this.stop();
        return;
      }
      this.page?.checkNavigation();
      if (this.syncChannel()) this.scan();
      this.composer?.scan();
    }, 700);
    if (this.discord && this.channel) {
      this.scan();
    }
    if (!this.discord && this.settings.pageAutoDomains.includes(location.hostname))
      this.page?.start();
  }

  get active(): boolean {
    return !this.stopped && Boolean(this.runtime.id);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.epoch++;
    this.queue = [];
    clearTimeout(this.scheduled);
    clearInterval(this.routeTimer);
    this.events.abort();
    this.mutations?.disconnect();
    this.pageObserver.disconnect();
    this.page?.restore();
    this.clearEntries();
    this.draft.invalidate();
    this.composer?.stop();
    this.progressHandlers.clear();
    if (this.runtime.id && this.messageListener)
      this.runtime.onMessage.removeListener(this.messageListener);
  }

  private syncChannel(): boolean {
    if (!this.discord) return false;
    const next = discordChannel(location.pathname);
    if (next === this.channel) return false;
    this.epoch++;
    this.queue = [];
    this.clearEntries();
    this.channel = next;
    this.draft.invalidate();
    this.composer?.reset();
    this.setNotice(
      this.autoEnabled() ? '已开启此频道的自动翻译。' : '此频道未开启自动翻译，可逐条点击翻译。',
    );
    return true;
  }

  private pageOptions(): PageOptions {
    const provider = this.settings.providers.find(
      (item) => item.id === this.settings.activeProviderId,
    )!;
    return {
      providerId: provider.id,
      targetLanguage: this.settings.targetLanguage,
      configuration: JSON.stringify(provider),
    };
  }

  private async translatePageText(
    text: string,
    options: PageOptions,
    partial: (text: string) => void,
    current: () => boolean,
  ): Promise<string> {
    const port = chrome.runtime.connect({ name: 'flow-translation' });
    const keepAlive = setInterval(() => {
      try {
        port.postMessage({ alive: true });
      } catch {
        /* The request reports invalidation. */
      }
    }, 15_000);
    const outputs: string[] = [];
    try {
      for (const chunk of splitText(text)) {
        if (!current()) throw new Error('此翻译已取消。');
        const requestId = [...crypto.getRandomValues(new Uint32Array(4))]
          .map((value) => value.toString(16))
          .join('-');
        this.progressHandlers.set(requestId, (value) => {
          if (current()) partial([...outputs, value].join('\n\n'));
        });
        try {
          const result = await send<TranslationResult>({
            type: 'TRANSLATE',
            input: {
              text: chunk,
              source: 'page',
              automatic: this.settings.pageAutoDomains.includes(location.hostname),
              providerId: options.providerId,
              targetLanguage: options.targetLanguage,
              requestId,
            },
          });
          outputs.push(result.text);
        } finally {
          this.progressHandlers.delete(requestId);
        }
      }
      return outputs.join('\n\n');
    } finally {
      clearInterval(keepAlive);
      port.disconnect();
    }
  }

  private autoEnabled(): boolean {
    return (
      this.discord &&
      this.active &&
      this.channel === discordChannel(location.pathname) &&
      Boolean(this.channel && this.settings.discordAutoChannels.includes(this.channel))
    );
  }

  private applySettings(settings: PublicSettings): void {
    this.syncChannel();
    const providerChanged =
      this.settings.activeProviderId !== settings.activeProviderId ||
      this.settings.targetLanguage !== settings.targetLanguage;
    const wasAuto = this.autoEnabled();
    const wasPageAuto = this.settings.pageAutoDomains.includes(location.hostname);
    this.settings = settings;
    this.composer?.configure(settings);
    this.page?.configure(this.pageOptions());
    const pageAuto = settings.pageAutoDomains.includes(location.hostname);
    if (wasPageAuto !== pageAuto) {
      if (pageAuto) this.page?.start();
      else this.page?.restore();
    }
    if (providerChanged || (wasAuto && !this.autoEnabled())) {
      this.epoch++;
      this.queue.forEach((task) => {
        task.entry.queued = false;
      });
      this.queue = [];
    }
    for (const entry of this.entries.values()) {
      if (
        providerChanged ||
        !settings.providers.some((provider) => provider.id === entry.providerId)
      )
        entry.providerId = settings.activeProviderId;
      this.fillProviders(entry.select, entry.providerId);
      this.entryVisibility(entry);
    }
    this.scan();
  }

  private fillProviders(
    select: HTMLSelectElement,
    selected = this.settings.activeProviderId,
  ): void {
    const signature = this.settings.providers.map((p) => p.id + p.name).join('|');
    if (select.dataset.signature !== signature) {
      select.replaceChildren(
        ...this.settings.providers.map((provider) => {
          const option = node('option', provider.name);
          option.value = provider.id;
          return option;
        }),
      );
      select.dataset.signature = signature;
    }
    select.value = this.settings.providers.some((p) => p.id === selected)
      ? selected
      : this.settings.activeProviderId;
  }

  private scan(): void {
    if (!this.settings || !this.active) return;
    this.syncChannel();
    if (!this.discord) {
      this.page?.scan();
      return;
    }
    this.composer?.scan();
    for (const [element, entry] of this.entries) {
      if (!element.isConnected || !entry.host.isConnected) {
        entry.version++;
        this.pageObserver.unobserve(element);
        this.entryVisibility(entry, true);
        entry.host.remove();
        this.entries.delete(element);
      }
    }
    if (!this.channel) return;
    const candidates = collectDiscordMessages();
    for (const element of candidates) {
      const text = readableText(element);
      let entry = this.entries.get(element);
      if (entry && entry.original !== text) {
        entry.version++;
        entry.original = text;
        entry.translated = false;
        this.entryVisibility(entry);
        entry.output.textContent = '';
        entry.status.textContent = '消息已更新';
      }
      if (
        !shouldTranslate(
          text,
          this.settings.targetLanguage,
          element.closest('[lang]')?.getAttribute('lang') ?? undefined,
        )
      ) {
        if (entry) {
          entry.version++;
          this.entryVisibility(entry, true);
          entry.host.remove();
          this.entries.delete(element);
          this.pageObserver.unobserve(element);
        }
        continue;
      }
      if (!entry) entry = this.createEntry(element, text);
      if (this.autoEnabled() && visible(element) && !entry.translated) this.enqueue(entry, true);
    }
  }

  private createEntry(element: HTMLElement, text: string): Entry {
    const host = document.createElement('flow-translation');
    const root = shadow(host);
    const block = node('div');
    block.className = 'entry';
    const row = node('div');
    row.className = 'row';
    const button = node('button', '翻译');
    button.type = 'button';
    const select = node('select');
    select.setAttribute('aria-label', '此条译文使用的接口');
    this.fillProviders(select, this.settings.activeProviderId);
    const status = node('span');
    status.className = 'meta';
    const output = node('div');
    output.className = 'output';
    output.setAttribute('aria-live', 'polite');
    output.setAttribute('lang', this.settings.targetLanguage);
    row.append(button, select, status);
    block.append(row, output);
    root.append(block);
    element.after(host);
    const entry: Entry = {
      element,
      original: text,
      host,
      output,
      select,
      button,
      status,
      providerId: this.settings.activeProviderId,
      version: 0,
      busy: false,
      translated: false,
      queued: false,
      sourceHidden: false,
    };
    button.addEventListener('click', (event) => {
      if (event.isTrusted) this.enqueue(entry, false, entry.translated, true);
    });
    select.addEventListener('change', (event) => {
      if (
        !event.isTrusted ||
        !this.settings.providers.some((provider) => provider.id === select.value)
      ) {
        select.value = entry.providerId;
        return;
      }
      entry.providerId = select.value;
      this.enqueue(entry, false, true, true);
    });
    this.entries.set(element, entry);
    this.pageObserver.observe(element);
    return entry;
  }

  private enqueue(entry: Entry, automatic: boolean, force = false, priority = false): void {
    this.syncChannel();
    if (
      !this.active ||
      entry.busy ||
      !entry.element.isConnected ||
      this.entries.get(entry.element) !== entry
    )
      return;
    if (entry.queued) {
      if (priority) {
        const index = this.queue.findIndex((task) => task.entry === entry);
        if (index >= 0) this.queue.splice(index, 1);
        this.queue.unshift({ entry, automatic, force });
      }
      return;
    }
    entry.queued = true;
    entry.status.textContent = '等待翻译';
    const task = { entry, automatic, force };
    if (priority) this.queue.unshift(task);
    else this.queue.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let port: chrome.runtime.Port | undefined;
    try {
      port = chrome.runtime.connect({ name: 'flow-translation' });
    } catch {
      /* The visible request below reports an invalidated extension. */
    }
    const keepAlive = setInterval(() => {
      try {
        port?.postMessage({ alive: true });
      } catch {
        /* Pending requests surface disconnection. */
      }
    }, 15_000);
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        task.entry.queued = false;
        if (task.automatic && (!this.autoEnabled() || !visible(task.entry.element))) {
          task.entry.status.textContent = '';
          continue;
        }
        if (this.entries.get(task.entry.element) !== task.entry || !task.entry.host.isConnected)
          continue;
        await this.translateEntry(task.entry, task.automatic, task.force);
      }
    } finally {
      clearInterval(keepAlive);
      port?.disconnect();
      this.running = false;
    }
  }

  private async translateEntry(
    entry: Entry,
    automatic: boolean,
    bypassCache: boolean,
  ): Promise<void> {
    const epoch = this.epoch;
    const channel = this.channel;
    const version = ++entry.version;
    const current = () =>
      this.active &&
      epoch === this.epoch &&
      version === entry.version &&
      channel === discordChannel(location.pathname) &&
      entry.host.isConnected;
    const original = entry.original;
    entry.busy = true;
    entry.translated = false;
    this.entryVisibility(entry);
    entry.button.disabled = true;
    entry.select.disabled = true;
    entry.output.classList.remove('error');
    entry.status.textContent = '正在翻译…';
    try {
      const sourceLanguage = sourceLanguageLabel(await detectSourceLanguage(original));
      const chunks = splitText(original);
      const outputs: string[] = [];
      let result: TranslationResult | undefined;
      for (const [index, text] of chunks.entries()) {
        if (!current()) return;
        entry.status.textContent =
          `${sourceLanguage} · ` +
          (chunks.length > 1 ? `正在翻译 ${index + 1}/${chunks.length}` : '正在翻译…');
        const requestId = [...crypto.getRandomValues(new Uint32Array(4))]
          .map((value) => value.toString(16))
          .join('-');
        this.progressHandlers.set(requestId, (partial) => {
          if (current()) {
            entry.output.textContent = [...outputs, partial].join('\n\n');
          }
        });
        try {
          result = await send<TranslationResult>({
            type: 'TRANSLATE',
            input: {
              text,
              source: this.discord ? 'discord' : 'page',
              providerId: entry.providerId,
              channel: channel ?? undefined,
              automatic,
              bypassCache,
              requestId,
            },
          });
        } finally {
          this.progressHandlers.delete(requestId);
        }
        if (!current()) return;
        outputs.push(result.text);
        entry.output.textContent = outputs.join('\n\n');
      }
      entry.translated = true;
      entry.button.textContent = '重新翻译';
      entry.status.textContent = `识别为：${sourceLanguage}`;
      this.entryVisibility(entry);
      this.setNotice('翻译已完成，可在消息旁切换接口重译。');
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : '翻译失败，请重试。';
      entry.output.textContent = message;
      entry.output.classList.add('error');
      entry.status.textContent = '未完成';
      entry.button.textContent = '重试';
      if (automatic && channel) {
        await send({ type: 'SET_DISCORD_AUTO', channel, enabled: false }).catch(() => {});
        if (channel === discordChannel(location.pathname))
          this.setNotice('自动翻译已暂停：' + message);
      } else {
        this.setNotice(message);
      }
    } finally {
      entry.busy = false;
      entry.button.disabled = false;
      entry.select.disabled = false;
      // Edits arriving during a request invalidate its result and need a new pass.
      if (epoch !== this.epoch) {
        if (!entry.output.classList.contains('error')) entry.output.textContent = '';
        entry.status.textContent = '设置已更新，可重新翻译';
      }
      if (!current()) setTimeout(() => this.scan(), 0);
    }
  }

  private translatePage(): void {
    if (this.discord) {
      this.scan();
      for (const entry of this.entries.values())
        if (visible(entry.element) && !entry.translated) this.enqueue(entry, false);
      this.setNotice(
        this.entries.size
          ? '正在翻译当前可见消息，原文会保留。'
          : '还没有找到可翻译的消息，请先打开一个文字频道。',
      );
    } else {
      this.page?.start();
    }
  }

  private selection(text: string): void {
    if (!this.discord) {
      const selection = getSelection();
      if (selection?.rangeCount) this.page?.selection(selection.getRangeAt(0).cloneRange());
      return;
    }
    const range = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0) : null;
    const anchor = range?.commonAncestorContainer;
    const element =
      (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest<HTMLElement>(
        'p,li,div,article',
      ) ?? document.body;
    const previous = this.entries.get(element);
    if (previous) {
      previous.version++;
      this.entryVisibility(previous, true);
      previous.host.remove();
      this.pageObserver.unobserve(element);
    }
    const entry = this.createEntry(element, text);
    if (element === document.body) {
      document.body.append(entry.host);
      entry.host.style.cssText =
        'position:fixed;right:24px;top:24px;max-width:440px;max-height:60vh;overflow:auto;z-index:2147483646';
    }
    this.enqueue(entry, false);
  }

  private clearEntries(): void {
    for (const entry of this.entries.values()) {
      entry.version++;
      this.pageObserver.unobserve(entry.element);
      this.entryVisibility(entry, true);
      entry.host.remove();
    }
    this.entries.clear();
  }

  private async restore(): Promise<void> {
    this.page?.restore();
    this.epoch++;
    this.queue = [];
    this.clearEntries();
    if (this.autoEnabled() && this.channel)
      await send({ type: 'SET_DISCORD_AUTO', channel: this.channel, enabled: false }).catch(
        () => {},
      );
    this.setNotice('译文已移除，原文保持不变。');
    if (this.discord) this.scan();
  }

  private entryVisibility(entry: Entry, restore = false): void {
    const hide =
      !restore && entry.translated && this.settings.discordDisplayMode === 'translation-only';
    if (hide && !entry.sourceHidden && !entry.element.hidden) {
      entry.sourceDisplay = {
        value: entry.element.style.getPropertyValue('display'),
        priority: entry.element.style.getPropertyPriority('display'),
      };
      entry.element.hidden = true;
      entry.element.style.setProperty('display', 'none', 'important');
      entry.sourceHidden = true;
    } else if (!hide && entry.sourceHidden) {
      entry.element.hidden = false;
      if (
        entry.element.style.getPropertyValue('display') === 'none' &&
        entry.element.style.getPropertyPriority('display') === 'important'
      ) {
        if (entry.sourceDisplay?.value)
          entry.element.style.setProperty(
            'display',
            entry.sourceDisplay.value,
            entry.sourceDisplay.priority,
          );
        else entry.element.style.removeProperty('display');
      }
      entry.sourceDisplay = undefined;
      entry.sourceHidden = false;
    }
  }

  private setNotice(text: string): void {
    this.notice = text;
  }
}

const global = window as typeof window & { __flowTranslate?: Translator | boolean };
const previous = global.__flowTranslate;
if (typeof previous !== 'object' || !previous.active) {
  if (typeof previous === 'object') previous.stop();
  const translator = new Translator();
  global.__flowTranslate = translator;
  void translator.start().catch(() => translator.stop());
}
