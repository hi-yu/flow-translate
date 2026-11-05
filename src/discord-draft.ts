import { discordChannel } from './settings';
import { visible } from './dom';
import type { DraftSnapshot } from './types';

const EDITOR =
  '[role="textbox"][contenteditable="true"][data-slate-editor="true"],form [role="textbox"][contenteditable="true"][aria-multiline="true"]';
const SPECIAL = '[data-slate-void="true"],[contenteditable="false"],img';

export function draftEditors(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(EDITOR)].filter(
    (editor) =>
      visible(editor) &&
      !editor.closest('[id^="chat-messages-"],[data-list-item-id^="chat-messages"],[data-flow-ui]'),
  );
}

export function draftText(editor: HTMLElement): string {
  return editor.innerText.replace(/[\u200b\ufeff]/gu, '').replace(/\r\n/g, '\n');
}

export class DiscordDraft {
  private snapshot?: { editor: HTMLElement; html: string; value: DraftSnapshot };

  invalidate(): void {
    this.snapshot = undefined;
  }

  read(selectedEditor?: HTMLElement): DraftSnapshot {
    this.invalidate();
    const channel = discordChannel(location.pathname);
    if (!channel) throw new Error('请先打开一个 Discord 频道或私信。');
    const editors = draftEditors();
    const editor = selectedEditor
      ? editors.find((editor) => editor === selectedEditor)
      : (editors.find(
          (element) =>
            element === document.activeElement || element.contains(document.activeElement),
        ) ?? (editors.length === 1 ? editors[0] : undefined));
    if (!editor) throw new Error('请先点击 Discord 消息输入框并输入要翻译的草稿。');
    const text = draftText(editor);
    if (!text.trim()) throw new Error('输入框为空，请先输入要翻译的草稿。');
    if (text.length > 12000) throw new Error('草稿过长，请将内容缩短到 12000 字符以内。');
    const value = {
      token: crypto.randomUUID(),
      text,
      channel,
      canReplace: !editor.querySelector(SPECIAL),
    };
    this.snapshot = { editor, html: editor.innerHTML, value };
    return value;
  }

  isCurrent(token: string): boolean {
    const snapshot = this.snapshot;
    return Boolean(
      snapshot &&
        snapshot.value.token === token &&
        snapshot.editor.isConnected &&
        snapshot.value.channel === discordChannel(location.pathname) &&
        snapshot.editor.innerHTML === snapshot.html,
    );
  }

  async apply(token: string, text: string): Promise<void> {
    const snapshot = this.snapshot;
    const current = this.isCurrent(token);
    this.invalidate();
    if (!snapshot || !current) throw new Error('频道或草稿已变化，请重新翻译当前草稿。');
    if (!snapshot.value.canReplace || snapshot.editor.querySelector(SPECIAL))
      throw new Error('草稿包含提及或特殊内容，请复制译文后手动编辑。');
    if (typeof text !== 'string' || !text.trim() || text.length > 12000)
      throw new Error('译文为空或过长，无法替换草稿。');
    const editor = snapshot.editor;
    editor.focus();
    const selection = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    // Let Slate handle a normal paste input so its model, selection and undo history update together.
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const input = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste',
      dataTransfer: data,
      targetRanges: [
        new StaticRange({
          startContainer: range.startContainer,
          startOffset: range.startOffset,
          endContainer: range.endContainer,
          endOffset: range.endOffset,
        }),
      ],
    });
    editor.dispatchEvent(input);
    if (!input.defaultPrevented) {
      // Older editors handle plaintext paste instead of beforeinput.
      const paste = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      editor.dispatchEvent(paste);
      if (!paste.defaultPrevented) {
        if (editor.hasAttribute('data-slate-editor'))
          throw new Error('当前输入框未接受译文，请复制后手动粘贴。');
        // Plain editors use the browser's editing operation rather than manual DOM replacement.
        if (!document.execCommand('insertText', false, text))
          throw new Error('无法替换输入框，请复制译文后手动粘贴。');
      }
    }
    // Slate may schedule its render after the input handler returns.
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!editor.isConnected || discordChannel(location.pathname) !== snapshot.value.channel)
        break;
      if (draftText(editor) === text.replace(/\r\n/g, '\n')) return;
    }
    throw new Error('输入框未保留译文，请检查草稿或复制译文后手动粘贴。');
  }
}
