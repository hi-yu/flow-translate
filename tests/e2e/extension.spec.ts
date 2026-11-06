import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import type { Settings } from '../../src/types';

let context: BrowserContext;
let options: Page;
let profile: string;
let extensionId: string;
let server: Server;
let baseUrl: string;
const requests: {
  url: string;
  authorization?: string;
  googleKey?: string;
  method?: string;
  text: string;
  completed?: boolean;
}[] = [];

function outputFor(text: string): string {
  if (text.endsWith('More')) return '更多';
  if (text.endsWith('New title')) return '新标题';
  if (text.endsWith('Title')) return '标题';
  if (text.endsWith('Add a description')) return '添加描述';
  if (text.endsWith('Rename view')) return '重命名视图';
  if (text.endsWith('Overview')) return '概述';
  if (text.endsWith('Free Tier Categories')) return '免费套餐类别';
  if (text.endsWith('Terms and Conditions')) return '条款与条件';
  if (text.endsWith('AWS Free Tier')) return 'AWS 免费套餐';
  if (text.endsWith('Get started for free')) return '免费开始使用';
  if (text.endsWith('All repositories')) return '全部仓库';
  if (text.includes('多行草稿')) return 'こんにちは。\n金曜日に会いましょう。';
  if (text.includes('你好，周五见'))
    return text.includes('日本語')
      ? 'こんにちは、金曜日に会いましょう。'
      : 'Hello, see you on Friday.';
  if (text.endsWith('Instances')) return '实例';
  if (text.endsWith('Instance ID')) return '实例 ID';
  if (text.endsWith('State')) return '状态';
  if (text.endsWith('Region')) return '区域';
  if (text.endsWith('Running')) return '运行中';
  if (text.endsWith('Stopped')) return '已停止';
  if (text.endsWith('Refresh')) return '刷新';
  if (text.endsWith('Show details')) return '显示详情';
  if (text.endsWith('Instance details')) return '实例详情';
  if (text.endsWith('Add instance')) return '添加实例';
  if (text.endsWith('selected words')) return '选中文字';
  if (text.endsWith('Amazon EC2')) return '亚马逊 EC2';
  if (text.includes('Our next release')) return '下一个版本将于周五发布。';
  if (text.includes('review the pull request')) return '你能帮忙评审这个合并请求吗？';
  if (text.includes('already deployed')) return '我们已经部署了更新。';
  if (text.includes('edited message')) return '这是一条编辑后的消息。';
  if (text.includes('deliberately streamed')) return '正在逐步显示的译文。';
  if (text.includes('こんにちは')) return '你好，下一个版本将于周五发布。';
  if (text.includes('안녕하세요')) return '你好，下一次发布将在周五。';
  if (text.includes('Привет')) return '你好，版本将在周五发布。';
  if (text.includes('Bonjour')) return '你好，下一个版本将在周五发布。';
  if (text.includes('مرحبا')) return '你好，下一个版本在周五发布。';
  return '连接正常，祝你有愉快的一天。';
}

async function chooseBackup(select: Locator): Promise<void> {
  // Use a native listbox to generate trusted changes without a macOS popup menu in headless Chrome.
  await select.evaluate((element) => {
    (element as HTMLSelectElement).size = 2;
  });
  await select.focus();
  await select.press('ArrowDown');
  await select.evaluate((element) => {
    (element as HTMLSelectElement).size = 1;
  });
}

async function settings(): Promise<Settings> {
  return options.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!result.ok) throw new Error(result.error);
    return result.data as Settings;
  });
}

async function saveSettings(value: Settings): Promise<void> {
  await options.evaluate(async (next) => {
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: next });
    if (!result.ok) throw new Error(result.error);
  }, value);
}

async function action(page: Page, type: string): Promise<void> {
  const targetUrl = page.url();
  await options.evaluate(
    async ({ url, type }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((tab) => tab.url === url);
      if (tab?.id == null) throw new Error('Test tab unavailable');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await chrome.tabs.sendMessage(tab.id, { type });
    },
    { url: targetUrl, type },
  );
}

async function openPopup(page: Page): Promise<Page> {
  const popup = await context.newPage();
  await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    await chrome.tabs.update(tab.id!, { active: true });
  }, page.url());
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

async function popupActionPoint(
  popup: Page,
  id: 'translate' | 'restore',
): Promise<{ x: number; y: number }> {
  const button = popup.locator('#' + id);
  await expect(button).toBeEnabled();
  const point = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      exposed:
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        Boolean(hit && element.contains(hit)),
    };
  });
  expect(point.exposed, `${id} should be fully visible and clickable without scrolling`).toBe(true);
  return { x: point.x, y: point.y };
}

async function setAuto(page: Page, enabled: boolean): Promise<void> {
  const popup = await openPopup(page);
  await popup.locator('#discord-auto').setChecked(enabled);
  await expect(popup.locator('#discord-auto')).toBeEnabled();
  await expect.poll(() => channelAuto(page)).toBe(enabled);
  await popup.close();
}

async function channelAuto(page: Page): Promise<boolean> {
  return options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    return (await chrome.tabs.sendMessage(tab.id!, { type: 'GET_STATUS' })).auto;
  }, page.url());
}

async function grantActiveTab(page: Page): Promise<void> {
  const session = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const target = targetInfos.find((target) => target.url === page.url());
  if (!target) throw new Error('Test tab target unavailable');
  await session.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  await session.detach();
}

async function preapproveDomain(domain: string): Promise<void> {
  // Headless Chrome cannot show its native permission dialog. Approve this test host in its
  // isolated extension manager; the popup still activates the real optional permission.
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  await manager.evaluate(
    async ({ id, domain }) => {
      const api = (
        chrome as unknown as {
          developerPrivate: {
            updateProfileConfiguration(update: { inDeveloperMode: boolean }): Promise<void>;
            addHostPermission(id: string, host: string): Promise<void>;
          };
        }
      ).developerPrivate;
      await api.updateProfileConfiguration({ inDeveloperMode: true });
      await api.addHostPermission(id, `*://${domain}/*`);
    },
    { id: extensionId, domain },
  );
  await manager.close();
}

async function pageStatus(
  page: Page,
): Promise<{ pending: number; translated: number; skipped: number }> {
  return options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    return (await chrome.tabs.sendMessage(tab.id!, { type: 'GET_STATUS' })).page;
  }, page.url());
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      const data = JSON.parse(body || '{}') as {
        messages?: { content: string }[];
        text?: string[];
        target_lang?: string;
      };
      const text = data.messages?.[0]?.content ?? data.text?.[0] ?? '';
      const request = {
        url: req.url ?? '',
        authorization: req.headers.authorization,
        googleKey: req.headers['x-goog-api-key'] as string | undefined,
        method: req.method,
        text,
        completed: false,
      };
      requests.push(request);
      res.once('finish', () => {
        request.completed = true;
      });
      if (req.method === 'GET' && req.url?.includes('/models')) {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/gemini/')) {
          if (req.headers['x-goog-api-key'] !== 'gemini-model-test-key')
            res.writeHead(401).end('private model server detail');
          else
            res.end(
              JSON.stringify({
                models: [
                  {
                    name: 'models/gemini-test-flash',
                    supportedGenerationMethods: ['generateContent'],
                  },
                  { name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'] },
                ],
              }),
            );
        } else if (req.headers.authorization !== 'Bearer test-key')
          res.writeHead(401).end('private model server detail');
        else if (req.url === '/empty/v1/models') res.end(JSON.stringify({ data: [] }));
        else if (req.url === '/unsupported/v1/models')
          res.writeHead(404).end('private model server detail');
        else if (req.url === '/slow/v1/models')
          setTimeout(() => res.end(JSON.stringify({ data: [{ id: 'stale-model' }] })), 500);
        else
          res.end(
            JSON.stringify({
              data: [{ id: 'hy-mt2-7b:q6_k' }, { id: 'other-model' }, { id: 'other-model' }],
            }),
          );
        return;
      }
      if (req.url === '/deepl/v2/translate') {
        if (req.headers.authorization !== 'DeepL-Auth-Key deepl-settings-test-key') {
          res.writeHead(401).end();
        } else if (!data.text?.length || data.target_lang !== 'ZH-HANS') {
          res.writeHead(400).end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ translations: [{ text: 'DeepL 连接正常。' }] }));
        }
        return;
      }
      if (text.includes('delayed channel failure')) {
        setTimeout(() => {
          res.writeHead(401);
          res.end();
        }, 500);
        return;
      }
      if (
        !['Bearer test-key', 'Bearer alternative-key'].includes(req.headers.authorization ?? '')
      ) {
        res.writeHead(401);
        res.end();
        return;
      }
      const translation =
        (req.url?.includes('/alternative/') ? '备用译法：' : '') + outputFor(text);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (text.includes('deliberately streamed')) {
        res.write(
          'data: ' +
            JSON.stringify({ choices: [{ delta: { content: '正在逐步' }, finish_reason: null }] }) +
            '\n\n',
        );
        setTimeout(() => {
          res.end(
            'data: ' +
              JSON.stringify({
                choices: [{ delta: { content: '显示的译文。' }, finish_reason: 'stop' }],
              }) +
              '\n\ndata: [DONE]\n\n',
          );
        }, 1000);
        return;
      }
      const respond = () => {
        res.write(
          'data: ' +
            JSON.stringify({
              choices: [{ delta: { content: translation }, finish_reason: null }],
            }) +
            '\n\n',
        );
        res.end(
          'data: ' +
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
            '\n\ndata: [DONE]\n\n',
        );
      };
      setTimeout(respond, text.includes('slow original') ? 1000 : 30);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  baseUrl = `http://127.0.0.1:${address.port}`;
  profile = await mkdtemp(join(tmpdir(), 'flow-translate-test-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    viewport: { width: 1280, height: 900 },
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator('#provider-name')).toHaveValue('本地 Ollama');
  await context.route('https://discord.com/**', async (route) =>
    route.fulfill({
      body: await readFile('tests/fixtures/discord.html', 'utf8'),
      contentType: 'text/html',
    }),
  );
  await context.route(baseUrl + '/article', async (route) =>
    route.fulfill({
      body: await readFile('tests/fixtures/article.html', 'utf8'),
      contentType: 'text/html',
    }),
  );
  await context.route(baseUrl + '/tooltips', async (route) =>
    route.fulfill({
      body: await readFile('tests/fixtures/tooltips.html', 'utf8'),
      contentType: 'text/html',
    }),
  );
  const consoleBundle = await build({
    entryPoints: ['tests/fixtures/console.jsx'],
    bundle: true,
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const composerBundle = await build({
    entryPoints: ['tests/fixtures/discord-composer.jsx'],
    bundle: true,
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const tabsBundle = await build({
    entryPoints: ['tests/fixtures/tabs.jsx'],
    bundle: true,
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  await context.route(baseUrl + '/tabs', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><style>body{padding:24px;font:16px system-ui}button,input,textarea{padding:12px;margin:4px}</style></head><body><div id="root"></div><script src="/tabs.js"></script></body></html>',
    }),
  );
  await context.route(baseUrl + '/tabs.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: tabsBundle.outputFiles[0]!.text }),
  );
  await context.route('https://discord.com/channels/88/**', async (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: (await readFile('tests/fixtures/discord.html', 'utf8')).replace(
        /<form\b[^>]*\bid="message-form"[^>]*>[\s\S]*?<\/form>/,
        '<div id="slate-compose-root"></div><script src="/slate-fixture.js"></script>',
      ),
    }),
  );
  await context.route('https://discord.com/slate-fixture.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: composerBundle.outputFiles[0]!.text }),
  );
  await context.route(baseUrl + '/console', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><style>body{font:16px system-ui;margin:20px}button,input,select,td,th{padding:6px}p{margin:12px 0}table{width:100%}</style></head><body><div id="root"></div><script src="/console.js"></script></body></html>',
    }),
  );
  await context.route(baseUrl + '/console.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: consoleBundle.outputFiles[0]!.text,
    }),
  );
  await context.route('https://example.org/**', async (route) =>
    route.fulfill({
      body: await readFile('tests/fixtures/article.html', 'utf8'),
      contentType: 'text/html',
    }),
  );
  for (const origin of ['https://sub.example.org', 'https://example.net'])
    await context.route(origin + '/**', async (route) =>
      route.fulfill({
        body: await readFile('tests/fixtures/article.html', 'utf8'),
        contentType: 'text/html',
      }),
    );
  await mkdir('test-results/screenshots', { recursive: true });
});

test.afterAll(async () => {
  await context?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('handles translation port disconnection when a page enters the back-forward cache', async () => {
  const page = await context.newPage();
  const manager = await context.newPage();
  const worker = context.serviceWorkers()[0]!;
  const errors: string[] = [];
  const onConsole = (message: { text(): string }) => errors.push(message.text());
  worker.on('console', onConsole);
  page.on('console', onConsole);
  try {
    await manager.goto('chrome://extensions/');
    await manager.evaluate(async () => {
      const api = (
        chrome as unknown as {
          developerPrivate: {
            updateProfileConfiguration(update: { inDeveloperMode: boolean }): Promise<void>;
          };
        }
      ).developerPrivate;
      await api.updateProfileConfiguration({ inDeveloperMode: true });
    });
    await options.locator('#provider-url').fill(baseUrl + '/v1');
    await options.locator('#provider-key').fill('test-key');
    await options.getByRole('button', { name: '保存接口', exact: true }).click();
    await expect(options.locator('#form-status')).toContainText('已保存');
    await page.addInitScript(() => {
      window.addEventListener('pageshow', (event) => {
        sessionStorage.setItem('flow-test-restored', String(event.persisted));
      });
    });
    await page.goto(baseUrl + '/console');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    const before = requests.length;
    await action(page, 'TRANSLATE_PAGE');
    await expect(page.locator('#stream')).toHaveText('正在逐步');
    await page.goto(baseUrl + '/tooltips');
    await page.goBack({ waitUntil: 'commit' });
    expect(await page.evaluate(() => sessionStorage.getItem('flow-test-restored'))).toBe('true');
    await expect
      .poll(() =>
        requests
          .slice(before)
          .some((request) => request.text.includes('deliberately streamed') && request.completed),
      )
      .toBe(true);
    await action(page, 'TRANSLATE_PAGE');
    await expect(page.locator('#stream')).toHaveText('正在逐步显示的译文。');
    const runtimeErrors = await manager.evaluate(async (id) => {
      const api = (
        chrome as unknown as {
          developerPrivate: {
            getExtensionsInfo(options: {
              includeDisabled: boolean;
              includeTerminated: boolean;
            }): Promise<{ id: string; runtimeErrors?: { message: string }[] }[]>;
          };
        }
      ).developerPrivate;
      const entries = await api.getExtensionsInfo({
        includeDisabled: true,
        includeTerminated: true,
      });
      return (
        entries.find((entry) => entry.id === id)?.runtimeErrors?.map((error) => error.message) ?? []
      );
    }, extensionId);
    expect(runtimeErrors.filter((message) => message.includes('back/forward cache'))).toEqual([]);
    expect(errors.filter((message) => message.includes('Unchecked runtime.lastError'))).toEqual([]);
  } finally {
    worker.off('console', onConsole);
    page.off('console', onConsole);
    await page.close();
    await manager.close();
  }
});

test('resumes Discord automatic translation after back-forward cache restoration', async () => {
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.addEventListener('pageshow', (event) => {
        sessionStorage.setItem('flow-test-discord-restored', String(event.persisted));
      });
    });
    await page.goto('https://discord.com/channels/98/100');
    await page.evaluate(() => {
      document.querySelector('#message-content-101')!.textContent = 'A slow original message.';
    });
    const before = requests.length;
    await setAuto(page, true);
    await expect
      .poll(() => requests.slice(before).some((request) => request.text.includes('slow original')))
      .toBe(true);
    await page.goto('https://example.org/bfcache');
    await page.goBack({ waitUntil: 'commit' });
    expect(await page.evaluate(() => sessionStorage.getItem('flow-test-discord-restored'))).toBe(
      'true',
    );
    await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
    await expect.poll(() => channelAuto(page)).toBe(true);
    await expect(page.locator('flow-translation .error')).toHaveCount(0);
    await setAuto(page, false);
  } finally {
    await page.close();
  }
});

test('configures multiple providers without publishing credentials to content settings', async () => {
  await options.locator('#provider-url').fill(baseUrl + '/v1');
  await options.locator('#provider-key').fill('test-key');
  await options.getByRole('button', { name: '保存接口', exact: true }).click();
  await expect(options.locator('#form-status')).toContainText('已保存');
  await options.getByRole('button', { name: '测试翻译', exact: true }).click();
  await expect(options.locator('#test-result')).toContainText('连接正常');
  await options.locator('#preset').selectOption('compatible');
  await options.locator('#add-provider').click();
  await options.locator('#provider-name').fill('备用接口');
  await options.locator('#provider-url').fill(baseUrl + '/alternative/v1');
  await options.locator('#provider-model').fill('alternative-model');
  await options.locator('#provider-key').fill('alternative-key');
  await options.locator('#save').click();
  await expect(options.locator('#form-status')).toContainText('已保存');
  const publicValue = await options.evaluate(
    async () => (await chrome.runtime.sendMessage({ type: 'GET_PUBLIC_SETTINGS' })).data,
  );
  expect(JSON.stringify(publicValue)).not.toContain('test-key');
  expect(JSON.stringify(publicValue)).not.toContain('alternative-key');
  await options.locator('#add-provider').click();
  options.once('dialog', (dialog) => {
    void dialog.accept();
  });
  await options.locator('#provider-list button').filter({ hasText: '本地 Ollama' }).click();
  await expect(options.locator('#provider-list button')).toHaveCount(2);
  await options.locator('#save').click();
  await expect(options.locator('#form-status')).toContainText('已保存');
  await options.screenshot({ path: 'test-results/screenshots/options.png', fullPage: true });
});

test('fetches models into a dropdown, preserves manual values and saves only after explicit submission', async () => {
  const previous = await settings();
  const panel = await context.newPage();
  try {
    await panel.goto(`chrome-extension://${extensionId}/options.html`);
    await panel.locator('#provider-model').fill('');
    await panel.getByRole('button', { name: '拉取模型列表', exact: true }).click();
    await expect(panel.locator('#model-status')).toContainText('已拉取 2 个模型');
    const models = panel.getByLabel('模型名称', { exact: true });
    await expect(models).toHaveAttribute('id', 'provider-model-select');
    await expect(models.locator('option')).toHaveText([
      '请选择模型',
      'hy-mt2-7b:q6_k',
      'other-model',
    ]);
    await expect(panel.locator('#provider-model')).toBeHidden();
    expect((await settings()).providers).toEqual(previous.providers);
    expect(requests.find((request) => request.url === '/v1/models')).toMatchObject({
      method: 'GET',
      authorization: 'Bearer test-key',
    });
    await models.selectOption('other-model');
    await panel.locator('#save').click();
    await expect(panel.locator('#form-status')).toContainText('已保存');
    expect(
      (await settings()).providers.find((provider) => provider.id === 'local-ollama')?.model,
    ).toBe('other-model');
    await panel.getByRole('button', { name: '手动填写', exact: true }).click();
    await expect(panel.locator('#provider-model')).toHaveValue('other-model');
    await panel.locator('#provider-model').fill('custom-unlisted-model');
    await panel.locator('#fetch-models').click();
    await expect(models).toHaveValue('custom-unlisted-model');
    await expect(models.locator('option').first()).toHaveText('custom-unlisted-model（当前填写）');
    await expect(panel.locator('#model-status')).toContainText('已保留');
    await panel
      .locator('.provider-detail')
      .screenshot({ path: 'test-results/screenshots/models-dropdown.png' });
    await panel.locator('#provider-key').fill('invalid-model-key');
    await expect(panel.locator('#provider-model-select')).toBeHidden();
    await expect(panel.locator('#provider-model')).toHaveValue('custom-unlisted-model');
    await panel.locator('#fetch-models').click();
    await expect(panel.locator('#model-status')).toContainText('没有拉取到模型');
    await expect(panel.locator('#model-status')).toContainText('HTTP 401');
    await expect(panel.locator('#model-status')).not.toContainText('private model server detail');
    await panel.locator('#provider-key').fill('test-key');
    for (const [path, message] of [
      ['empty', '列表为空'],
      ['unsupported', 'HTTP 404'],
    ]) {
      await panel.locator('#provider-url').fill(baseUrl + '/' + path + '/v1');
      await panel.locator('#fetch-models').click();
      await expect(panel.locator('#model-status')).toContainText(message!);
      await expect(panel.locator('#provider-model')).toBeVisible();
    }
    await panel
      .locator('.provider-detail')
      .screenshot({ path: 'test-results/screenshots/models-unavailable.png' });
    await panel.locator('#provider-url').fill(baseUrl + '/slow/v1');
    await panel.locator('#fetch-models').click();
    await expect(panel.locator('#fetch-models')).toBeDisabled();
    await expect
      .poll(() => requests.some((request) => request.url === '/slow/v1/models'))
      .toBe(true);
    await panel.locator('#provider-url').fill(baseUrl + '/v1');
    await panel.locator('#fetch-models').click();
    await expect(panel.locator('#model-status')).toContainText('已拉取 2 个模型');
    await panel.waitForTimeout(650);
    await expect(models.locator('option[value="stale-model"]')).toHaveCount(0);
    panel.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await panel.locator('#provider-list button').filter({ hasText: '备用接口' }).click();
    await expect(panel.locator('#provider-model')).toHaveValue('alternative-model');
    await expect(panel.locator('#provider-model-select')).toBeHidden();
    await panel.locator('#preset').selectOption('deepl');
    await panel.locator('#add-provider').click();
    await expect(panel.locator('#fetch-models')).toBeHidden();
  } finally {
    await panel.close();
    await saveSettings(previous);
  }
});

test('fetches Gemini generation models before a model is entered and rejects model listing from content scripts', async () => {
  const previous = await settings();
  const panel = await context.newPage();
  const web = await context.newPage();
  try {
    await panel.goto(`chrome-extension://${extensionId}/options.html`);
    await panel.locator('#preset').selectOption('gemini');
    await panel.locator('#add-provider').click();
    await panel.locator('#provider-url').fill(baseUrl + '/gemini/v1beta');
    await panel.locator('#provider-key').fill('gemini-model-test-key');
    await panel.locator('#fetch-models').click();
    const models = panel.getByLabel('模型名称', { exact: true });
    await expect(models.locator('option')).toHaveText(['请选择模型', 'gemini-test-flash']);
    expect(requests.find((request) => request.url.startsWith('/gemini/'))).toMatchObject({
      method: 'GET',
      googleKey: 'gemini-model-test-key',
      authorization: undefined,
    });
    expect((await settings()).providers).toEqual(previous.providers);
    await web.goto(baseUrl + '/article');
    await action(web, 'RESTORE_PAGE');
    const provider = { ...previous.providers[0]!, model: '' };
    const before = requests.length;
    const denied = await panel.evaluate(
      async ({ url, provider }) => {
        const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: (provider) =>
            chrome.runtime.sendMessage({ type: 'LIST_PROVIDER_MODELS', provider }),
          args: [provider],
        });
        return result?.result;
      },
      { url: web.url(), provider },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('仅限扩展');
    expect(requests.length).toBe(before);
    const unauthorized = await panel.evaluate(
      (provider) =>
        chrome.runtime.sendMessage({
          type: 'LIST_PROVIDER_MODELS',
          provider: { ...provider, baseUrl: 'https://unapproved.example.net/v1' },
        }),
      provider,
    );
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.error).toContain('尚未授予');
  } finally {
    await Promise.all([panel.close(), web.close()]);
    await saveSettings(previous);
  }
});

test('configures DeepL free, paid and custom endpoints with a fixed provider type and native API requests', async () => {
  const previous = await settings();
  const panel = await context.newPage();
  try {
    await panel.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(panel.locator('#deepl-endpoint-field')).toBeHidden();
    await expect(panel.locator('#deepl-key-help')).toBeHidden();
    await panel.locator('#preset').selectOption('deepl');
    await panel.locator('#add-provider').click();
    await expect(panel.getByLabel('接口协议', { exact: true })).toHaveCount(0);
    await expect(panel.locator('#deepl-endpoint')).toHaveValue('free');
    await expect(panel.locator('#deepl-endpoint option')).toHaveText([
      '免费版（https://api-free.deepl.com/v2）',
      '付费版（https://api.deepl.com/v2）',
      '自定义',
    ]);
    await expect(panel.locator('#provider-url')).toBeHidden();
    await expect(panel.locator('#provider-url')).toBeDisabled();
    await expect(panel.locator('#model-field')).toBeHidden();
    const keyLink = panel.locator('#deepl-key-help a');
    await expect(keyLink).toBeVisible();
    await expect(keyLink).toHaveAttribute('href', 'https://www.deepl.com/zh/your-account/keys');
    await expect(keyLink).toHaveAttribute('target', '_blank');
    await expect(keyLink).toHaveAttribute('rel', 'noopener noreferrer');
    await panel.locator('#provider-name').fill('DeepL 专用');
    await panel.locator('#provider-key').fill('deepl-settings-test-key');
    await preapproveDomain('api-free.deepl.com');
    await preapproveDomain('api.deepl.com');
    await panel.locator('#save').click();
    await expect(panel.locator('#form-status')).toContainText('已保存');
    const deepL = () =>
      settings().then(
        (settings) => settings.providers.find((provider) => provider.name === 'DeepL 专用')!,
      );
    expect(await deepL()).toMatchObject({
      kind: 'deepl',
      baseUrl: 'https://api-free.deepl.com/v2',
      apiKey: 'deepl-settings-test-key',
    });
    await panel
      .locator('.workspace')
      .screenshot({ path: 'test-results/screenshots/deepl-free.png' });
    await panel.locator('#deepl-endpoint').selectOption('pro');
    await expect(panel.locator('#form-status')).toContainText('未保存');
    await panel.locator('#save').click();
    await expect(panel.locator('#form-status')).toContainText('已保存');
    expect(await deepL()).toMatchObject({
      kind: 'deepl',
      baseUrl: 'https://api.deepl.com/v2',
      apiKey: 'deepl-settings-test-key',
    });
    await panel.reload();
    await panel.locator('#provider-list button').filter({ hasText: 'DeepL 专用' }).click();
    await expect(panel.locator('#deepl-endpoint')).toHaveValue('pro');
    await expect(panel.locator('#provider-url')).toBeDisabled();
    await panel.locator('#deepl-endpoint').selectOption('custom');
    await expect(panel.getByLabel('自定义 API 根地址', { exact: true })).toBeVisible();
    await panel.locator('#provider-url').fill(baseUrl + '/deepl/v2');
    await panel.locator('#deepl-endpoint').selectOption('free');
    await panel.locator('#deepl-endpoint').selectOption('custom');
    await expect(panel.locator('#provider-url')).toHaveValue(baseUrl + '/deepl/v2');
    await panel.locator('#test-provider').click();
    await expect(panel.locator('#form-status')).toContainText('连接成功');
    await expect(panel.locator('#test-result')).toHaveText('DeepL 连接正常。');
    expect(await deepL()).toMatchObject({
      kind: 'deepl',
      baseUrl: baseUrl + '/deepl/v2',
      apiKey: 'deepl-settings-test-key',
    });
    expect(requests.find((request) => request.url === '/deepl/v2/translate')?.authorization).toBe(
      'DeepL-Auth-Key deepl-settings-test-key',
    );
    await panel.reload();
    await panel.locator('#provider-list button').filter({ hasText: 'DeepL 专用' }).click();
    await expect(panel.locator('#deepl-endpoint')).toHaveValue('custom');
    await expect(panel.locator('#provider-url')).toHaveValue(baseUrl + '/deepl/v2');
    await expect(panel.locator('#provider-key')).toHaveValue('deepl-settings-test-key');
    await expect(
      panel.locator('#provider-list button').filter({ hasText: 'DeepL 专用' }),
    ).toContainText('DeepL 原生协议');
    await panel
      .locator('.workspace')
      .screenshot({ path: 'test-results/screenshots/deepl-custom.png' });
    await panel.locator('#preset').selectOption('gemini');
    await panel.locator('#add-provider').click();
    await expect(panel.locator('#deepl-endpoint-field')).toBeHidden();
    await expect(panel.locator('#deepl-key-help')).toBeHidden();
    await expect(panel.locator('#model-field')).toBeVisible();
    await expect(panel.locator('#provider-url')).toBeEnabled();
    panel.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await panel.locator('#provider-list button').filter({ hasText: 'DeepL 专用' }).click();
    await expect(panel.locator('#deepl-endpoint')).toHaveValue('custom');
    await expect(panel.locator('#model-field')).toBeHidden();
    await expect(panel.locator('#provider-key')).toHaveValue('deepl-settings-test-key');
  } finally {
    await panel.close();
    await saveSettings(previous);
  }
});

test('grants activeTab through the extension action and operates its popup on an HTTPS webpage', async () => {
  const page = await context.newPage();
  await page.goto('https://example.org/article');
  const browserSession = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', {
    filter: [{ type: 'tab' }],
  });
  const target = targetInfos.find((target) => target.url === page.url());
  if (!target) throw new Error('Fixture tab target unavailable');
  await browserSession.send('Extensions.triggerAction', {
    id: extensionId,
    targetId: target.targetId,
  });
  // Headless Chrome grants the action permission; render the popup in an inactive tab for UI checks.
  const popup = await context.newPage();
  await options.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((tab) => tab.url === url);
    if (tab?.id == null) throw new Error('Fixture tab unavailable');
    await chrome.tabs.update(tab.id, { active: true });
  }, page.url());
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#site-name')).toHaveText('example.org');
  await popup.locator('#translate').click();
  await expect(page.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  await expect(page.locator('flow-translation,flow-toolbar')).toHaveCount(0);
  await popup.locator('body').screenshot({ path: 'test-results/screenshots/popup.png' });
  await popup.locator('#restore').click();
  await expect(page.locator('flow-translation')).toHaveCount(0);
  await popup.close();
  await page.close();
});

test('keeps the restore action visible within a constrained popup shell', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/article');
  for (const height of [600, 520, 420]) {
    await action(page, 'TRANSLATE_PAGE');
    await expect(page.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
    const popup = await openPopup(page);
    await popup.setViewportSize({ width: 380, height });
    // Exercise flex shrinking separately from native action popup intrinsic sizing (popup.spec.ts).
    await popup.locator('body').evaluate((element, height) => {
      element.style.maxHeight = `${height}px`;
    }, height);
    await expect(popup.locator('#restore')).toHaveText('显示原文');
    await expect(popup.locator('#status')).toContainText('已翻译');
    await popupActionPoint(popup, 'translate');
    const before = await popupActionPoint(popup, 'restore');
    await popup.locator('main').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const after = await popupActionPoint(popup, 'restore');
    expect(after).toEqual(before);
    await popup.locator('main').evaluate((element) => {
      element.scrollTop = 0;
    });
    if (height === 600) {
      await expect(popup.locator('#page-auto')).toBeInViewport({ ratio: 1 });
      await popup.screenshot({ path: 'test-results/screenshots/popup-restore-visible.png' });
    }
    await popup.mouse.click(after.x, after.y);
    await expect(page.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
    await expect(popup.locator('#status')).toHaveText('已显示原文。');
    await popup.close();
  }
  await page.close();
});

test('replaces webpage text in place and restores originals without adding elements', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/article');
  await action(page, 'TRANSLATE_PAGE');
  await expect(page.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  await expect(page.locator('flow-translation,flow-toolbar')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Our next release ships on Friday.');
  await expect(page.locator('pre')).toContainText('npm install');
  expect(await page.locator('[contenteditable] flow-translation').count()).toBe(0);
  expect(await page.locator('nav flow-translation').count()).toBe(0);
  expect(await page.content()).not.toContain('test-key');
  await action(page, 'RESTORE_PAGE');
  await expect(page.locator('flow-translation')).toHaveCount(0);
  await expect(page.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  await page.close();
});

test('translates Primer popover and CSS tooltips on hover and keyboard focus without changing their controls', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/tooltips');
  await action(page, 'TRANSLATE_PAGE');
  const tip = page.locator('#primer-tip');
  await expect(tip).toBeHidden();
  await page.locator('#repositories').hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('全部仓库');
  await expect(tip).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#repositories')).toHaveAttribute('aria-labelledby', 'primer-tip');
  expect(
    await page.evaluate(
      () =>
        document.querySelector('#primer-tip')!.firstChild ===
        (window as unknown as { originalTooltipNode: Node }).originalTooltipNode,
    ),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/screenshots/tooltip-translated.png' });
  await page.locator('#repositories').click();
  expect(
    await page.evaluate(() => (window as unknown as { repositoryClicks: number }).repositoryClicks),
  ).toBe(1);
  await page.locator('#css-trigger').hover();
  await expect(page.locator('#css-tip')).toHaveText('刷新');
  await page.locator('#css-trigger').focus();
  await page.locator('#css-trigger').blur();
  await page.mouse.move(0, 0);
  await page.locator('#repositories').focus();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('全部仓库');
  await action(page, 'RESTORE_PAGE');
  await expect(tip).toHaveText('All repositories');
  await expect(page.locator('#css-tip')).toHaveText('Refresh');
  await expect(page.locator('body > div[aria-hidden]')).toHaveText('Private hidden text');
  await page.close();
});

test('rechecks dynamic tooltip text and rejects results after a tooltip changes or closes', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/tooltips');
  await action(page, 'TRANSLATE_PAGE');
  const before = requests.length;
  await page.locator('#dynamic-trigger').hover();
  await expect
    .poll(() =>
      requests.slice(before).some((request) => request.text.includes('slow original tooltip')),
    )
    .toBe(true);
  await page.locator('#dynamic-tip').evaluate((element) => {
    element.firstChild!.textContent = 'Instance details';
  });
  await expect(page.locator('#dynamic-tip')).toHaveText('实例详情');
  await page.locator('#dynamic-tip').evaluate((element) => {
    element.firstChild!.textContent = 'Show details';
  });
  await expect(page.locator('#dynamic-tip')).toHaveText('显示详情');
  await page.mouse.move(0, 0);
  await expect(page.locator('#dynamic-tip')).toHaveCount(0);
  const closedBefore = requests.length;
  await page.locator('#dynamic-trigger').hover();
  await expect(page.locator('#dynamic-tip')).toBeVisible();
  await page.locator('#dynamic-tip').evaluate((element) => {
    element.firstChild!.textContent = 'slow original closed tooltip';
  });
  await expect
    .poll(() =>
      requests
        .slice(closedBefore)
        .some((request) => request.text.includes('slow original closed tooltip')),
    )
    .toBe(true);
  await page.locator('#dynamic-tip').evaluate((element) => {
    (window as unknown as { closedTooltip: Element }).closedTooltip = element;
    element.remove();
  });
  await expect
    .poll(() =>
      requests
        .slice(closedBefore)
        .some(
          (request) => request.text.includes('slow original closed tooltip') && request.completed,
        ),
    )
    .toBe(true);
  await expect.poll(async () => (await pageStatus(page)).pending).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { closedTooltip: Element }).closedTooltip.textContent,
    ),
  ).toBe('slow original closed tooltip');
  expect(
    requests.slice(before).some((request) => request.text.includes('Private hidden text')),
  ).toBe(false);
  await page.close();
});

test('keeps all navigation labels translated after repeated tab renders', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/tabs');
  await action(page, 'TRANSLATE_PAGE');
  const tabs = page.getByRole('tab');
  const labels = ['概述', '免费套餐类别', '条款与条件'];
  await expect(tabs).toHaveText(labels);
  await page.evaluate(() => {
    (window as unknown as { savedTabs: Node[] }).savedTabs = [
      ...document.querySelectorAll('[role=tab] span'),
    ].map((element) => element.firstChild!);
  });
  for (const index of [1, 2, 0, 1, 2]) {
    await tabs.nth(index).click();
    await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toHaveText(labels);
    await expect(page.locator('h1')).toHaveText('AWS 免费套餐');
    await expect(page.locator('p')).toHaveText('免费开始使用');
  }
  await tabs.nth(2).press('ArrowRight');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs).toHaveText(labels);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('[role=tab] span')].every(
        (element, index) =>
          element.firstChild === (window as unknown as { savedTabs: Node[] }).savedTabs[index],
      ),
    ),
  ).toBe(true);
  await action(page, 'RESTORE_PAGE');
  await expect(tabs).toHaveText(['Overview', 'Free Tier Categories', 'Terms and Conditions']);
  await page.close();
});

test('keeps existing background translations while a menu hides them from accessibility', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/tabs');
  await action(page, 'TRANSLATE_PAGE');
  const tabs = page.locator('[role="tab"]');
  await expect(tabs).toHaveText(['概述', '免费套餐类别', '条款与条件']);
  await expect(page.locator('#view-title')).toHaveAttribute('placeholder', '标题');
  for (let index = 0; index < 3; index++) {
    await page.locator('#open-menu').click();
    await expect(page.locator('main')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('[role="dialog"] p')).toHaveText('显示详情');
    await expect(tabs).toHaveText(['概述', '免费套餐类别', '条款与条件']);
    await expect(page.locator('h1')).toHaveText('AWS 免费套餐');
    await expect(page.locator('#view-title')).toHaveAttribute('placeholder', '标题');
    await page.locator('#close-menu').click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  }
  await action(page, 'RESTORE_PAGE');
  await expect(tabs).toHaveText(['Overview', 'Free Tier Categories', 'Terms and Conditions']);
  await expect(page.locator('#view-title')).toHaveAttribute('placeholder', 'Title');
  await page.close();
});

test('translates placeholders and native title hints while preserving typed values and changed attributes', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/tabs');
  await action(page, 'TRANSLATE_PAGE');
  const before = requests.length;
  const title = page.locator('#view-title');
  await expect(title).toHaveAttribute('placeholder', '标题');
  await expect(page.locator('#view-description')).toHaveAttribute('placeholder', '添加描述');
  await expect(page.locator('#rename')).toHaveAttribute('title', '重命名视图');
  await title.fill('My private draft');
  await expect(page.locator('#draft-value')).toHaveText('My private draft');
  await page.locator('#view-description').fill('Private description');
  await page.locator('#rename').click();
  await expect(title).toHaveAttribute('placeholder', '新标题');
  await expect(title).toHaveValue('My private draft');
  await expect(page.locator('#password')).toHaveAttribute('placeholder', 'Private password hint');
  await expect(page.locator('#opted-out')).toHaveAttribute('placeholder', 'Keep this hint');
  await action(page, 'RESTORE_PAGE');
  await expect(title).toHaveAttribute('placeholder', 'New title');
  await expect(page.locator('#view-description')).toHaveAttribute(
    'placeholder',
    'Add a description',
  );
  await expect(page.locator('#rename')).toHaveAttribute('title', 'Rename view');
  await expect(title).toHaveValue('My private draft');
  await expect(page.locator('#view-description')).toHaveValue('Private description');
  expect(
    requests
      .slice(before)
      .some((request) =>
        /My private draft|Private description|Private password hint/.test(request.text),
      ),
  ).toBe(false);
  await page.close();
});

test('preserves a React console tree, form values and working controls after translation', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseUrl + '/console');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await action(page, 'TRANSLATE_PAGE');
  await expect(page.locator('h1')).toHaveText('实例');
  await expect(page.locator('#refresh')).toHaveText('刷新');
  await expect(page.locator('.state')).toHaveText('运行中');
  await expect.poll(async () => (await pageStatus(page)).pending).toBe(0);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { consoleFixture: { identityPreserved(): boolean } }
      ).consoleFixture.identityPreserved(),
    ),
  ).toBe(true);
  await expect(page.locator('flow-translation,flow-toolbar')).toHaveCount(0);
  await expect(page.locator('tbody > tr')).toHaveCount(1);
  await expect(page.locator('tbody > tr > td')).toHaveCount(3);
  await expect(page.locator('td').first()).toHaveText('i-0123456789abcdef0');
  await expect(page.locator('td').nth(2)).toHaveText('us-east-1');
  await expect(page.locator('#environment')).toHaveValue('Production');
  await expect(page.locator('#filter')).toHaveValue('production');
  await expect(page.locator('[contenteditable]')).toHaveText('Private draft');
  await page.locator('#filter').fill('staging');
  await page.locator('#environment').selectOption('Development');
  await page.locator('#selected').check();
  await page.locator('#refresh').click();
  await expect(page.locator('.state')).toHaveText('已停止');
  // React removes conditional Text and Element nodes here; replacing them with wrappers breaks this.
  await page.locator('#details-toggle').click();
  await expect(page.locator('#details')).toHaveCount(0);
  await page.locator('#details-toggle').click();
  await expect(page.locator('#details h2')).toHaveText('实例详情');
  await page.locator('#add-row').click();
  await expect(page.locator('tbody > tr')).toHaveCount(2);
  await expect(page.locator('.state').nth(1)).toHaveText('已停止');
  await page.locator('#documentation').click();
  expect(new URL(page.url()).hash).toBe('#documentation');
  await action(page, 'RESTORE_PAGE');
  await expect(page.locator('h1')).toHaveText('Instances');
  await expect(page.locator('.state').first()).toHaveText('Stopped');
  await expect(page.locator('#filter')).toHaveValue('staging');
  await expect(page.locator('#environment')).toHaveValue('Development');
  await expect(page.locator('#selected')).toBeChecked();
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/screenshots/console-restored.png', fullPage: true });
  await page.close();
});

test('translates only selected characters without replacing their Text object', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/console');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => {
    const text = document.querySelector('#selection')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 21);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await action(page, 'TRANSLATE_SELECTION');
  await expect(page.locator('#selection')).toHaveText('Before 选中文字 after');
  expect(await page.locator('#selection').evaluate((element) => element.childNodes.length)).toBe(1);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { consoleFixture: { identityPreserved(): boolean } }
      ).consoleFixture.identityPreserved(),
    ),
  ).toBe(true);
  await expect(page.locator('h1')).toHaveText('Instances');
  await action(page, 'RESTORE_PAGE');
  await expect(page.locator('#selection')).toHaveText('Before selected words after');
  await page.close();
});

test('streams in place and rejects pending results after app edits, restore and navigation', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl + '/console');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await options.locator('#clear-cache').click();
  const before = requests.length;
  await action(page, 'TRANSLATE_PAGE');
  await expect(page.locator('#stream')).toHaveText('正在逐步');
  await expect(page.locator('#stream')).toHaveText('正在逐步显示的译文。');
  await expect
    .poll(() =>
      requests.slice(before).some((request) => request.text.includes('slow original pending')),
    )
    .toBe(true);
  await page.evaluate(() => {
    document.querySelector('#pending')!.firstChild!.nodeValue = 'Stopped';
  });
  await expect(page.locator('#pending')).toHaveText('已停止');
  await action(page, 'RESTORE_PAGE');
  await expect(page.locator('#pending')).toHaveText('Stopped');
  await options.locator('#clear-cache').click();
  await action(page, 'TRANSLATE_PAGE');
  await expect(page.locator('#stream')).toHaveText('正在逐步');
  await action(page, 'RESTORE_PAGE');
  await page.waitForTimeout(1150);
  await expect(page.locator('#stream')).toHaveText('A deliberately streamed webpage paragraph.');
  await options.locator('#clear-cache').click();
  await action(page, 'TRANSLATE_PAGE');
  await expect(page.locator('#stream')).toHaveText('正在逐步');
  await page.evaluate(() => {
    history.pushState({}, '', '/console?view=other');
    document.querySelector('#stream')!.firstChild!.nodeValue = 'Stopped';
  });
  await expect(page.locator('#stream')).toHaveText('已停止');
  await action(page, 'RESTORE_PAGE');
  await expect(page.locator('#stream')).toHaveText('Stopped');
  await page.close();
});

test('adds and edits remembered websites without losing the old domain on validation or permission failure', async () => {
  const panel = await context.newPage();
  const original = await context.newPage();
  const replacement = await context.newPage();
  try {
    await original.goto('https://example.org/edit-original');
    await replacement.goto('https://sub.example.org/edit-replacement');
    await preapproveDomain('example.org');
    await preapproveDomain('sub.example.org');
    await panel.goto(`chrome-extension://${extensionId}/options.html`);
    const input = panel.getByLabel('网站域名', { exact: true });
    await input.fill(' EXAMPLE.org ');
    await panel.getByRole('button', { name: '添加网站', exact: true }).click();
    await expect(panel.locator('#page-auto-status')).toContainText('已添加 example.org');
    await expect(original.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
    expect((await settings()).pageAutoDomains).toEqual(['example.org']);
    await input.fill('example.org');
    await panel.getByRole('button', { name: '添加网站', exact: true }).click();
    await expect(panel.locator('#page-auto-status')).toContainText('已在常用网站');
    await panel.getByRole('button', { name: '编辑 example.org', exact: true }).click();
    await input.fill('https://sub.example.org/path');
    await panel.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(panel.locator('#page-auto-status')).toContainText('域名无效');
    expect((await settings()).pageAutoDomains).toEqual(['example.org']);
    await panel.getByRole('button', { name: '取消编辑', exact: true }).click();
    await expect(input).toHaveValue('');
    await panel.getByRole('button', { name: '编辑 example.org', exact: true }).click();
    await input.fill('sub.example.org');
    await panel.evaluate(() => {
      Object.defineProperty(chrome.permissions, 'request', { value: async () => false });
    });
    await panel.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(panel.locator('#page-auto-status')).toContainText('未授予');
    await expect(input).toHaveValue('sub.example.org');
    expect((await settings()).pageAutoDomains).toEqual(['example.org']);
    await expect(original.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
    await panel.reload();
    await panel.getByRole('button', { name: '编辑 example.org', exact: true }).click();
    await input.fill('sub.example.org');
    await panel.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(panel.locator('#page-auto-status')).toContainText(
      '已将 example.org 修改为 sub.example.org',
    );
    expect((await settings()).pageAutoDomains).toEqual(['sub.example.org']);
    await expect(original.locator('#paragraph-one')).toHaveText(
      'Our next release ships on Friday.',
    );
    await expect(replacement.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
    const scripts = await panel.evaluate(() =>
      chrome.scripting.getRegisteredContentScripts({ ids: ['flow-page-auto'] }),
    );
    expect(scripts[0]?.matches).toEqual(['*://sub.example.org/*']);
    const denied = await panel.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'EDIT_PAGE_AUTO',
        domain: 'sub.example.org',
        nextDomain: 'example.net',
      }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('尚未授权');
    expect((await settings()).pageAutoDomains).toEqual(['sub.example.org']);
    const untrusted = await panel.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: () =>
          chrome.runtime.sendMessage({
            type: 'EDIT_PAGE_AUTO',
            domain: 'sub.example.org',
            nextDomain: 'example.org',
          }),
      });
      return result?.result;
    }, replacement.url());
    expect(untrusted.ok).toBe(false);
    expect(untrusted.error).toContain('仅限扩展');
    await panel.reload();
    await expect(panel.locator('#page-auto-domains')).toContainText('sub.example.org');
    await panel
      .locator('.translation-preferences')
      .screenshot({ path: 'test-results/screenshots/website-preferences.png' });
    await panel
      .getByRole('button', { name: '取消 sub.example.org 的自动翻译', exact: true })
      .click();
    await expect(replacement.locator('#paragraph-one')).toHaveText(
      'Our next release ships on Friday.',
    );
  } finally {
    for (const domain of (await settings()).pageAutoDomains)
      await options.evaluate(
        (domain) => chrome.runtime.sendMessage({ type: 'SET_PAGE_AUTO', domain, enabled: false }),
        domain,
      );
    await Promise.all([panel.close(), original.close(), replacement.close()]);
  }
});

test('separates webpage and Discord tabs and lists individual automatic channels with links and live updates', async () => {
  const previous = await settings();
  const panel = await context.newPage();
  const channel = await context.newPage();
  try {
    await channel.goto('https://discord.com/channels/777/888');
    await channel.evaluate(() => {
      document.title = '#general · Example server';
    });
    await panel.goto(`chrome-extension://${extensionId}/options.html`);
    for (const channel of ['/channels/777/888', '/channels/@me/999'])
      await panel.evaluate(
        (channel) =>
          chrome.runtime.sendMessage({ type: 'SET_DISCORD_AUTO', channel, enabled: true }),
        channel,
      );
    await panel.goto(`chrome-extension://${extensionId}/options.html`);
    const webTab = panel.getByRole('tab', { name: '普通网页', exact: true });
    const discordTab = panel.getByRole('tab', { name: 'Discord', exact: true });
    await expect(webTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('#web-preferences')).toBeVisible();
    await expect(panel.locator('#discord-preferences')).toBeHidden();
    await webTab.focus();
    await webTab.press('ArrowRight');
    await expect(discordTab).toBeFocused();
    await expect(discordTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('#web-preferences')).toBeHidden();
    await expect(panel.locator('#discord-preferences')).toBeVisible();
    const active = panel.locator('#discord-auto-channels');
    await expect(
      active.getByRole('link', { name: '#general · Example server', exact: true }),
    ).toHaveAttribute('href', 'https://discord.com/channels/777/888');
    await expect(active.getByRole('link', { name: '私信 999', exact: true })).toHaveAttribute(
      'href',
      'https://discord.com/channels/@me/999',
    );
    await expect(panel.locator('#auto-summary')).toContainText('2 个频道');
    await panel
      .locator('.translation-preferences')
      .screenshot({ path: 'test-results/screenshots/discord-preferences.png' });
    await panel
      .getByRole('button', { name: '关闭 /channels/777/888 的自动翻译', exact: true })
      .click();
    await expect(panel.locator('#auto-summary')).toContainText('1 个频道');
    expect((await settings()).discordAutoChannels).toEqual(['/channels/@me/999']);
    await options.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'SET_DISCORD_AUTO',
        channel: '/channels/777/111',
        enabled: true,
      }),
    );
    await expect(active.getByRole('link', { name: '频道 111', exact: true })).toBeVisible();
    await panel.locator('#disable-auto').click();
    await expect(active).toContainText('尚未开启任何频道');
    await expect(panel.locator('#disable-auto')).toBeDisabled();
    expect((await settings()).discordAutoChannels).toEqual([]);
    await discordTab.focus();
    await discordTab.press('Home');
    await expect(webTab).toBeFocused();
    await expect(panel.locator('#web-preferences')).toBeVisible();
    await panel.setViewportSize({ width: 390, height: 800 });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await panel
      .locator('.translation-preferences')
      .screenshot({ path: 'test-results/screenshots/preferences-mobile.png' });
  } finally {
    for (const channel of (await settings()).discordAutoChannels)
      await options.evaluate(
        (channel) =>
          chrome.runtime.sendMessage({ type: 'SET_DISCORD_AUTO', channel, enabled: false }),
        channel,
      );
    for (const channel of previous.discordAutoChannels)
      await options.evaluate(
        (channel) =>
          chrome.runtime.sendMessage({ type: 'SET_DISCORD_AUTO', channel, enabled: true }),
        channel,
      );
    await Promise.all([panel.close(), channel.close()]);
  }
});

test('remembers exact webpage domains and translates future visits without opening the popup', async () => {
  const page = await context.newPage();
  await page.goto('https://example.org/auto-first');
  await grantActiveTab(page);
  await expect(page.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  const staleSettings = await settings();
  await preapproveDomain('example.org');
  const popup = await openPopup(page);
  await expect(popup.locator('#page-auto-domain')).toContainText('example.org');
  await popup.locator('#page-auto').click();
  await expect(popup.locator('#status')).toContainText('已记住 example.org');
  await expect(page.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  await expect(options.locator('#page-auto-domains')).toContainText('example.org');
  await saveSettings(staleSettings);
  expect((await settings()).pageAutoDomains).toEqual(['example.org']);
  const registrations = await options.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts({ ids: ['flow-page-auto'] }),
  );
  expect(registrations[0]).toMatchObject({
    matches: ['*://example.org/*'],
    persistAcrossSessions: true,
    allFrames: false,
  });
  const session = await context.newCDPSession(options);
  const targets = await session.send('Target.getTargets');
  const worker = targets.targetInfos.find(
    (target) => target.type === 'service_worker' && target.url.includes(extensionId),
  )!;
  await session.send('Target.closeTarget', { targetId: worker.targetId });
  await session.detach();
  const next = await context.newPage();
  await next.goto('https://example.org/auto-next');
  await expect(next.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  await next.evaluate(() => {
    history.pushState({}, '', '/auto-spa');
    document.querySelector('#paragraph-one')!.textContent = 'This is an edited message.';
  });
  await expect(next.locator('#paragraph-one')).toHaveText('这是一条编辑后的消息。');
  const restorePopup = await openPopup(next);
  await restorePopup.setViewportSize({ width: 380, height: 600 });
  const restorePoint = await popupActionPoint(restorePopup, 'restore');
  await restorePopup.mouse.click(restorePoint.x, restorePoint.y);
  await expect(restorePopup.locator('#status')).toContainText('此页暂不自动翻译');
  await restorePopup.close();
  await expect(next.locator('#paragraph-one')).toHaveText('This is an edited message.');
  expect((await settings()).pageAutoDomains).toEqual(['example.org']);
  expect(await next.locator('flow-translation,flow-toolbar').count()).toBe(0);
  await next.reload();
  await expect(next.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  const other = await context.newPage();
  await other.goto('https://sub.example.org/auto-other');
  await expect(other.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  await grantActiveTab(other);
  await preapproveDomain('sub.example.org');
  const otherPopup = await openPopup(other);
  await otherPopup.locator('#page-auto').check();
  await expect(other.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  expect((await settings()).pageAutoDomains).toEqual(['example.org', 'sub.example.org']);
  const currentPopup = await openPopup(next);
  await expect(currentPopup.locator('#page-auto')).toBeChecked();
  await currentPopup.setViewportSize({ width: 380, height: 600 });
  await currentPopup.screenshot({ path: 'test-results/screenshots/domain-auto.png' });
  await options.getByRole('button', { name: '取消 example.org 的自动翻译', exact: true }).click();
  await expect(page.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  await expect(next.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  await expect(currentPopup.locator('#page-auto')).not.toBeChecked();
  expect((await settings()).pageAutoDomains).toEqual(['sub.example.org']);
  await expect(otherPopup.locator('#page-auto')).toBeChecked();
  await next.reload();
  await expect(next.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  await options
    .getByRole('button', { name: '取消 sub.example.org 的自动翻译', exact: true })
    .click();
  await expect(other.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  expect((await settings()).pageAutoDomains).toEqual([]);
  await Promise.all([
    popup.close(),
    currentPopup.close(),
    otherPopup.close(),
    page.close(),
    next.close(),
    other.close(),
  ]);
});

test('requires domain permission and trusted UI, and stops pending automatic results after disabling or revocation', async () => {
  const denied = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SET_PAGE_AUTO', domain: 'example.net', enabled: true }),
  );
  expect(denied.ok).toBe(false);
  expect(denied.error).toContain('尚未授权');
  const page = await context.newPage();
  await page.goto('https://example.net/auto-denied');
  await grantActiveTab(page);
  const deniedPopup = await openPopup(page);
  await deniedPopup.evaluate(() => {
    Object.defineProperty(chrome.permissions, 'request', { value: async () => false });
  });
  await deniedPopup.locator('#page-auto').click();
  await expect(deniedPopup.locator('#status')).toContainText('未授予');
  await expect(deniedPopup.locator('#page-auto')).not.toBeChecked();
  expect((await settings()).pageAutoDomains).toEqual([]);
  await deniedPopup.close();
  await page.goto('https://example.org/auto-cancel');
  await grantActiveTab(page);
  const popup = await openPopup(page);
  await page.evaluate(() => {
    document.querySelector('#paragraph-one')!.textContent =
      'Our next release has a slow original translation.';
  });
  const before = requests.length;
  await popup.locator('#page-auto').check();
  await expect
    .poll(() =>
      requests.slice(before).some((request) => request.text.includes('slow original translation')),
    )
    .toBe(true);
  await popup.locator('#page-auto').uncheck();
  await expect(popup.locator('#status')).toContainText('已关闭此域名');
  await page.waitForTimeout(1100);
  await expect(page.locator('#paragraph-one')).toHaveText(
    'Our next release has a slow original translation.',
  );
  const untrusted = await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: () =>
        chrome.runtime.sendMessage({ type: 'SET_PAGE_AUTO', domain: 'example.org', enabled: true }),
    });
    return result?.result;
  }, page.url());
  expect(untrusted.ok).toBe(false);
  expect(untrusted.error).toContain('仅限扩展');
  await page.evaluate(() => {
    document.querySelector('#paragraph-one')!.textContent = 'Our next release ships on Friday.';
  });
  await popup.locator('#page-auto').check();
  await expect(page.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  await options.evaluate(() => chrome.permissions.remove({ origins: ['*://example.org/*'] }));
  await expect.poll(async () => (await settings()).pageAutoDomains).toEqual([]);
  await expect(page.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  await expect(popup.locator('#page-auto')).not.toBeChecked();
  const registered = await options.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts({ ids: ['flow-page-auto'] }),
  );
  expect(registered).toEqual([]);
  await page.reload();
  await expect(page.locator('#paragraph-one')).toHaveText('Our next release ships on Friday.');
  await popup.close();
  await page.close();
});

test('keeps the live public AWS EC2 page structure and navigation working', async () => {
  test.skip(
    process.env.FLOW_TEST_AWS !== '1',
    'Opt in to the public AWS network check with FLOW_TEST_AWS=1.',
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('https://aws.amazon.com/ec2/', { waitUntil: 'domcontentloaded' });
  const heading = page.locator('h1').first();
  await expect(heading).toContainText('Amazon EC2');
  await heading.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const heading = document.querySelector('h1')!;
    const children = [...heading.childNodes];
    (window as unknown as { awsHeadingUnchanged: () => boolean }).awsHeadingUnchanged = () =>
      document.querySelector('h1') === heading &&
      children.every((node, index) => heading.childNodes[index] === node);
  });
  await grantActiveTab(page);
  await action(page, 'TRANSLATE_PAGE');
  await expect(heading).toContainText('亚马逊 EC2', { timeout: 45000 });
  expect(
    await page.evaluate(() =>
      (window as unknown as { awsHeadingUnchanged: () => boolean }).awsHeadingUnchanged(),
    ),
  ).toBe(true);
  await expect(page.locator('flow-translation,flow-toolbar')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/screenshots/aws-translated.png' });
  await action(page, 'RESTORE_PAGE');
  await expect(heading).toContainText('Amazon EC2');
  await action(page, 'TRANSLATE_PAGE');
  await expect(heading).toContainText('亚马逊 EC2', { timeout: 45000 });
  // AWS hydration can add tracking parameters and replace the original anchor.
  const link = page.locator('a[href^="/ec2/getting-started"]').filter({ visible: true }).first();
  await expect(link).toHaveAttribute('href', /^\/ec2\/getting-started(?:[/?#]|$)/);
  await link.scrollIntoViewIfNeeded();
  await link.click({ timeout: 15000 });
  await expect(page).toHaveURL(/aws\.amazon\.com\/ec2\/getting-started/);
  expect(
    errors.filter((message) => /NotFoundError|removeChild|insertBefore/.test(message)),
  ).toEqual([]);
  await page.close();
});

test('keeps the real AWS Free Tier navigation translated while opening other tabs and menus', async () => {
  test.setTimeout(180000);
  test.skip(process.env.FLOW_TEST_AWS !== '1', 'Opt in to live AWS pages with FLOW_TEST_AWS=1.');
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('https://aws.amazon.com/free/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const more = page.locator('li[data-rg-n="Popover"][aria-label="More submenu"]');
  const categories = page.locator(
    'li[data-rg-n="Popover"][aria-label="Free Tier Categories submenu"]',
  );
  await expect(more).toBeVisible({ timeout: 30000 });
  await expect
    .poll(
      () =>
        more.evaluate((element) =>
          Object.keys(element).some((key) => key.startsWith('__reactProps')),
        ),
      { timeout: 90000 },
    )
    .toBe(true);
  const moreLabel = more.locator('[data-rg-n="BodyText"]').first();
  const categoriesLabel = categories.locator('[data-rg-n="BodyText"]').first();
  const terms = page
    .locator('a[href*="/free/terms/"][href*="z=subnav"]')
    .filter({ visible: true })
    .first();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await more.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await grantActiveTab(page);
  await action(page, 'TRANSLATE_PAGE');
  await expect(moreLabel).toHaveText('更多');
  await expect(categoriesLabel).toHaveText('免费套餐类别');
  await expect(terms).toHaveText('条款与条件');
  await expect(page.locator('h1').first()).toHaveText('AWS 免费套餐', { timeout: 45000 });
  for (const trigger of [more, categories, more, categories, more]) {
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(moreLabel).toHaveText('更多');
    await expect(categoriesLabel).toHaveText('免费套餐类别');
    await expect(terms).toHaveText('条款与条件');
    await expect(page.locator('h1').first()).toHaveText('AWS 免费套餐');
  }
  await page.screenshot({ path: 'test-results/screenshots/aws-free-tabs.png' });
  await action(page, 'RESTORE_PAGE');
  await expect(moreLabel).toHaveText('More');
  await expect(categoriesLabel).toHaveText('Free Tier Categories');
  expect(
    errors.filter((message) => /NotFoundError|removeChild|insertBefore/.test(message)),
  ).toEqual([]);
  await page.close();
});

test('supports per-message provider switching and explicit Discord channel automation', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/2');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  const before = requests.length;
  await page.waitForTimeout(300);
  expect(requests.length).toBe(before);
  const first = page.locator('flow-translation').first();
  await first.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(first.locator('.output')).toHaveText('下一个版本将于周五发布。');
  const values = await settings();
  const alternative = values.providers.find((provider) => provider.name === '备用接口')!;
  const select = first.getByLabel('此条译文使用的接口');
  await chooseBackup(select);
  await expect(select).toHaveValue(alternative.id);
  await expect(first.locator('.output')).toHaveText('备用译法：下一个版本将于周五发布。');
  await setAuto(page, true);
  await expect(page.locator('flow-translation').nth(1).locator('.output')).toContainText('评审');
  await page.evaluate(() => {
    const li = document.createElement('li');
    li.id = 'chat-messages-1-104';
    const message = document.createElement('div');
    message.id = 'message-content-104';
    message.textContent = 'We already deployed the update.';
    li.append(message);
    document.querySelector('#chat-list')!.append(li);
  });
  await expect(page.locator('flow-translation').nth(2).locator('.output')).toHaveText(
    '我们已经部署了更新。',
  );
  await expect(page.getByRole('textbox')).toHaveText('Do not translate this private draft.');
  await page.screenshot({ path: 'test-results/screenshots/discord.png', fullPage: true });
  await setAuto(page, false);
  const afterOff = requests.length;
  await page.evaluate(() => {
    document.querySelector('#message-content-104')!.textContent =
      'This edited message should wait for a manual click.';
  });
  await page.waitForTimeout(650);
  expect(requests.length).toBe(afterOff);
  await expect(page.locator('flow-translation').nth(2).locator('.output')).toHaveText('');
  await page.close();
});

test('keeps page scripts from translating and moves provider and auto controls into the popup', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/5');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await expect(page.locator('flow-toolbar')).toHaveCount(0);
  const before = requests.length;
  await page.evaluate(() => {
    const root = document.querySelector('flow-translation')!.shadowRoot!;
    const select = root.querySelector('select')!;
    select.selectedIndex = 1;
    select.dispatchEvent(new Event('change'));
    root.querySelector('button')!.click();
  });
  await page.waitForTimeout(350);
  expect(requests.length).toBe(before);
  const first = page.locator('flow-translation').first();
  await first.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(first.locator('.output')).toHaveText('下一个版本将于周五发布。');
  await expect(first.locator('.meta')).toHaveText(/^识别为：.+/);
  expect(await first.locator('.meta').textContent()).not.toMatch(/缓存|Ollama|自动识别|优先/);
  const popup = await openPopup(page);
  const alternative = (await settings()).providers.find(
    (provider) => provider.name === '备用接口',
  )!;
  await popup.locator('#provider').selectOption(alternative.id);
  await popup.locator('#discord-auto').check();
  await expect(page.locator('flow-translation').nth(1).locator('.output')).toContainText(
    '备用译法',
  );
  await popup.locator('#discord-auto').uncheck();
  await popup.locator('#provider').selectOption('local-ollama');
  await expect.poll(async () => (await settings()).activeProviderId).toBe('local-ollama');
  await popup.close();
  await page.close();
});

test('does not carry auto translation into another Discord channel or display stale edited results', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/2');
  await setAuto(page, true);
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent = 'A slow original message.';
  });
  await expect
    .poll(() => requests.some((request) => request.text.includes('slow original')))
    .toBe(true);
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent = 'This is an edited message.';
  });
  await expect(page.locator('flow-translation').first().locator('.output')).toHaveText(
    '这是一条编辑后的消息。',
  );
  await page.evaluate(() => {
    history.pushState({}, '', '/channels/1/3');
  });
  await expect.poll(() => channelAuto(page)).toBe(false);
  await expect(page.locator('flow-translation').first().locator('.output')).toBeEmpty();
  const count = requests.length;
  await page.waitForTimeout(500);
  expect(requests.length).toBe(count);
  await page.close();
});

test('enables translation from the popup after Discord changes channels without a reload', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/99/200');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await page.evaluate(() => {
    history.pushState({}, '', '/channels/99/201');
    document.querySelector('#message-content-101')!.textContent = 'This is an edited message.';
  });
  await expect.poll(() => channelAuto(page)).toBe(false);
  const popup = await context.newPage();
  await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    await chrome.tabs.update(tab.id!, { active: true });
  }, page.url());
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#discord-auto').check();
  await expect(popup.locator('#discord-auto')).toBeChecked();
  await expect.poll(() => channelAuto(page)).toBe(true);
  await expect(page.locator('flow-translation').first().locator('.output')).toHaveText(
    '这是一条编辑后的消息。',
  );
  await expect.poll(() => channelAuto(page)).toBe(true);
  await expect(page.locator('flow-translation .error')).toHaveCount(0);
  await setAuto(page, false);
  await expect
    .poll(async () => (await settings()).discordAutoChannels.includes('/channels/99/201'))
    .toBe(false);
  await expect(popup.locator('#discord-auto')).not.toBeChecked();
  await popup.close();
  await page.close();
});

test('preserves channel switches across servers, direct messages and browser back/forward', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/98/100');
  await setAuto(page, true);
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await page.evaluate(() => {
    history.pushState({}, '', '/channels/97/101');
  });
  await expect.poll(() => channelAuto(page)).toBe(false);
  await setAuto(page, true);
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await page.evaluate(() => {
    history.pushState({}, '', '/channels/@me/102');
  });
  await expect.poll(() => channelAuto(page)).toBe(false);
  // Manual translation remains available with auto disabled in the new DM.
  await page
    .locator('flow-translation')
    .first()
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await setAuto(page, true);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL('https://discord.com/channels/97/101');
  await expect.poll(() => channelAuto(page)).toBe(true);
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL('https://discord.com/channels/@me/102');
  await expect.poll(() => channelAuto(page)).toBe(true);
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await expect(page.locator('flow-toolbar')).toHaveCount(0);
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await expect(page.locator('flow-translation .error')).toHaveCount(0);
  await setAuto(page, false);
  await page.screenshot({
    path: 'test-results/screenshots/discord-channel-switch.png',
    fullPage: true,
  });
  await page.close();
});

test('does not let an old channel failure disable automatic translation in the new channel', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/96/300');
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent = 'A delayed channel failure.';
  });
  await expect(page.locator('flow-translation').first().locator('.meta')).toContainText(
    '消息已更新',
  );
  const before = requests.length;
  await setAuto(page, true);
  await expect
    .poll(() =>
      requests.slice(before).some((request) => request.text.includes('delayed channel failure')),
    )
    .toBe(true);
  await page.evaluate(() => {
    history.pushState({}, '', '/channels/96/301');
    document.querySelector('#message-content-101')!.textContent = 'This is an edited message.';
  });
  // Injecting an action synchronizes the route immediately, before the polling timer fires.
  await action(page, 'TRANSLATE_PAGE');
  await setAuto(page, true);
  await expect(page.locator('flow-translation').first().locator('.output')).toHaveText(
    '这是一条编辑后的消息。',
  );
  await expect.poll(() => channelAuto(page)).toBe(true);
  const enabled = (await settings()).discordAutoChannels;
  expect(enabled).toContain('/channels/96/300');
  expect(enabled).toContain('/channels/96/301');
  await expect(page.locator('flow-translation .error')).toHaveCount(0);
  await setAuto(page, false);
  await page.close();
});

test('reinjects and restarts a content script without duplicate Discord controls', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/95/400');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await action(page, 'TRANSLATE_PAGE');
  await action(page, 'TRANSLATE_PAGE');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await expect
    .poll(async () =>
      (await page.locator('flow-translation .meta').allTextContents()).some((text) =>
        text.includes('正在翻译'),
      ),
    )
    .toBe(false);
  await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: () => {
        (window as unknown as { __flowTranslate: { stop(): void } }).__flowTranslate.stop();
        // Emulate leftover markup from a prior version, in addition to a stopped instance.
        const orphan = document.createElement('flow-translation');
        orphan.dataset.flowUi = '';
        document.querySelector('#message-content-101')!.after(orphan);
      },
    });
  }, page.url());
  await action(page, 'TRANSLATE_PAGE');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await expect(page.locator('flow-toolbar')).toHaveCount(0);
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await page.evaluate(() => {
    history.pushState({}, '', '/channels/95/401');
  });
  await expect.poll(() => channelAuto(page)).toBe(false);
  await setAuto(page, true);
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await page.waitForTimeout(800);
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await expect(page.locator('flow-toolbar')).toHaveCount(0);
  await setAuto(page, false);
  await page.close();
});

test('isolates credentials from webpage scripts and survives an MV3 worker restart', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/3');
  expect(
    await page.evaluate(
      () => typeof (globalThis as { chrome?: { storage?: unknown } }).chrome?.storage,
    ),
  ).toBe('undefined');
  const restrictions = await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    if (tab?.id == null) throw new Error('Fixture tab unavailable');
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const storageDenied = await chrome.storage.local.get('settings').then(
          () => false,
          () => true,
        );
        const reply = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        return { storageDenied, privateSettingsDenied: !reply.ok };
      },
    });
    return result?.result;
  }, page.url());
  expect(restrictions).toEqual({ storageDenied: true, privateSettingsDenied: true });
  const session = await context.newCDPSession(options);
  const workers = await session.send('Target.getTargets');
  const target = workers.targetInfos.find(
    (target) => target.type === 'service_worker' && target.url.includes(extensionId),
  );
  expect(target).toBeTruthy();
  await session.send('Target.closeTarget', { targetId: target!.targetId });
  await options.locator('#clear-cache').click();
  await expect(options.locator('#form-status')).toContainText('缓存已清除');
  await page
    .locator('flow-translation')
    .first()
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('flow-translation').first().locator('.output')).not.toBeEmpty();
  await page.close();
});

test('shows partial translations before a slow stream completes', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/8');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent =
      'A deliberately streamed message.';
  });
  const entry = page.locator('flow-translation').first();
  await expect(entry.getByRole('button', { name: '翻译', exact: true })).toBeVisible();
  // Wait for message extraction to reflect the edited text.
  await expect(entry.locator('.meta')).toContainText('消息已更新');
  await entry.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(entry.locator('.output')).toHaveText('正在逐步');
  await expect(entry.locator('.meta')).toContainText('正在翻译');
  await expect(entry.locator('.output')).toHaveText('正在逐步显示的译文。');
  await expect(entry.getByRole('button', { name: '重新翻译', exact: true })).toBeEnabled();
  await entry.getByRole('button', { name: '重新翻译', exact: true }).click();
  await expect(entry.locator('.output')).toHaveText('正在逐步');
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent = 'This is an edited message.';
  });
  await expect(entry.locator('.meta')).toContainText('消息已更新');
  await page.waitForTimeout(1100);
  await expect(entry.locator('.output')).toBeEmpty();
  await page.close();
});

test('automatically translates Japanese, Korean, Russian, French, and Arabic alongside English', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/9');
  const messages = [
    'こんにちは、次のリリースは金曜日です。',
    '안녕하세요. 다음 출시는 금요일입니다.',
    'Привет, следующий выпуск выйдет в пятницу.',
    'Bonjour, la prochaine version sera publiée vendredi.',
    'مرحبا، الإصدار التالي سيكون يوم الجمعة.',
  ];
  await page.evaluate((texts) => {
    texts.forEach((text, index) => {
      const li = document.createElement('li');
      li.id = `chat-messages-1-${200 + index}`;
      const message = document.createElement('div');
      message.id = `message-content-${200 + index}`;
      message.textContent = text;
      li.append(message);
      document.querySelector('#chat-list')!.append(li);
    });
  }, messages);
  await setAuto(page, true);
  for (let index = 0; index < messages.length; index++) {
    const message = page.locator(`#message-content-${200 + index}`);
    await message.scrollIntoViewIfNeeded();
    const entry = page.locator(`#message-content-${200 + index} + flow-translation`);
    await expect(entry.locator('.output')).toContainText('周五');
    if (index === 0) await expect(entry.locator('.meta')).toContainText('日语');
    if (index === 1) await expect(entry.locator('.meta')).toContainText('韩语');
  }
  await setAuto(page, false);
  await page.close();
});

test('keeps cached translations across auto toggles and MV3 suspension without storing them on disk', async () => {
  await options.locator('#clear-cache').click();
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/7');
  const first = page.locator('flow-translation').first();
  await first.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(first.locator('.output')).not.toBeEmpty();
  await setAuto(page, true);
  await expect(page.locator('flow-translation').nth(1).locator('.output')).not.toBeEmpty();
  await setAuto(page, false);
  await expect
    .poll(() =>
      options.evaluate(async () =>
        Boolean(
          (
            (await chrome.storage.session.get('translationCache')).translationCache as
              | { entries?: unknown[] }
              | undefined
          )?.entries?.length,
        ),
      ),
    )
    .toBe(true);
  const before = requests.length;
  const session = await context.newCDPSession(options);
  const targets = await session.send('Target.getTargets');
  const worker = targets.targetInfos.find(
    (target) => target.type === 'service_worker' && target.url.includes(extensionId),
  );
  expect(worker).toBeTruthy();
  await session.send('Target.closeTarget', { targetId: worker!.targetId });
  await page.close();
  const revisit = await context.newPage();
  await revisit.goto('https://discord.com/channels/1/7');
  const cached = revisit.locator('flow-translation').first();
  await cached.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(cached.locator('.meta')).toHaveText(/^识别为：.+/);
  expect(requests.length).toBe(before);
  expect(
    await options.evaluate(
      async () => (await chrome.storage.local.get('translationCache')).translationCache,
    ),
  ).toBeUndefined();
  await revisit.close();
});

test('moves a manually selected message ahead of waiting automatic messages', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/10');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent =
      'A slow original priority blocker.';
    document.querySelector('#message-content-102')!.textContent =
      'Background priority pending message.';
    const li = document.createElement('li');
    li.id = 'chat-messages-1-105';
    const message = document.createElement('div');
    message.id = 'message-content-105';
    message.textContent = 'Manual priority message.';
    li.append(message);
    document.querySelector('#chat-list')!.append(li);
  });
  await expect(page.locator('flow-translation')).toHaveCount(3);
  const before = requests.length;
  await setAuto(page, true);
  await expect
    .poll(() =>
      requests.slice(before).some((request) => request.text.includes('slow original priority')),
    )
    .toBe(true);
  const manual = page.locator('#message-content-105 + flow-translation');
  await manual.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(manual.locator('.output')).not.toBeEmpty();
  await expect(page.locator('#message-content-102 + flow-translation .output')).not.toBeEmpty();
  const order = requests.slice(before).map((request) => request.text);
  expect(order.findIndex((text) => text.includes('Manual priority'))).toBeLessThan(
    order.findIndex((text) => text.includes('Background priority')),
  );
  await setAuto(page, false);
  await page.close();
});

test('handles authorization failures visibly and pauses automatic translation', async () => {
  const previous = await settings();
  await saveSettings({
    ...previous,
    providers: previous.providers.map((provider) => ({ ...provider, apiKey: 'invalid-key' })),
  });
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/1/4');
  const popup = await openPopup(page);
  await popup.locator('#discord-auto').check();
  await expect(
    page.locator('flow-translation .output').filter({ hasText: 'HTTP 401' }),
  ).toHaveCount(1);
  await expect.poll(() => channelAuto(page)).toBe(false);
  await expect
    .poll(() =>
      options.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
        return (await chrome.tabs.sendMessage(tab.id!, { type: 'GET_STATUS' })).notice;
      }, page.url()),
    )
    .toContain('自动翻译已暂停');
  await saveSettings(previous);
  await popup.close();
  await page.close();
});

test('switches Discord between bilingual and translation-only modes without losing originals', async () => {
  await options.getByRole('tab', { name: 'Discord', exact: true }).click();
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/87/1');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  const original = page.locator('#message-content-101');
  await original.evaluate((element) => {
    element.style.display = 'block';
  });
  const entry = page.locator('flow-translation').first();
  await entry.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(entry.locator('.output')).toHaveText('下一个版本将于周五发布。');
  await expect(original).toBeVisible();
  await options.locator('#discord-display-mode').selectOption('translation-only');
  await expect(original).toBeHidden();
  await expect(entry.locator('.output')).toBeVisible();
  await expect(original).toHaveText('Our next release ships on Friday.');
  await expect(entry.locator('.meta')).toHaveText(/^识别为：.+/);
  await options.locator('#discord-display-mode').selectOption('bilingual');
  await expect(original).toBeVisible();
  await options.locator('#discord-display-mode').selectOption('translation-only');
  await expect(original).toBeHidden();
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent = 'This is an edited message.';
  });
  await expect(original).toBeVisible();
  await entry.getByRole('button', { name: '重新翻译', exact: true }).click();
  await expect(entry.locator('.output')).toHaveText('这是一条编辑后的消息。');
  await expect(original).toBeHidden();
  await action(page, 'RESTORE_PAGE');
  await expect(original).toBeVisible();
  await expect(original).toHaveText('This is an edited message.');
  expect(await original.evaluate((element) => element.style.display)).toBe('block');
  await expect(page.locator('flow-toolbar')).toHaveCount(0);
  await options.locator('#discord-display-mode').selectOption('bilingual');
  await page.close();
});

test('mounts the composer action before native tools and remembers its right-click language selection', async () => {
  const previous = await settings();
  await saveSettings({ ...previous, outgoingTargetLanguage: 'en' });
  const page = await context.newPage();
  try {
    await page.goto('https://discord.com/channels/88/10');
    const control = page.locator('flow-composer');
    const trigger = control.getByRole('button', { name: '翻译成英语', exact: true });
    await expect(trigger).toBeVisible();
    expect(
      await control.evaluate((element) => element.parentElement?.firstElementChild === element),
    ).toBe(true);
    await page.locator('#native-emoji').click();
    expect(
      await page.evaluate(() => (window as unknown as { emojiClicks: number }).emojiClicks),
    ).toBe(1);
    const before = requests.length;
    await control.evaluate((element) => {
      const button = element.shadowRoot!.querySelector('button')!;
      button.click();
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await expect(control.getByRole('dialog')).toHaveCount(0);
    await expect(control.getByRole('menu')).toHaveCount(0);
    expect(requests.length).toBe(before);
    await trigger.click({ button: 'right' });
    await expect(control.getByRole('menu', { name: '发送目标语言' })).toBeVisible();
    await control.getByRole('menuitemradio', { name: '日语', exact: true }).click();
    await expect(control.getByRole('button', { name: '翻译成日语', exact: true })).toBeVisible();
    await expect.poll(async () => (await settings()).outgoingTargetLanguage).toBe('ja');
    expect((await settings()).targetLanguage).toBe('zh-CN');
    expect(requests.length).toBe(before);
    const popup = await openPopup(page);
    await expect(popup.locator('#outgoing-language')).toHaveValue('ja');
    await popup.locator('#draft-panel summary').click();
    await popup.locator('#outgoing-language').selectOption('en');
    await expect(control.getByRole('button', { name: '翻译成英语', exact: true })).toBeVisible();
    await popup.close();
    await page.bringToFront();
    await trigger.focus();
    await trigger.press('Shift+F10');
    await expect(control.getByRole('menu')).toBeVisible();
    await control.getByRole('menuitemradio', { name: '英语', exact: true }).press('ArrowDown');
    await control.getByRole('menuitemradio', { name: '日语', exact: true }).press('Enter');
    await expect.poll(async () => (await settings()).outgoingTargetLanguage).toBe('ja');
    await page.reload();
    await expect(
      page.locator('flow-composer').getByRole('button', { name: '翻译成日语', exact: true }),
    ).toBeVisible();
    await page
      .locator('flow-composer')
      .getByRole('button', { name: '翻译成日语', exact: true })
      .click({ button: 'right' });
    await page.screenshot({ path: 'test-results/screenshots/composer-language-menu.png' });
    await page
      .locator('flow-composer')
      .getByRole('menuitemradio', { name: '日语', exact: true })
      .press('Escape');
    await expect(page.locator('flow-composer').getByRole('menu')).toHaveCount(0);
  } finally {
    await page.close();
    await saveSettings(previous);
  }
});

test('previews composer translations and replaces real Slate state without sending or losing native tools', async () => {
  const previous = await settings();
  await saveSettings({ ...previous, outgoingTargetLanguage: 'en' });
  const page = await context.newPage();
  try {
    await page.goto('https://discord.com/channels/88/11');
    const editor = page.getByRole('textbox', { name: 'Message engineering' });
    const control = page.locator('flow-composer');
    await control.getByRole('button', { name: '翻译成英语', exact: true }).click();
    await expect(control.getByRole('textbox', { name: '发送前译文' })).toHaveValue(
      'Hello, see you on Friday.',
    );
    await expect(editor).toHaveText('你好，周五见。');
    expect(
      await page.evaluate(() => (window as unknown as { sentDrafts: string[] }).sentDrafts),
    ).toEqual([]);
    await page.screenshot({ path: 'test-results/screenshots/composer-translation-preview.png' });
    await control.getByRole('button', { name: '替换草稿', exact: true }).click();
    await expect(editor).toHaveText('Hello, see you on Friday.');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { slateDraft(): string }).slateDraft()))
      .toBe('Hello, see you on Friday.');
    await expect(control.getByRole('dialog')).toHaveCount(0);
    await page.locator('#composer-rerender').click();
    await expect(editor).toHaveText('Hello, see you on Friday.');
    await editor.press('Meta+z');
    await expect(editor).toHaveText('你好，周五见。');
    await editor.press('Meta+Shift+z');
    await expect(editor).toHaveText('Hello, see you on Friday.');
    await control.evaluate((element) => element.remove());
    await expect(page.locator('flow-composer')).toHaveCount(1);
    await page.locator('#native-emoji').click();
    expect(
      await page.evaluate(() => (window as unknown as { emojiClicks: number }).emojiClicks),
    ).toBe(1);
    expect(
      await page.evaluate(() => (window as unknown as { sentDrafts: string[] }).sentDrafts),
    ).toEqual([]);
    await page.screenshot({ path: 'test-results/screenshots/composer-translation-applied.png' });
    await page
      .locator('.channelTextArea_fixture')
      .screenshot({ path: 'test-results/screenshots/composer-action.png' });
  } finally {
    await page.close();
    await saveSettings(previous);
  }
});

test('invalidates composer previews after editing, changing language or switching channels during a request', async () => {
  const previous = await settings();
  await saveSettings({ ...previous, outgoingTargetLanguage: 'en' });
  const page = await context.newPage();
  try {
    await page.goto('https://discord.com/channels/88/12');
    const editor = page.getByRole('textbox', { name: 'Message engineering' });
    const control = page.locator('flow-composer');
    await control.getByRole('button', { name: '翻译成英语', exact: true }).click();
    await expect(control.getByRole('textbox', { name: '发送前译文' })).toHaveValue(
      'Hello, see you on Friday.',
    );
    await editor.fill('我修改了草稿。');
    await expect(control.getByRole('status')).toContainText('草稿已变化');
    await expect(control.getByRole('button', { name: '替换草稿', exact: true })).toBeDisabled();
    await expect(editor).toHaveText('我修改了草稿。');
    await control
      .getByRole('button', { name: '翻译成英语', exact: true })
      .click({ button: 'right' });
    await control.getByRole('menuitemradio', { name: '日语', exact: true }).click();
    await expect(control.getByRole('dialog')).toHaveCount(0);
    await editor.fill('你好，周五见。这是一段 slow original 频道切换草稿。');
    const before = requests.length;
    await control.getByRole('button', { name: '翻译成日语', exact: true }).click();
    await expect
      .poll(() => requests.slice(before).some((request) => request.text.includes('频道切换草稿')))
      .toBe(true);
    await page.evaluate(() => history.pushState({}, '', '/channels/88/13'));
    await expect(control.getByRole('dialog')).toHaveCount(0);
    await expect(control).toHaveCount(1);
    await page.waitForTimeout(1100);
    await expect(control.getByRole('dialog')).toHaveCount(0);
    await expect(editor).toHaveText('你好，周五见。这是一段 slow original 频道切换草稿。');
    await control.getByRole('button', { name: '翻译成日语', exact: true }).click();
    await expect(control.getByRole('textbox', { name: '发送前译文' })).toHaveValue(
      'こんにちは、金曜日に会いましょう。',
    );
    await control.getByRole('button', { name: '替换草稿', exact: true }).click();
    await expect(editor).toHaveText('こんにちは、金曜日に会いましょう。');
    expect(
      await page.evaluate(() => (window as unknown as { sentDrafts: string[] }).sentDrafts),
    ).toEqual([]);
  } finally {
    await page.close();
    await saveSettings(previous);
  }
});

test('handles empty and structured composer drafts and chooses the correct editor with a thread open', async () => {
  const previous = await settings();
  await saveSettings({ ...previous, outgoingTargetLanguage: 'en' });
  const page = await context.newPage();
  try {
    await page.goto('https://discord.com/channels/88/14?empty=1');
    const editor = page.getByRole('textbox', { name: 'Message engineering' });
    const control = page.locator('flow-composer');
    const before = requests.length;
    await control.getByRole('button', { name: '翻译成英语', exact: true }).click();
    await expect(control.getByRole('status')).toContainText('输入框为空');
    expect(requests.length).toBe(before);
    await control.getByRole('button', { name: '关闭', exact: true }).click();
    await editor.fill('你好，周五见。');
    await page.evaluate(() => {
      const mention = document.createElement('span');
      mention.contentEditable = 'false';
      mention.textContent = '@Ada';
      document.querySelector('[data-slate-editor="true"]')!.append(mention);
    });
    await control.getByRole('button', { name: '翻译成英语', exact: true }).click();
    await expect(control.getByRole('textbox', { name: '发送前译文' })).toHaveValue(
      'Hello, see you on Friday.',
    );
    await expect(control.getByRole('button', { name: '替换草稿', exact: true })).toBeDisabled();
    await expect(control.getByRole('status')).toContainText('特殊内容');
    await control.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => {
      const form = document.createElement('form');
      form.id = 'thread-compose';
      form.style.cssText =
        'position:fixed;right:24px;bottom:24px;width:360px;padding:12px;background:#313338';
      form.innerHTML =
        '<div contenteditable="true" role="textbox" aria-multiline="true" aria-label="Thread message">你好，周五见。线程草稿。</div><div data-composer-actions><button type="button">☺</button></div>';
      document.body.append(form);
    });
    await expect(page.locator('flow-composer')).toHaveCount(2);
    const threadControl = page.locator('#thread-compose flow-composer');
    await threadControl.getByRole('button', { name: '翻译成英语', exact: true }).click();
    await expect(threadControl.getByRole('textbox', { name: '发送前译文' })).toHaveValue(
      'Hello, see you on Friday.',
    );
    await threadControl.getByRole('button', { name: '替换草稿', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Thread message' })).toHaveText(
      'Hello, see you on Friday.',
    );
    await expect(editor).toContainText('@Ada');
  } finally {
    await page.close();
    await saveSettings(previous);
  }
});

test('rejects composer requests from other origins and mismatched channels without exposing credentials', async () => {
  const previous = await settings();
  const page = await context.newPage();
  await page.goto('https://example.org/composer-security');
  await grantActiveTab(page);
  const replies = await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: async () =>
        Promise.all([
          chrome.runtime.sendMessage({
            type: 'TRANSLATE',
            input: {
              source: 'draft',
              text: 'private draft',
              channel: '/channels/88/1',
              targetLanguage: 'en',
            },
          }),
          chrome.runtime.sendMessage({
            type: 'SET_OUTGOING_LANGUAGE',
            language: 'ja',
            channel: '/channels/88/1',
          }),
        ]),
    });
    if (!result?.result) throw new Error('Composer authorization test did not return a result');
    return result.result;
  }, page.url());
  expect(replies.map((reply: { ok: boolean }) => reply.ok)).toEqual([false, false]);
  await page.goto('https://discord.com/channels/88/15');
  const invalid = await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: async () =>
        Promise.all([
          chrome.runtime.sendMessage({
            type: 'SET_OUTGOING_LANGUAGE',
            language: 'invalid',
            channel: '/channels/88/15',
          }),
          chrome.runtime.sendMessage({
            type: 'SET_OUTGOING_LANGUAGE',
            language: 'ja',
            channel: '/channels/88/16',
          }),
          chrome.runtime.sendMessage({
            type: 'TRANSLATE',
            input: {
              source: 'draft',
              text: 'private draft',
              channel: '/channels/88/16',
              targetLanguage: 'en',
            },
          }),
          chrome.runtime.sendMessage({
            type: 'TRANSLATE',
            input: {
              source: 'draft',
              text: 'private draft',
              channel: '/channels/88/15',
              targetLanguage: 'en',
              automatic: true,
            },
          }),
          chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
        ]),
    });
    if (!result?.result) throw new Error('Composer authorization test did not return a result');
    return result.result;
  }, page.url());
  expect(invalid.map((reply: { ok: boolean }) => reply.ok)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
  expect((await settings()).outgoingTargetLanguage).toBe(previous.outgoingTargetLanguage);
  await page.close();
});

test('previews English and Japanese outgoing translations and updates real Slate state without sending', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/88/1');
  const editor = page.getByRole('textbox', { name: 'Message engineering' });
  await expect(editor).toHaveText('你好，周五见。');
  const popup = await openPopup(page);
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.locator('#draft-panel summary').click();
  await popup.locator('#outgoing-language').selectOption('en');
  await popup.locator('#translate-draft').click();
  await expect(popup.locator('#draft-output')).toHaveValue('Hello, see you on Friday.');
  await popupActionPoint(popup, 'translate');
  await popupActionPoint(popup, 'restore');
  await expect(editor).toHaveText('你好，周五见。');
  expect(
    await page.evaluate(() => (window as unknown as { sentDrafts: string[] }).sentDrafts),
  ).toEqual([]);
  await popup.locator('#apply-draft').click();
  await expect(popup.locator('#draft-status')).toContainText('已替换');
  await expect(editor).toHaveText('Hello, see you on Friday.');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { slateDraft(): string }).slateDraft()))
    .toBe('Hello, see you on Friday.');
  await page.locator('#composer-rerender').click();
  await expect(editor).toHaveText('Hello, see you on Friday.');
  await editor.press('ControlOrMeta+z');
  await expect(editor).toHaveText('你好，周五见。');
  await editor.press('ControlOrMeta+Shift+z');
  await expect(editor).toHaveText('Hello, see you on Friday.');
  expect(
    await page.evaluate(() => (window as unknown as { sentDrafts: string[] }).sentDrafts),
  ).toEqual([]);
  await editor.press('Enter');
  expect(
    await page.evaluate(() => (window as unknown as { sentDrafts: string[] }).sentDrafts),
  ).toEqual(['Hello, see you on Friday.']);
  await editor.fill('你好，周五见。');
  await popup.locator('#outgoing-language').selectOption('ja');
  await popup.locator('#translate-draft').click();
  await expect(popup.locator('#draft-output')).toHaveValue('こんにちは、金曜日に会いましょう。');
  await popup.locator('#apply-draft').click();
  await expect(editor).toHaveText('こんにちは、金曜日に会いましょう。');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { slateDraft(): string }).slateDraft()))
    .toBe('こんにちは、金曜日に会いましょう。');
  await editor.fill('你好。\n这是一段多行草稿，周五见。');
  await popup.locator('#translate-draft').click();
  await expect(popup.locator('#draft-output')).toHaveValue('こんにちは。\n金曜日に会いましょう。');
  await popup.locator('#apply-draft').click();
  await expect(popup.locator('#draft-status')).toContainText('已替换');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { slateDraft(): string }).slateDraft()))
    .toBe('こんにちは。\n金曜日に会いましょう。');
  expect((await settings()).targetLanguage).toBe('zh-CN');
  expect(
    await popup.locator('body').evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(600);
  await popup.screenshot({
    path: 'test-results/screenshots/outgoing-translation.png',
    fullPage: true,
  });
  await popup.close();
  const reopened = await openPopup(page);
  await reopened.locator('#draft-panel summary').click();
  await expect(reopened.locator('#outgoing-language')).toHaveValue('ja');
  await reopened.close();
  await page.close();
});

test('rejects stale draft replacements after typing or changing channels', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/88/2');
  const editor = page.getByRole('textbox', { name: 'Message engineering' });
  await expect(editor).toHaveText('你好，周五见。');
  const popup = await openPopup(page);
  await popup.locator('#draft-panel summary').click();
  await popup.locator('#translate-draft').click();
  await expect(popup.locator('#draft-output')).not.toHaveValue('');
  await editor.fill('我又修改了草稿。');
  await popup.locator('#apply-draft').click();
  await expect(popup.locator('#draft-status')).toContainText('草稿已变化');
  await expect(editor).toHaveText('我又修改了草稿。');
  const before = requests.length;
  await editor.fill('这是一段 slow original 发送草稿。');
  await popup.locator('#translate-draft').click();
  await expect
    .poll(() => requests.slice(before).some((request) => request.text.includes('发送草稿')))
    .toBe(true);
  await page.evaluate(() => {
    history.pushState({}, '', '/channels/88/3');
  });
  await expect(popup.locator('#draft-status')).toContainText('频道');
  await expect(popup.locator('#draft-preview')).toBeHidden();
  await expect(editor).toHaveText('这是一段 slow original 发送草稿。');
  await popup.close();
  await page.close();
});

test('handles empty and structured drafts and denies unscoped draft translation requests', async () => {
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/88/4?empty=1');
  const editor = page.getByRole('textbox', { name: 'Message engineering' });
  await expect(editor).toHaveText('');
  const popup = await openPopup(page);
  await popup.locator('#draft-panel summary').click();
  const before = requests.length;
  await popup.locator('#translate-draft').click();
  await expect(popup.locator('#draft-status')).toContainText('输入框为空');
  expect(requests.length).toBe(before);
  await editor.fill('你好，周五见。');
  await expect(editor).toHaveText('你好，周五见。');
  await page.evaluate(() => {
    const mention = document.createElement('span');
    mention.contentEditable = 'false';
    mention.textContent = '@Ada';
    document.querySelector('[data-slate-editor="true"]')!.append(mention);
  });
  await popup.locator('#translate-draft').click();
  await expect(popup.locator('#draft-output')).not.toHaveValue('');
  await expect(popup.locator('#apply-draft')).toBeDisabled();
  await expect(popup.locator('#draft-status')).toContainText('特殊内容');
  const denied = await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)!;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: async () => {
        return chrome.runtime.sendMessage({
          type: 'TRANSLATE',
          input: { source: 'draft', text: 'private draft', targetLanguage: 'en' },
        });
      },
    });
    return result?.result;
  }, page.url());
  expect(denied.ok).toBe(false);
  expect(denied.error).toContain('仅限扩展');
  await popup.close();
  await page.close();
});

test('connects the built extension to the real local authenticated Ollama gateway', async () => {
  test.skip(
    process.env.FLOW_TEST_LOCAL !== '1',
    'Opt in to real local inference with FLOW_TEST_LOCAL=1.',
  );
  const key = (
    await readFile(
      process.env.FLOW_LOCAL_KEY_FILE ?? join(homedir(), '.config/local-translation/api-key.txt'),
      'utf8',
    )
  ).trim();
  const previous = await settings();
  try {
    await saveSettings({
      ...previous,
      providers: previous.providers.map((provider) =>
        provider.id === 'local-ollama'
          ? {
              ...provider,
              baseUrl: process.env.FLOW_LOCAL_BASE_URL ?? 'http://127.0.0.1:11434/v1',
              model: process.env.FLOW_LOCAL_MODEL ?? 'hy-mt2-7b:q6_k',
              apiKey: key,
            }
          : provider,
      ),
    });
    const result = await options.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({
        type: 'TEST_PROVIDER',
        providerId: 'local-ollama',
      });
      if (!reply.ok) throw new Error(reply.error);
      return reply.data.text as string;
    });
    expect(result).toMatch(/[\u4e00-\u9fff]/);
    console.log('Local Ollama translation verified:', result);
    const models = await options.evaluate(async () => {
      const saved = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const provider = (saved.data as Settings).providers.find(
        (provider) => provider.id === 'local-ollama',
      )!;
      const reply = await chrome.runtime.sendMessage({ type: 'LIST_PROVIDER_MODELS', provider });
      if (!reply.ok) throw new Error(reply.error);
      return reply.data as string[];
    });
    expect(models).toContain(process.env.FLOW_LOCAL_MODEL ?? 'hy-mt2-7b:q6_k');
    console.log('Authenticated local model list verified:', models.length);
    const page = await context.newPage();
    await page.goto('https://discord.com/channels/1/100');
    await expect(page.locator('flow-translation')).toHaveCount(2);
    const source =
      'The release will be available on Friday. Before deployment, please review the changes and run the integration tests. Keep the original documentation available so that engineers can compare the instructions. If the translation is unclear, choose another provider and translate the message again. Automatic translation should only process visible messages in the current channel.';
    await page.evaluate((text) => {
      document.querySelector('#message-content-101')!.textContent = text;
    }, source);
    const entry = page.locator('flow-translation').first();
    await expect(entry.locator('.meta')).toContainText('消息已更新');
    await page.evaluate(() => {
      const output = document
        .querySelector('flow-translation')!
        .shadowRoot!.querySelector('.output')!;
      const timing = { start: performance.now(), first: 0 };
      (window as typeof window & { flowTestTiming?: typeof timing }).flowTestTiming = timing;
      const observer = new MutationObserver(() => {
        if (!timing.first && output.textContent) {
          timing.first = performance.now() - timing.start;
          observer.disconnect();
        }
      });
      observer.observe(output, { childList: true, subtree: true, characterData: true });
    });
    await entry.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(entry.locator('.meta')).toHaveText(/^识别为：.+/);
    await expect(entry.getByRole('button', { name: '重新翻译', exact: true })).toBeEnabled();
    const timing = await page.evaluate(() => {
      const timing = (
        window as typeof window & { flowTestTiming?: { start: number; first: number } }
      ).flowTestTiming!;
      return {
        firstVisibleMs: Math.round(timing.first),
        completeMs: Math.round(performance.now() - timing.start),
      };
    });
    expect(timing.firstVisibleMs).toBeGreaterThan(0);
    expect(timing.firstVisibleMs).toBeLessThan(timing.completeMs);
    console.log('Real extension streaming timing:', timing);
    await writeFile('test-results/local-performance.json', JSON.stringify(timing, null, 2));
    for (const text of [
      'こんにちは、次のリリースは金曜日です。',
      '안녕하세요. 다음 출시는 금요일입니다.',
      'Привет! Следующий выпуск выйдет в пятницу.',
    ]) {
      const translated = await options.evaluate(async (text) => {
        const reply = await chrome.runtime.sendMessage({
          type: 'TRANSLATE',
          input: { text, providerId: 'local-ollama', source: 'test' },
        });
        if (!reply.ok) throw new Error(reply.error);
        return reply.data.text as string;
      }, text);
      expect(translated).toMatch(/周五|星期五|礼拜五/);
      console.log('Local multilingual translation verified:', translated);
    }
    await page.close();
    const composerPage = await context.newPage();
    await composerPage.goto('https://discord.com/channels/88/100');
    const editor = composerPage.getByRole('textbox', { name: 'Message engineering' });
    await expect(editor).toHaveText('你好，周五见。');
    const popup = await openPopup(composerPage);
    await popup.locator('#draft-panel summary').click();
    for (const target of ['en', 'ja']) {
      await editor.fill('你好，周五见。');
      await popup.locator('#outgoing-language').selectOption(target);
      await popup.locator('#translate-draft').click();
      const output = popup.locator('#draft-output');
      await expect(output).not.toHaveValue('');
      const translated = await output.inputValue();
      if (target === 'en') expect(translated).toMatch(/Friday/i);
      else expect(translated).toMatch(/金曜/);
      await popup.locator('#apply-draft').click();
      await expect(popup.locator('#draft-status')).toContainText('已替换');
      await expect
        .poll(() =>
          composerPage.evaluate(() => (window as unknown as { slateDraft(): string }).slateDraft()),
        )
        .toBe(translated);
      expect(
        await composerPage.evaluate(
          () => (window as unknown as { sentDrafts: string[] }).sentDrafts,
        ),
      ).toEqual([]);
      console.log(`Local outgoing ${target} translation verified:`, translated);
    }
    expect((await settings()).targetLanguage).toBe('zh-CN');
    await popup.close();
    await composerPage.close();
  } finally {
    await saveSettings(previous);
  }
});

test('removes obsolete Discord controls and retains domain automation after extension reload', async () => {
  const web = await context.newPage();
  await web.goto('https://example.org/remember-before-reload');
  await grantActiveTab(web);
  await preapproveDomain('example.org');
  const popup = await openPopup(web);
  await popup.locator('#page-auto').check();
  await expect(web.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  await popup.close();
  const page = await context.newPage();
  await page.goto('https://discord.com/channels/94/500');
  await expect(page.locator('flow-translation')).toHaveCount(2);
  await expect(page.locator('flow-toolbar')).toHaveCount(0);
  const worker = context.serviceWorkers().find((worker) => worker.url().includes(extensionId))!;
  const closed = worker.waitForEvent('close');
  await worker.evaluate(() => {
    setTimeout(() => chrome.runtime.reload(), 0);
  });
  await closed;
  await expect(page.locator('flow-translation,flow-toolbar,flow-composer')).toHaveCount(0);
  await page.evaluate(() => {
    document.querySelector('#message-content-101')!.textContent = 'This is an edited message.';
    history.pushState({}, '', '/channels/94/501');
  });
  await page.waitForTimeout(800);
  await expect(page.locator('flow-translation,flow-toolbar,flow-composer')).toHaveCount(0);
  await page.close();
  const next = await context.newPage();
  await next.goto('https://example.org/remember-after-reload');
  await expect(next.locator('#paragraph-one')).toHaveText('下一个版本将于周五发布。');
  await next.close();
  await web.close();
});
