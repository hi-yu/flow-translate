import { beforeEach, describe, expect, it } from 'vitest';
import { collectDiscordMessages, readableText, shouldTranslate, splitText } from '../../src/dom';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('page and Discord extraction', () => {
  it('only extracts Discord message bodies, not users or the composer', () => {
    document.body.innerHTML =
      '<li id="chat-messages-10-20"><h3>Ada</h3><div id="message-content-20">Hello <span>@Lin</span><code>const token = 1</code></div></li><div id="message-content-unrelated">Not a message</div><div contenteditable="true">Private draft</div>';
    const messages = collectDiscordMessages();
    expect(messages).toHaveLength(1);
    expect(readableText(messages[0]!)).toBe('Hello @Lin');
  });
  it('skips Chinese-only messages and standalone URLs for English to Chinese', () => {
    expect(shouldTranslate('已经完成了。', 'zh-CN')).toBe(false);
    expect(shouldTranslate('https://example.com/path', 'zh-CN')).toBe(false);
    expect(shouldTranslate('Please check @Lin’s changes.', 'zh-CN')).toBe(true);
    expect(shouldTranslate('已经完成 https://example.com @Lin', 'zh-CN')).toBe(false);
    expect(shouldTranslate('東京駅', 'zh-CN', 'ja')).toBe(true);
  });
  it.each([
    'こんにちは',
    '안녕하세요',
    'Привет всем',
    'مرحبا بالعالم',
    'สวัสดี',
    'ça',
    'Γεια σας',
    'नमस्ते',
  ])('accepts non-English text: %s', (text) => {
    expect(shouldTranslate(text, 'zh-CN')).toBe(true);
  });
  it('splits long content without losing text or breaking surrogate pairs', () => {
    const source = 'a'.repeat(1399) + '😀' + 'b'.repeat(3000);
    const chunks = splitText(source);
    expect(chunks.join('')).toBe(source);
    expect(chunks.every((chunk) => chunk.length <= 1400 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(
      true,
    );
  });
});
