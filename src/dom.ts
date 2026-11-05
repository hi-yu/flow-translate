export const FLOW_HOST = '[data-flow-ui]';
const IGNORED =
  'script,style,noscript,code,pre,textarea,input,select,button,svg,nav,header,footer,[contenteditable]:not([contenteditable="false"]),[aria-hidden="true"],[translate="no"],[data-flow-ui]';

export function readableText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll(IGNORED).forEach((node) => node.remove());
  return (copy.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

export function shouldTranslate(text: string, target: string, sourceHint?: string): boolean {
  const prose = text.replace(/https?:\/\/\S+|www\.\S+|<@!?\d+>|@[\p{L}\p{N}_]+/gu, '');
  if (text.length < 2 || !/\p{L}/u.test(prose)) return false;
  if (target.startsWith('zh'))
    return (
      /\p{L}/u.test(prose.replace(/\p{Script=Han}/gu, '')) || sourceHint?.split('-')[0] === 'ja'
    );
  return true;
}

export function collectDiscordMessages(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[id^="message-content-"]')].filter((element) => {
    return (
      !element.closest(FLOW_HOST) &&
      Boolean(element.closest('[id^="chat-messages-"],[data-list-item-id^="chat-messages"]'))
    );
  });
}

export function splitText(text: string, maxLength = 1400): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLength) {
    let end = Math.max(
      rest.lastIndexOf('\n', maxLength),
      rest.lastIndexOf('. ', maxLength),
      rest.lastIndexOf('。', maxLength),
    );
    if (end < maxLength / 3) end = rest.lastIndexOf(' ', maxLength);
    if (end < maxLength / 3) end = maxLength;
    else end += 1;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1] ?? '')) end--;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.top <= window.innerHeight &&
    rect.right >= 0 &&
    rect.left <= window.innerWidth
  );
}
