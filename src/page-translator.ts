import { visible } from './dom';
import {
  collectPageText,
  collectPageAttributes,
  pageTextEligible,
  PageText,
  PageAttribute,
  PageValue,
  PAGE_TOOLTIP,
} from './page-dom';

export interface PageOptions {
  providerId: string;
  targetLanguage: string;
  configuration: string;
}

export interface PageTranslationStatus {
  enabled: boolean;
  translated: number;
  pending: number;
  skipped: number;
  error?: string;
}

type Translate = (
  text: string,
  options: PageOptions,
  partial: (text: string) => void,
  current: () => boolean,
) => Promise<string>;

export class PageTranslator {
  private records = new Map<Text | Attr, PageValue>();
  private queue: PageValue[] = [];
  private running = false;
  private mode: 'page' | 'selection' | null = null;
  private epoch = 0;
  private url = this.urlKey();
  private error?: string;
  private lastScan = 0;

  constructor(
    private options: PageOptions,
    private translate: Translate,
  ) {}

  get status(): PageTranslationStatus {
    const entries = [...this.records.values()];
    return {
      enabled: this.mode !== null,
      translated: entries.filter((entry) => entry.translated).length,
      pending: entries.filter((entry) => entry.queued || entry.busy).length,
      skipped: entries.filter((entry) => entry.skipped).length,
      error: this.error,
    };
  }

  get translatingPage(): boolean {
    return this.mode === 'page';
  }

  configure(options: PageOptions): void {
    const changed = JSON.stringify(options) !== JSON.stringify(this.options);
    this.options = options;
    if (changed && this.mode) {
      const wasPage = this.mode === 'page';
      this.restore();
      if (wasPage) this.start();
    }
  }

  start(): void {
    this.restore();
    this.mode = 'page';
    this.url = this.urlKey();
    this.error = undefined;
    this.scan();
  }

  selection(range: Range): void {
    if (range.collapsed) return;
    const selected = collectPageText(document.body, this.options.targetLanguage)
      .filter((node) => range.intersectsNode(node))
      .map((node) => ({
        node,
        start: range.startContainer === node ? range.startOffset : 0,
        end: range.endContainer === node ? range.endOffset : node.length,
      }))
      .filter(
        ({ node, start, end }) =>
          start < end &&
          pageTextEligible(node, this.options.targetLanguage, node.data.slice(start, end)),
      );
    this.epoch++;
    this.clearQueue();
    this.mode = 'selection';
    this.url = this.urlKey();
    this.error = undefined;
    for (const { node, start, end } of selected) {
      let record = this.records.get(node);
      if (record) {
        record.refresh();
        record.select(start, end);
      } else {
        record = new PageText(node, start, end);
        this.records.set(node, record);
      }
      this.enqueue(record);
    }
    if (!selected.length) this.error = '请选择正文文字；输入框、代码和资源标识不会被修改。';
  }

  ownsMutation(node: Node, attributeName?: string | null): boolean {
    if (node instanceof Text) return this.records.get(node)?.current === node.data;
    if (node instanceof HTMLElement && attributeName) {
      const attribute = node.getAttributeNode(attributeName);
      return Boolean(attribute && this.records.get(attribute)?.current === attribute.value);
    }
    return false;
  }

  checkNavigation(): void {
    if (this.mode && this.url !== this.urlKey()) {
      const wasPage = this.mode === 'page';
      this.restore();
      if (wasPage) this.start();
    }
  }

  resumeAfterInteraction(): void {
    if (this.mode !== 'page') return;
    for (const record of this.records.values()) {
      record.conflicts = 0;
      record.skipped = false;
    }
  }

  scan(): void {
    if (!this.mode) return;
    this.checkNavigation();
    if (!this.mode) return;
    this.lastScan = Date.now();
    for (const [node, record] of this.records) {
      if (
        !record.connected ||
        !record.eligible(
          this.options.targetLanguage,
          record.matches() ? record.original : undefined,
        )
      ) {
        // Dialogs can mark the still-visible background aria-hidden/inert. Keep existing translations.
        if (record.matches() && record.eligible(this.options.targetLanguage, record.original, true))
          continue;
        record.restore();
        this.records.delete(node);
        continue;
      }
      if (record.refresh() && this.mode === 'selection') record.skipped = true;
      if (this.mode === 'page' && visible(record.parent)) this.enqueue(record);
    }
    if (this.mode === 'page') {
      for (const node of collectPageText(document.body, this.options.targetLanguage)) {
        if (this.records.has(node) || !visible(node.parentElement!)) continue;
        const record = new PageText(node);
        this.records.set(node, record);
        this.enqueue(record);
      }
      for (const attribute of collectPageAttributes(document.body, this.options.targetLanguage)) {
        if (this.records.has(attribute) || !visible(attribute.ownerElement!)) continue;
        const record = new PageAttribute(attribute);
        this.records.set(attribute, record);
        this.enqueue(record);
      }
    }
  }

  restore(): void {
    this.epoch++;
    this.mode = null;
    this.error = undefined;
    this.clearQueue();
    for (const record of this.records.values()) record.restore();
    this.records.clear();
  }

  private clearQueue(): void {
    for (const record of this.queue) record.queued = false;
    this.queue = [];
  }

  private enqueue(record: PageValue): void {
    if (!record.source || record.busy || record.translated || record.skipped) return;
    const tooltip = Boolean(record.parent.closest(PAGE_TOOLTIP));
    if (record.queued) {
      if (tooltip) {
        const index = this.queue.indexOf(record);
        if (index > 0) {
          this.queue.splice(index, 1);
          this.queue.unshift(record);
        }
      }
      return;
    }
    record.queued = true;
    if (tooltip) this.queue.unshift(record);
    else this.queue.push(record);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const record = this.queue.shift()!;
        record.queued = false;
        if (!this.mode || this.records.get(record.node) !== record || !record.matches()) continue;
        if (this.mode === 'page' && !visible(record.parent)) continue;
        const epoch = this.epoch,
          version = record.version,
          options = this.options;
        const current = () =>
          this.epoch === epoch &&
          this.url === this.urlKey() &&
          this.records.get(record.node) === record &&
          record.version === version &&
          record.matches() &&
          record.eligible(options.targetLanguage, record.original);
        const stream =
          record instanceof PageText &&
          Boolean(record.parent.closest('p,h1,h2,h3,h4,h5,h6,blockquote')) &&
          !record.parent.closest(PAGE_TOOLTIP) &&
          !record.parent.closest('a,button,label,[role="button"],table,nav');
        record.busy = true;
        try {
          const translated = await this.translate(
            record.source,
            options,
            (partial) => {
              if (stream && current()) record.write(partial);
            },
            current,
          );
          if (current()) {
            record.write(translated);
            record.translated = true;
          }
        } catch (error) {
          if (current()) {
            record.restore();
            this.error = error instanceof Error ? error.message : '翻译失败，请重试。';
            this.mode = null;
            this.clearQueue();
            this.epoch++;
          }
        } finally {
          record.busy = false;
        }
        if (
          this.mode &&
          (record.version !== version || !record.matches() || Date.now() - this.lastScan >= 250)
        )
          this.scan();
      }
    } finally {
      this.running = false;
    }
  }

  private urlKey(): string {
    return location.origin + location.pathname + location.search;
  }
}
