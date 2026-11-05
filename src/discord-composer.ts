import { DiscordDraft, draftEditors } from './discord-draft';
import { discordChannel, LANGUAGES } from './settings';
import { sourceLanguageLabel } from './source-language';
import { send } from './messaging';
import type { DraftSnapshot, PublicSettings, TranslationResult } from './types';

const STYLE = `
:host{all:initial;display:inline-flex;flex:none;align-self:center;margin:0 4px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--ft-bg:#fff;--ft-text:#182b24;--ft-muted:#53675c;--ft-line:#d7e0d8;--ft-soft:#eef3ef;--ft-accent:#146447;--ft-on-accent:#fff;--ft-error:#ad312d;color:var(--ft-text);color-scheme:light}
:host([data-theme=dark]){--ft-bg:#24262b;--ft-text:#f2f3f5;--ft-muted:#b5bac1;--ft-line:#44474e;--ft-soft:#303339;--ft-accent:#91d9b2;--ft-on-accent:#132b1c;--ft-error:#ffb5ab;color-scheme:dark}
:host([data-placement=fallback]){display:flex;justify-content:flex-end;margin:4px 8px}
*{box-sizing:border-box}button,textarea{font:inherit;color:inherit}button{border:0;border-radius:6px;background:transparent;cursor:pointer;padding:7px 10px;min-height:32px}button:hover{background:var(--ft-soft)}button:focus-visible,textarea:focus-visible{outline:2px solid var(--ft-accent);outline-offset:2px}button:disabled{opacity:.5;cursor:default}.trigger{white-space:nowrap;color:var(--interactive-normal,var(--ft-muted));font-size:12px}.trigger:hover,.trigger[aria-expanded=true]{color:var(--ft-accent);background:var(--background-modifier-hover,var(--ft-soft))}.panel{position:fixed;inset:auto;margin:0;padding:14px;width:min(350px,calc(100vw - 24px));max-height:min(440px,calc(100dvh - 24px));overflow:auto;border:1px solid var(--ft-line);border-radius:10px;background:var(--ft-bg);color:var(--ft-text);box-shadow:0 8px 28px #0004}.panel:popover-open{display:grid;gap:10px}.heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.heading h2{font:600 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0}.close{font-size:18px;padding:0;min-width:28px;min-height:28px;color:var(--ft-muted)}.hint,.status{margin:0;color:var(--ft-muted);font-size:12px;overflow-wrap:anywhere}.status:empty{display:none}.status[data-error=true]{color:var(--ft-error)}.output{width:100%;min-height:100px;max-height:220px;resize:vertical;white-space:pre-wrap;border:1px solid var(--ft-line);border-radius:6px;background:var(--ft-soft);padding:10px}.actions{display:flex;gap:8px}.primary{background:var(--ft-accent);color:var(--ft-on-accent)}.primary:hover{background:var(--ft-accent);filter:brightness(1.08)}.secondary{border:1px solid var(--ft-line)}.languages{display:grid;gap:2px}.languages button{text-align:start;display:flex;justify-content:space-between}.languages [aria-checked=true]{color:var(--ft-accent);background:var(--ft-soft)}.languages [aria-checked=true]::after{content:'✓'}[hidden]{display:none!important}
`;

interface Composer {
  editor: HTMLElement;
  host: HTMLElement;
  button: HTMLButtonElement;
  panel: HTMLElement;
  draft: DiscordDraft;
  revision: number;
  mode?: 'preview' | 'language';
  busy: boolean;
  applying: boolean;
  snapshot?: DraftSnapshot;
  result?: string;
  output?: HTMLTextAreaElement;
  status?: HTMLElement;
  apply?: HTMLButtonElement;
  copy?: HTMLButtonElement;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

function button(text: string): HTMLButtonElement {
  const element = node('button', text);
  element.type = 'button';
  return element;
}

function languageName(code: string): string {
  if (code === 'zh-CN') return '简体中文';
  if (code === 'zh-TW') return '繁体中文';
  return sourceLanguageLabel({ code, reliable: true });
}

function theme(host: HTMLElement): void {
  const dark = document.querySelector(
    '.theme-dark,.theme-midnight,[data-theme="dark"]:not([data-flow-ui])',
  );
  const light = document.querySelector('.theme-light,[data-theme="light"]:not([data-flow-ui])');
  host.dataset.theme =
    dark || (!light && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

export class DiscordComposer {
  private entries = new Map<HTMLElement, Composer>();
  private events = new AbortController();
  private channel = discordChannel(location.pathname);

  constructor(
    private settings: PublicSettings,
    private active: () => boolean,
  ) {
    document.addEventListener(
      'pointerdown',
      (event) => {
        for (const entry of this.entries.values())
          if (!event.composedPath().includes(entry.host)) this.close(entry);
      },
      { capture: true, signal: this.events.signal },
    );
    const reposition = () => {
      for (const entry of this.entries.values()) if (entry.mode) this.place(entry);
    };
    window.addEventListener('resize', reposition, { signal: this.events.signal });
    document.addEventListener('scroll', reposition, {
      capture: true,
      passive: true,
      signal: this.events.signal,
    });
  }

  configure(settings: PublicSettings): void {
    const changed =
      settings.outgoingTargetLanguage !== this.settings.outgoingTargetLanguage ||
      settings.activeProviderId !== this.settings.activeProviderId ||
      JSON.stringify(settings.providers) !== JSON.stringify(this.settings.providers);
    this.settings = settings;
    for (const entry of this.entries.values()) {
      if (changed) this.close(entry);
      this.label(entry);
    }
  }

  scan(): void {
    if (!this.active()) return;
    const channel = discordChannel(location.pathname);
    if (this.channel !== channel) {
      this.reset();
      this.channel = channel;
    }
    if (!channel) return;
    const editors = draftEditors();
    for (const [editor, entry] of this.entries) {
      theme(entry.host);
      if (!editors.includes(editor) || !entry.host.isConnected) {
        this.close(entry);
        entry.host.remove();
        this.entries.delete(editor);
      } else if (
        entry.snapshot &&
        !entry.applying &&
        !entry.draft.isCurrent(entry.snapshot.token)
      ) {
        this.invalidate(entry, '草稿已变化，请重新翻译。');
      }
    }
    for (const editor of editors) {
      if (this.entries.has(editor)) continue;
      const composer =
        editor.closest<HTMLElement>(
          '[class*="channelTextArea_"],[class*="channelTextArea-"],[data-discord-composer]',
        ) ?? editor.closest('form');
      if (!composer) continue;
      const actions = [
        ...composer.querySelectorAll<HTMLElement>(
          '[data-composer-actions],[class*="buttons_"],[class*="buttons-"]',
        ),
      ].find((element) => !element.closest('[data-flow-ui]') && !editor.contains(element));
      const entry = this.create(editor);
      entry.host.dataset.placement = actions ? 'actions' : 'fallback';
      if (actions) actions.prepend(entry.host);
      else composer.append(entry.host);
      this.entries.set(editor, entry);
    }
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      this.close(entry);
      entry.host.remove();
    }
    this.entries.clear();
  }

  stop(): void {
    this.events.abort();
    this.reset();
  }

  private label(entry: Composer): void {
    entry.button.textContent = entry.busy
      ? '翻译中…'
      : '翻译成' + languageName(this.settings.outgoingTargetLanguage);
    entry.button.setAttribute('aria-busy', String(entry.busy));
  }

  private invalidate(entry: Composer, notice?: string): void {
    entry.revision++;
    entry.snapshot = undefined;
    entry.result = undefined;
    entry.busy = false;
    entry.draft.invalidate();
    if (entry.output) {
      entry.output.value = '';
      entry.output.hidden = true;
    }
    if (entry.apply) entry.apply.disabled = true;
    if (entry.copy) entry.copy.disabled = true;
    if (notice && entry.mode === 'preview') this.status(entry, notice, true);
    this.label(entry);
  }

  private close(entry: Composer): void {
    if (!entry.mode) return;
    this.invalidate(entry);
    entry.mode = undefined;
    entry.panel.hidePopover();
    entry.button.setAttribute('aria-expanded', 'false');
  }

  private create(editor: HTMLElement): Composer {
    const host = document.createElement('flow-composer');
    host.dataset.flowUi = '';
    theme(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = node('style');
    style.textContent = STYLE;
    const trigger = button('');
    trigger.className = 'trigger';
    trigger.title = '左键翻译草稿；右键更换目标语言';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    const panel = node('section');
    panel.className = 'panel';
    panel.popover = 'manual';
    const entry: Composer = {
      editor,
      host,
      button: trigger,
      panel,
      draft: new DiscordDraft(),
      revision: 0,
      busy: false,
      applying: false,
    };
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.isTrusted && this.active() && !entry.busy) void this.translate(entry);
    });
    trigger.addEventListener('contextmenu', (event) => {
      if (!event.isTrusted || !this.active()) return;
      event.preventDefault();
      event.stopPropagation();
      this.languages(entry);
    });
    root.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (!event.isTrusted || !this.active()) return;
      const key = event as KeyboardEvent;
      if (key.key === 'Escape') {
        key.preventDefault();
        this.close(entry);
        trigger.focus();
      } else if (key.key === 'ContextMenu' || (key.shiftKey && key.key === 'F10')) {
        key.preventDefault();
        this.languages(entry);
      } else if (
        entry.mode === 'language' &&
        ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key.key)
      ) {
        key.preventDefault();
        const items = [...panel.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        const current = items.indexOf(root.activeElement as HTMLButtonElement);
        const next =
          key.key === 'Home'
            ? 0
            : key.key === 'End'
              ? items.length - 1
              : (current + (key.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    root.addEventListener('click', (event) => event.stopPropagation());
    root.append(style, trigger, panel);
    this.label(entry);
    return entry;
  }

  private open(entry: Composer, mode: 'preview' | 'language'): void {
    for (const other of this.entries.values()) this.close(other);
    entry.mode = mode;
    entry.panel.replaceChildren();
    entry.panel.setAttribute('role', mode === 'language' ? 'menu' : 'dialog');
    entry.panel.setAttribute('aria-label', mode === 'language' ? '发送目标语言' : '发送前翻译');
    entry.panel.style.width = mode === 'language' ? 'min(220px, calc(100vw - 24px))' : '';
    entry.button.setAttribute('aria-haspopup', mode === 'language' ? 'menu' : 'dialog');
    entry.button.setAttribute('aria-expanded', 'true');
    const heading = node('div');
    heading.className = 'heading';
    const close = button('×');
    close.className = 'close';
    close.setAttribute('aria-label', '关闭');
    close.onclick = (event) => {
      if (event.isTrusted) {
        this.close(entry);
        entry.button.focus();
      }
    };
    heading.append(
      node(
        'h2',
        mode === 'language'
          ? '翻译成哪种语言'
          : '翻译成' + languageName(this.settings.outgoingTargetLanguage),
      ),
      close,
    );
    entry.panel.append(heading);
    entry.panel.showPopover();
  }

  private place(entry: Composer): void {
    if (!entry.mode) return;
    const anchor = entry.button.getBoundingClientRect();
    const panel = entry.panel.getBoundingClientRect();
    entry.panel.style.left = `${Math.max(12, Math.min(anchor.right - panel.width, innerWidth - panel.width - 12))}px`;
    entry.panel.style.top = `${Math.max(12, Math.min(anchor.top - panel.height - 8, innerHeight - panel.height - 12))}px`;
  }

  private languages(entry: Composer): void {
    this.open(entry, 'language');
    const list = node('div');
    list.className = 'languages';
    for (const [code] of LANGUAGES) {
      const item = button(languageName(code));
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-label', languageName(code));
      item.setAttribute('aria-checked', String(code === this.settings.outgoingTargetLanguage));
      item.tabIndex = code === this.settings.outgoingTargetLanguage ? 0 : -1;
      item.onclick = async (event) => {
        if (!event.isTrusted || !this.active()) return;
        list.querySelectorAll('button').forEach((button) => {
          button.disabled = true;
        });
        try {
          this.configure(
            await send<PublicSettings>({
              type: 'SET_OUTGOING_LANGUAGE',
              language: code,
              channel: discordChannel(location.pathname) ?? undefined,
            }),
          );
          this.close(entry);
          entry.button.focus();
        } catch (error) {
          this.status(entry, error instanceof Error ? error.message : '保存语言失败。', true);
          list.querySelectorAll('button').forEach((button) => {
            button.disabled = false;
          });
        }
      };
      list.append(item);
    }
    entry.status = node('p');
    entry.status.className = 'status';
    entry.status.setAttribute('role', 'status');
    entry.panel.append(list, entry.status);
    this.place(entry);
    list.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }

  private status(entry: Composer, text: string, error = false): void {
    if (!entry.status) return;
    entry.status.textContent = text;
    entry.status.dataset.error = String(error);
    this.place(entry);
  }

  private async translate(entry: Composer): Promise<void> {
    this.open(entry, 'preview');
    const revision = ++entry.revision;
    entry.busy = true;
    this.label(entry);
    const output = node('textarea');
    output.className = 'output';
    output.readOnly = true;
    output.hidden = true;
    output.setAttribute('aria-label', '发送前译文');
    entry.output = output;
    const apply = button('替换草稿');
    apply.className = 'primary';
    apply.disabled = true;
    const copy = button('复制译文');
    copy.className = 'secondary';
    copy.disabled = true;
    entry.apply = apply;
    entry.copy = copy;
    const actions = node('div');
    actions.className = 'actions';
    actions.append(apply, copy);
    entry.status = node('p');
    entry.status.className = 'status';
    entry.status.setAttribute('role', 'status');
    entry.status.setAttribute('aria-live', 'polite');
    entry.panel.append(output, actions, entry.status);
    this.status(entry, '正在翻译当前草稿…');
    let port: chrome.runtime.Port | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const current = () =>
      this.active() &&
      entry.host.isConnected &&
      entry.revision === revision &&
      this.channel === discordChannel(location.pathname);
    try {
      entry.snapshot = entry.draft.read(entry.editor);
      port = chrome.runtime.connect({ name: 'flow-translation' });
      keepAlive = setInterval(() => {
        try {
          port?.postMessage({ alive: true });
        } catch {
          /* The request reports disconnection. */
        }
      }, 15_000);
      const result = await send<TranslationResult>({
        type: 'TRANSLATE',
        input: {
          source: 'draft',
          text: entry.snapshot.text,
          channel: entry.snapshot.channel,
          providerId: this.settings.activeProviderId,
          targetLanguage: this.settings.outgoingTargetLanguage,
        },
      });
      if (!current()) return;
      if (!entry.draft.isCurrent(entry.snapshot.token)) {
        this.invalidate(entry, '频道或草稿已变化，请重新翻译。');
        return;
      }
      entry.result = result.text;
      output.value = result.text;
      output.hidden = false;
      apply.disabled = !entry.snapshot.canReplace;
      copy.disabled = false;
      this.status(
        entry,
        entry.snapshot.canReplace
          ? '检查译文后替换草稿，再自行发送。'
          : '草稿包含提及或特殊内容，请复制译文后手动编辑。',
      );
      output.focus();
    } catch (error) {
      if (current())
        this.status(entry, error instanceof Error ? error.message : '翻译失败，请重试。', true);
    } finally {
      clearInterval(keepAlive);
      port?.disconnect();
      if (current()) {
        entry.busy = false;
        this.label(entry);
      }
    }
    apply.onclick = async (event) => {
      if (!event.isTrusted || !this.active() || !entry.snapshot || !entry.result || entry.applying)
        return;
      entry.applying = true;
      apply.disabled = true;
      try {
        await entry.draft.apply(entry.snapshot.token, entry.result);
        if (current()) this.close(entry);
      } catch (error) {
        if (current())
          this.invalidate(entry, error instanceof Error ? error.message : '无法替换草稿。');
      } finally {
        entry.applying = false;
      }
    };
    copy.onclick = async (event) => {
      if (!event.isTrusted || !this.active() || !entry.result) return;
      try {
        await navigator.clipboard.writeText(entry.result);
        if (current()) this.status(entry, '译文已复制，可手动粘贴。');
      } catch {
        if (current()) this.status(entry, '复制失败，请选中译文手动复制。', true);
      }
    };
  }
}
