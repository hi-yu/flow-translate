import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTranslator, type PageOptions } from '../../src/page-translator';

interface Job {
  text: string;
  options: PageOptions;
  partial(text: string): void;
  current(): boolean;
  resolve(text: string): void;
  reject(error: Error): void;
}
let translator: PageTranslator;
let jobs: Job[];
const options = { providerId: 'local', targetLanguage: 'zh-CN', configuration: 'original' };
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = '<p>Running</p>';
  history.replaceState({}, '', '/');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 20,
    top: 0,
    bottom: 20,
    left: 0,
    right: 100,
  } as DOMRect);
  jobs = [];
  translator = new PageTranslator(
    options,
    (text, options, partial, current) =>
      new Promise((resolve, reject) => {
        jobs.push({ text, options, partial, current, resolve, reject });
      }),
  );
});

afterEach(() => translator.restore());

describe('webpage translation lifecycle', () => {
  it('retains translated backgrounds during temporary accessibility hiding without reading new hidden sources', async () => {
    document.body.innerHTML = '<main><p>Running</p><input placeholder="Title"></main>';
    const main = document.querySelector('main')!;
    translator.start();
    jobs[0]!.resolve('运行中');
    await settle();
    jobs[1]!.resolve('标题');
    await settle();
    for (const attribute of ['aria-hidden', 'inert', 'hidden']) {
      main.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
      main.append(document.createTextNode('New private hidden source'));
      translator.scan();
      expect(main.querySelector('p')!.textContent).toBe('运行中');
      expect(main.querySelector('input')!.placeholder).toBe('标题');
      expect(jobs).toHaveLength(2);
      main.removeAttribute(attribute);
      main.lastChild!.remove();
    }
    main.setAttribute('aria-hidden', 'true');
    main.setAttribute('translate', 'no');
    translator.scan();
    expect(main.querySelector('p')!.textContent).toBe('Running');
    expect(main.querySelector('input')!.placeholder).toBe('Title');
  });

  it('rejects pending results in a hidden background and retries only after it becomes eligible', async () => {
    translator.start();
    const paragraph = document.querySelector('p')!;
    paragraph.setAttribute('aria-hidden', 'true');
    translator.scan();
    expect(jobs[0]!.current()).toBe(false);
    jobs[0]!.resolve('旧结果');
    await settle();
    expect(paragraph.textContent).toBe('Running');
    paragraph.removeAttribute('aria-hidden');
    translator.scan();
    jobs[1]!.resolve('运行中');
    await settle();
    expect(paragraph.textContent).toBe('运行中');
  });
  it('translates hint attributes atomically and rejects obsolete or removed hints', async () => {
    document.body.innerHTML = '<input placeholder="Title" value="private draft">';
    const input = document.querySelector('input')!;
    translator.start();
    expect(jobs[0]!.text).toBe('Title');
    jobs[0]!.partial('标');
    expect(input.placeholder).toBe('Title');
    input.placeholder = 'New title';
    translator.scan();
    expect(jobs[0]!.current()).toBe(false);
    jobs[0]!.resolve('旧结果');
    await settle();
    expect(jobs[1]!.text).toBe('New title');
    jobs[1]!.resolve('新标题');
    await settle();
    expect(input.placeholder).toBe('新标题');
    expect(translator.ownsMutation(input, 'placeholder')).toBe(true);
    expect(input.value).toBe('private draft');
    input.title = 'Rename view';
    translator.scan();
    expect(jobs[2]!.text).toBe('Rename view');
    input.removeAttribute('title');
    expect(jobs[2]!.current()).toBe(false);
    jobs[2]!.resolve('重命名视图');
    await settle();
    expect(input.hasAttribute('title')).toBe(false);
    translator.restore();
    expect(input.placeholder).toBe('New title');
    expect(input.value).toBe('private draft');
  });

  it('resumes labels on each user interaction while retaining protection against render loops', async () => {
    translator.start();
    const node = document.querySelector('p')!.firstChild as Text;
    for (let index = 0; index < 4; index++) {
      jobs[index]!.resolve('运行中');
      await settle();
      translator.resumeAfterInteraction();
      node.data = 'Running';
      translator.scan();
    }
    expect(jobs).toHaveLength(5);
    jobs[4]!.resolve('运行中');
    await settle();
    node.data = 'Running';
    translator.scan();
    await settle();
    expect(translator.status.skipped).toBe(1);
    translator.resumeAfterInteraction();
    translator.scan();
    expect(jobs).toHaveLength(6);
    jobs[5]!.resolve('运行中');
    await settle();
    expect(node.data).toBe('运行中');
  });
  it('prioritizes a visible tooltip over waiting webpage paragraphs', async () => {
    document.body.innerHTML = '<p>Running</p><button>Refresh</button>';
    translator.start();
    const tip = document.createElement('span');
    tip.dataset.component = 'Tooltip';
    tip.setAttribute('aria-hidden', 'true');
    tip.textContent = 'All repositories';
    document.body.append(tip);
    translator.scan();
    jobs[0]!.resolve('运行中');
    await settle();
    expect(jobs[1]!.text).toBe('All repositories');
    jobs[1]!.partial('全部');
    expect(tip.textContent).toBe('All repositories');
    jobs[1]!.resolve('全部仓库');
    await settle();
    expect(tip.textContent).toBe('全部仓库');
    expect(jobs[2]!.text).toBe('Refresh');
    jobs[2]!.resolve('刷新');
    await settle();
    translator.restore();
    expect(tip.textContent).toBe('All repositories');
    expect(tip.getAttribute('aria-hidden')).toBe('true');
  });

  it('rejects a tooltip result after hiding, then translates its latest text on reopening', async () => {
    document.body.innerHTML = '<span role="tooltip" aria-hidden="true">All repositories</span>';
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    translator.start();
    tip.style.visibility = 'hidden';
    expect(jobs[0]!.current()).toBe(false);
    jobs[0]!.resolve('旧结果');
    await settle();
    expect(tip.textContent).toBe('All repositories');
    tip.firstChild!.textContent = 'Show details';
    tip.style.visibility = 'visible';
    translator.scan();
    expect(jobs[1]!.text).toBe('Show details');
    jobs[1]!.resolve('显示详情');
    await settle();
    translator.restore();
    expect(tip.textContent).toBe('Show details');
  });
  it('streams prose while applying interactive labels atomically', async () => {
    document.body.innerHTML = '<p>Running</p><button>Refresh</button>';
    translator.start();
    jobs[0]!.partial('运');
    expect(document.querySelector('p')!.textContent).toBe('运');
    expect(translator.ownsMutation(document.querySelector('p')!.firstChild!)).toBe(true);
    jobs[0]!.resolve('运行中');
    await settle();
    jobs[1]!.partial('刷');
    expect(document.querySelector('button')!.textContent).toBe('Refresh');
    jobs[1]!.resolve('刷新');
    await settle();
    expect(translator.status).toMatchObject({ translated: 2, pending: 0 });
  });

  it('discards a website update during inference and restores the updated source', async () => {
    translator.start();
    const node = document.querySelector('p')!.firstChild as Text;
    node.data = 'Stopped';
    translator.scan();
    expect(jobs[0]!.current()).toBe(false);
    jobs[0]!.partial('旧结果');
    jobs[0]!.resolve('旧结果');
    await settle();
    expect(jobs[1]!.text).toBe('Stopped');
    jobs[1]!.resolve('已停止');
    await settle();
    translator.restore();
    expect(node.data).toBe('Stopped');
  });

  it('stops retrying labels repeatedly reset by their component', async () => {
    translator.start();
    const node = document.querySelector('p')!.firstChild as Text;
    for (let i = 0; i < 2; i++) {
      jobs[i]!.resolve('运行中');
      await settle();
      node.data = 'Running';
      translator.scan();
    }
    await settle();
    expect(jobs).toHaveLength(2);
    expect(translator.status).toMatchObject({ skipped: 1, pending: 0 });
    expect(node.data).toBe('Running');
  });

  it('invalidates removed nodes and newly opted-out regions before writing', async () => {
    translator.start();
    const paragraph = document.querySelector('p')!;
    paragraph.setAttribute('translate', 'no');
    expect(jobs[0]!.current()).toBe(false);
    jobs[0]!.resolve('运行中');
    await settle();
    expect(paragraph.textContent).toBe('Running');
    paragraph.removeAttribute('translate');
    translator.scan();
    paragraph.remove();
    expect(jobs[1]!.current()).toBe(false);
    jobs[1]!.resolve('运行中');
    await settle();
    expect(paragraph.textContent).toBe('Running');
    document.body.append(paragraph);
    translator.scan();
    expect(jobs[2]!.text).toBe('Running');
  });

  it('discards results from an old provider and restores partial text before a retry', async () => {
    translator.start();
    jobs[0]!.partial('旧');
    translator.configure({ ...options, providerId: 'other', configuration: 'changed' });
    expect(document.querySelector('p')!.textContent).toBe('Running');
    jobs[0]!.resolve('旧结果');
    await settle();
    expect(jobs[1]!.options.providerId).toBe('other');
    jobs[1]!.resolve('运行中');
    await settle();
    translator.restore();
    expect(document.querySelector('p')!.textContent).toBe('Running');
  });

  it('restores provisional text and pauses the queue on provider errors', async () => {
    document.body.innerHTML += '<p>Another paragraph</p>';
    translator.start();
    jobs[0]!.partial('临时');
    jobs[0]!.reject(new Error('HTTP 401'));
    await settle();
    expect(document.querySelector('p')!.textContent).toBe('Running');
    expect(translator.status).toMatchObject({ enabled: false, pending: 0, error: 'HTTP 401' });
    expect(jobs).toHaveLength(1);
  });

  it('ignores empty selections and machine identifiers within otherwise readable prose', () => {
    const node = document.querySelector('p')!.firstChild as Text;
    node.data = 'Instance i-0123456789abcdef0';
    const range = document.createRange();
    range.setStart(node, 9);
    range.collapse(true);
    translator.selection(range);
    expect(translator.status.enabled).toBe(false);
    range.setEnd(node, node.length);
    translator.selection(range);
    expect(jobs).toHaveLength(0);
    expect(translator.status.error).toContain('请选择正文文字');
  });
});
