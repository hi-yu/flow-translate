import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectPageText,
  collectPageAttributes,
  PageText,
  PageAttribute,
} from '../../src/page-dom';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('in-place webpage text', () => {
  it('collects only display hints and keeps input values and functional attributes intact', () => {
    document.body.innerHTML =
      '<input id="title" placeholder="Title" title="Rename view" value="private draft"><textarea placeholder="Add a description">private description</textarea><input type="password" placeholder="Private hint"><input type="hidden" title="Private source"><input placeholder="No translation" translate="no"><div contenteditable title="Private editor"></div><button aria-label="Functional label">继续</button>';
    const input = document.querySelector<HTMLInputElement>('#title')!;
    const attributes = collectPageAttributes(document.body, 'zh-CN');
    expect(attributes.map((attribute) => attribute.value)).toEqual([
      'Rename view',
      'Title',
      'Add a description',
    ]);
    const original = attributes[1]!;
    const entry = new PageAttribute(original);
    entry.write('标题');
    expect(input.getAttributeNode('placeholder')).toBe(original);
    expect(input.placeholder).toBe('标题');
    expect(input.value).toBe('private draft');
    expect(input.id).toBe('title');
    expect(document.querySelector('button')!.getAttribute('aria-label')).toBe('Functional label');
    entry.restore();
    expect(input.placeholder).toBe('Title');
  });

  it('preserves replaced, removed and updated attributes when results or restoration arrive later', () => {
    document.body.innerHTML = '<input placeholder="Title">';
    const input = document.querySelector('input')!;
    const entry = new PageAttribute(input.getAttributeNode('placeholder')!);
    entry.write('标题');
    input.placeholder = 'New title';
    expect(entry.write('旧结果')).toBe(false);
    entry.restore();
    expect(input.placeholder).toBe('New title');
    entry.write('新标题');
    input.removeAttribute('placeholder');
    expect(entry.connected).toBe(false);
    entry.restore();
    expect(input.hasAttribute('placeholder')).toBe(false);
    input.placeholder = 'Latest title';
    expect(entry.matches()).toBe(false);
    entry.restore();
    expect(input.placeholder).toBe('Latest title');
  });
  it('includes visible tooltip labels with aria-hidden while respecting all other opt-outs', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 20,
      top: 0,
      bottom: 20,
      left: 0,
      right: 100,
    } as DOMRect);
    document.body.innerHTML = `
      <span data-component="Tooltip" aria-hidden="true">All repositories</span>
      <span role="tooltip" aria-hidden="true">Show details</span>
      <tool-tip aria-hidden="true">Refresh</tool-tip>
      <div aria-hidden="true">Private source</div>
      <div aria-hidden="true"><span role="tooltip" aria-hidden="true">Hidden ancestor</span></div>
      <div hidden><span role="tooltip" aria-hidden="true">Hidden source</span></div>
      <div inert><span role="tooltip" aria-hidden="true">Inert source</span></div>
      <span role="tooltip" aria-hidden="true" translate="no">Opted out</span>
      <span role="tooltip" aria-hidden="true"><span aria-hidden="true">Hidden child</span><kbd>Ctrl</kbd><input value="Private value"></span>
    `;
    expect(collectPageText(document.body, 'zh-CN').map((node) => node.data.trim())).toEqual([
      'All repositories',
      'Show details',
      'Refresh',
    ]);
    const tip = document.querySelector<HTMLElement>('[data-component="Tooltip"]')!;
    tip.style.visibility = 'hidden';
    expect(collectPageText(tip, 'zh-CN')).toEqual([]);
    tip.style.visibility = 'visible';
    vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue({ width: 0, height: 0 } as DOMRect);
    expect(collectPageText(tip, 'zh-CN')).toEqual([]);
  });
  it('includes navigation and button labels while excluding values, code, editors, and opt-outs', () => {
    document.body.innerHTML =
      '<nav><a href="/docs">Documentation</a></nav><button>Create instance</button><p>Read <strong>release notes</strong> <code>npm install</code></p><input value="private"><select><option>Production</option></select><div role="textbox">Private draft</div><div contenteditable>Private draft</div><p translate="no">Keep this</p><span class="notranslate">Keep too</span><script>secret()</script>';
    expect(collectPageText(document.body, 'zh-CN').map((node) => node.data.trim())).toEqual([
      'Documentation',
      'Create instance',
      'Read',
      'release notes',
    ]);
  });
  it('updates and restores the same Text objects without replacing child elements or their listeners', () => {
    document.body.innerHTML =
      '<p>Read <a href="/docs"><strong>release notes</strong></a> first.</p>';
    const paragraph = document.querySelector('p')!,
      link = document.querySelector('a')!,
      strong = document.querySelector('strong')!;
    const nodes = collectPageText(paragraph, 'zh-CN'),
      childNodes = [...paragraph.childNodes];
    let clicks = 0;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      clicks++;
    });
    const entries = nodes.map((node) => new PageText(node));
    entries.forEach((entry, index) => entry.write(['阅读', '发行说明', '之前。'][index]!));
    expect([...paragraph.childNodes]).toEqual(childNodes);
    expect(document.querySelector('strong')).toBe(strong);
    expect(link.getAttribute('href')).toBe('/docs');
    link.click();
    expect(clicks).toBe(1);
    entries.forEach((entry) => entry.restore());
    expect(paragraph.textContent).toBe('Read release notes first.');
    expect([...paragraph.childNodes]).toEqual(childNodes);
  });
  it('does not overwrite a website update with a stale translation or restore', () => {
    const node = document.createTextNode('Running');
    document.body.append(node);
    const entry = new PageText(node);
    entry.write('运行中');
    node.data = 'Stopped';
    expect(entry.write('旧结果')).toBe(false);
    entry.restore();
    expect(node.data).toBe('Stopped');
    entry.refresh();
    entry.write('已停止');
    entry.restore();
    expect(node.data).toBe('Stopped');
  });
  it('protects console resource IDs, ARNs and text-backed select values', () => {
    document.body.innerHTML =
      '<table><tbody><tr><td>i-0123456789abcdef0</td><td>arn:aws:ec2:us-east-1:123456789:instance/i-abc</td><td>us-east-1</td><td>m7i.large</td><td>Running</td></tr></tbody></table><select><option>Production</option></select>';
    expect(collectPageText(document.body, 'zh-CN').map((node) => node.data)).toEqual(['Running']);
    expect(document.querySelector('select')!.value).toBe('Production');
  });
  it('relinquishes labels repeatedly reset by their owning component', () => {
    const node = document.createTextNode('Refresh');
    document.body.append(node);
    const entry = new PageText(node);
    for (let i = 0; i < 2; i++) {
      entry.write('刷新');
      node.data = 'Refresh';
      entry.refresh();
    }
    expect(entry.skipped).toBe(true);
    expect(node.data).toBe('Refresh');
  });
  it('replaces selected characters without splitting a Text node', () => {
    const node = document.createTextNode('Before selected words after');
    document.body.append(node);
    const entry = new PageText(node, 7, 21);
    entry.write('选中文字');
    expect(node.data).toBe('Before 选中文字 after');
    expect(document.body.childNodes).toHaveLength(1);
    entry.restore();
    expect(node.data).toBe('Before selected words after');
  });
});
