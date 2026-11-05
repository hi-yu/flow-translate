import { shouldTranslate, visible } from './dom';

export const PAGE_TOOLTIP = '[role="tooltip"],tool-tip,[data-component="Tooltip"]';

const EXCLUDED =
  'script,style,noscript,template,code,pre,kbd,samp,var,svg,math,canvas,iframe,object,embed,select,option,datalist,[contenteditable]:not([contenteditable="false"]),[role="listbox"],[role="option"],[translate="no"],.notranslate,[data-flow-ui],flow-translation,flow-toolbar';
const TEXT_EXCLUDED = 'input,textarea,[role="textbox"],[role="combobox"]';

export function pageTextEligible(
  node: Text,
  target: string,
  source = node.data,
  retainHidden = false,
): boolean {
  const parent = node.parentElement;
  return Boolean(
    parent &&
      !parent.closest(TEXT_EXCLUDED) &&
      pageSourceEligible(parent, target, source, retainHidden),
  );
}

function pageSourceEligible(
  parent: HTMLElement,
  target: string,
  source: string,
  retainHidden: boolean,
): boolean {
  if (parent.closest(EXCLUDED)) return false;
  if (!retainHidden && parent.closest('[hidden],[inert]')) return false;
  const hidden = parent.closest('[aria-hidden="true"]');
  // Primer keeps visible tooltip labels aria-hidden to avoid duplicate screen-reader announcements.
  if (
    !retainHidden &&
    hidden &&
    (!hidden.matches(PAGE_TOOLTIP) ||
      hidden.parentElement?.closest('[aria-hidden="true"]') ||
      !visible(hidden))
  )
    return false;
  const text = source.trim();
  // Keep resource identifiers and machine values stable in consoles such as AWS.
  if (/^(?:arn:[^\s]+|[\w.:/@-]*\d[\w.:/@-]*|[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)$/u.test(text))
    return false;
  return shouldTranslate(text, target, parent.closest('[lang]')?.getAttribute('lang') ?? undefined);
}

export function pageAttributeEligible(
  node: Attr,
  target: string,
  source = node.value,
  retainHidden = false,
): boolean {
  const element = node.ownerElement;
  if (!(element instanceof HTMLElement)) return false;
  if (node.name !== 'title' && node.name !== 'placeholder') return false;
  if (
    element instanceof HTMLInputElement &&
    !['text', 'search', 'url', 'tel', 'email', 'number'].includes(element.type)
  )
    return false;
  if (
    node.name === 'placeholder' &&
    !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
  )
    return false;
  return pageSourceEligible(element, target, source, retainHidden);
}

export function collectPageAttributes(root: HTMLElement, target: string): Attr[] {
  const attributes: Attr[] = [];
  for (const element of [
    root,
    ...root.querySelectorAll<HTMLElement>('[title],input[placeholder],textarea[placeholder]'),
  ]) {
    for (const name of ['title', 'placeholder'] as const) {
      const attribute = element.getAttributeNode(name);
      if (attribute && pageAttributeEligible(attribute, target)) attributes.push(attribute);
    }
  }
  return attributes;
}

export function collectPageText(root: Node, target: string): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      pageTextEligible(node as Text, target) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const result: Text[] = [];
  while (walker.nextNode()) result.push(walker.currentNode as Text);
  return result;
}

/** Text and display attributes share the same source, stale-result and restoration guards. */
export abstract class PageValue {
  abstract readonly node: Text | Attr;
  abstract get connected(): boolean;
  abstract eligible(target: string, source?: string, retainHidden?: boolean): boolean;
  protected abstract read(): string;
  protected abstract replace(text: string): void;
  protected abstract currentParent(): HTMLElement | null;
  original: string;
  current: string;
  source = '';
  prefix = '';
  suffix = '';
  parent: HTMLElement;
  version = 0;
  queued = false;
  busy = false;
  translated = false;
  conflicts = 0;
  skipped = false;

  constructor(value: string, parent: HTMLElement) {
    this.original = this.current = value;
    this.parent = parent;
  }

  select(start: number, end: number): void {
    const value = this.read();
    const body = value.slice(start, end);
    const leading = body.match(/^\s*/u)![0];
    const trailing = body.match(/\s*$/u)![0];
    this.prefix = value.slice(0, start) + leading;
    this.source = body.trim();
    this.suffix = trailing + value.slice(end);
    this.current = value;
    this.version++;
    this.translated = false;
    this.skipped = false;
  }

  matches(): boolean {
    return this.connected && this.currentParent() === this.parent && this.read() === this.current;
  }

  refresh(): boolean {
    if (this.read() === this.current && this.currentParent() === this.parent) return false;
    const overwritten = this.current !== this.original && this.read() === this.original;
    this.conflicts = overwritten ? this.conflicts + 1 : 0;
    if (this.currentParent() !== this.parent) this.restore();
    this.original = this.current = this.read();
    this.parent = this.currentParent()!;
    this.select(0, this.read().length);
    // Pause repeated render loops until a new user interaction grants another attempt.
    this.skipped = this.conflicts >= 2;
    return true;
  }

  write(text: string): boolean {
    if (!this.matches()) return false;
    this.current = this.prefix + text + this.suffix;
    if (this.read() !== this.current) this.replace(this.current);
    return true;
  }

  restore(): void {
    if (this.read() !== this.current) this.original = this.read();
    else if (this.current !== this.original) this.replace(this.original);
    this.select(0, this.read().length);
  }
}

/** Retain the actual Text object: framework refs, child elements and event listeners stay intact. */
export class PageText extends PageValue {
  constructor(
    readonly node: Text,
    start = 0,
    end = node.length,
  ) {
    super(node.data, node.parentElement!);
    this.select(start, end);
  }
  get connected(): boolean {
    return this.node.isConnected;
  }
  eligible(target: string, source = this.node.data, retainHidden = false): boolean {
    return pageTextEligible(this.node, target, source, retainHidden);
  }
  protected read(): string {
    return this.node.data;
  }
  protected replace(text: string): void {
    this.node.data = text;
  }
  protected currentParent(): HTMLElement | null {
    return this.node.parentElement;
  }
}

/** Modify only author-supplied hints; never read or write an input's value. */
export class PageAttribute extends PageValue {
  constructor(readonly node: Attr) {
    super(node.value, node.ownerElement as HTMLElement);
    this.select(0, node.value.length);
  }
  get connected(): boolean {
    const owner = this.node.ownerElement;
    return Boolean(owner?.isConnected && owner.getAttributeNode(this.node.name) === this.node);
  }
  eligible(target: string, source = this.node.value, retainHidden = false): boolean {
    return pageAttributeEligible(this.node, target, source, retainHidden);
  }
  protected read(): string {
    return this.node.value;
  }
  protected replace(text: string): void {
    if (this.node.ownerElement?.getAttributeNode(this.node.name) === this.node)
      this.node.value = text;
  }
  protected currentParent(): HTMLElement | null {
    return this.node.ownerElement as HTMLElement | null;
  }
}
