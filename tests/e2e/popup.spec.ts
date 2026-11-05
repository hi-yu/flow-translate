import { test, expect, chromium, type BrowserContext, type CDPSession } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let context: BrowserContext;
let server: Server;
let profile: string;
let extensionId: string;
let commandId = 0;

// Action popups are outside Playwright's tab targets. Attach directly without setting a viewport.
async function openNativePopup(pageUrl: string) {
  const cdp = await context.browser()!.newBrowserCDPSession();
  const tabs = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = tabs.targetInfos.find((target) => target.url === pageUrl);
  if (!tab) throw new Error('Native popup test tab unavailable');
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
  let targetId: string | undefined;
  await expect
    .poll(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      targetId = targetInfos.find(
        (target) => target.url === `chrome-extension://${extensionId}/popup.html`,
      )?.targetId;
      return targetId;
    })
    .toBeTruthy();
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: targetId!,
    flatten: false,
  });
  const command = <T>(method: string, params = {}) =>
    popupCommand<T>(cdp, sessionId, method, params);
  return {
    async evaluate<T>(fn: () => T): Promise<Awaited<T>> {
      const response = await command<{
        result: { value: Awaited<T> };
        exceptionDetails?: { text: string };
      }>('Runtime.evaluate', {
        expression: `(${fn.toString()})()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    },
    async click(selector: string) {
      const { result } = await command<{ result: { value: { x: number; y: number } } }>(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            if (rect.top < 0 || rect.bottom > innerHeight || !element.contains(document.elementFromPoint(x, y)))
              throw new Error('Popup control is clipped or covered');
            return { x, y };
          })()`,
          returnByValue: true,
        },
      );
      if (!result.value) throw new Error(`Popup control unavailable: ${selector}`);
      await command('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        ...result.value,
      });
      await command('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        ...result.value,
      });
    },
    async screenshot(name: string) {
      const { data } = await command<{ data: string }>('Page.captureScreenshot');
      await writeFile(`test-results/screenshots/${name}.png`, Buffer.from(data, 'base64'));
    },
    async darkMode() {
      await command('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId: targetId! });
      await cdp.detach();
    },
  };
}

function popupCommand<T>(
  cdp: CDPSession,
  sessionId: string,
  method: string,
  params: object,
): Promise<T> {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      cdp.off('Target.receivedMessageFromTarget', receive);
    };
    const receive = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return;
      const reply = JSON.parse(event.message);
      if (reply.id !== id) return;
      cleanup();
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result as T);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Native popup command timed out: ${method}`));
    }, 10_000);
    cdp.on('Target.receivedMessageFromTarget', receive);
    cdp
      .send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      })
      .catch((error: unknown) => {
        cleanup();
        reject(error);
      });
  });
}

async function popupLayout(popup: Awaited<ReturnType<typeof openNativePopup>>) {
  return popup.evaluate(() => {
    const exposed = (selector: string) => {
      const element = document.querySelector(selector)!;
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        Boolean(hit && element.contains(hit))
      );
    };
    const main = document.querySelector('main')!;
    return {
      width: innerWidth,
      height: innerHeight,
      mainHeight: main.clientHeight,
      mainScrollHeight: main.scrollHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      controls: ['#site-name', '#provider', '#language', '#translate', '#restore', '#test'].map(
        exposed,
      ),
      domainVisible: exposed('#page-auto'),
      channelVisible: exposed('#discord-auto'),
      actions: ['#translate', '#restore'].map(
        (selector) => document.querySelector(selector)!.getBoundingClientRect().top,
      ),
      status: document.querySelector('#status')!.textContent,
    };
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer native-popup-test-key') {
      res.writeHead(401).end();
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: '这是翻译后的内容。' }, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Popup mock API unavailable');
  profile = await mkdtemp(join(tmpdir(), 'flow-native-popup-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    viewport: null,
    args: [
      '--enable-unsafe-extension-debugging',
      '--window-size=1200,900',
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.evaluate(async (port) => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.providers[0].baseUrl = `http://127.0.0.1:${port}/v1`;
    settings.providers[0].apiKey = 'native-popup-test-key';
    const reply = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!reply.ok) throw new Error(reply.error);
  }, address.port);
  await options.close();
  await context.route('https://example.org/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><h1 id="text">Our next release ships on Friday.</h1></html>',
    }),
  );
  await context.route('https://discord.com/**', async (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: await readFile('tests/fixtures/discord.html', 'utf8'),
    }),
  );
  await mkdir('test-results/screenshots', { recursive: true });
});

test.afterAll(async () => {
  await context?.close();
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('sizes the real action popup intrinsically and restores a translated page after reopening', async () => {
  const page = context.pages()[0]!;
  await page.goto('https://example.org/native-popup');
  await page.bringToFront();
  let popup = await openNativePopup(page.url());
  await expect.poll(async () => (await popupLayout(popup)).controls).toEqual(Array(6).fill(true));
  const initial = await popupLayout(popup);
  expect(initial.width).toBe(380);
  expect(initial.height).toBeGreaterThan(450);
  expect(initial.height).toBeLessThanOrEqual(600);
  expect(initial.mainHeight).toBeGreaterThan(240);
  expect(initial.mainScrollHeight).toBeLessThanOrEqual(initial.mainHeight);
  expect(initial.domainVisible).toBe(true);
  expect(initial.horizontalOverflow).toBe(false);
  await test.info().attach('native-default-layout', {
    body: JSON.stringify(initial),
    contentType: 'application/json',
  });
  await popup.screenshot('popup-native-default');
  await popup.click('#translate');
  await expect(page.locator('#text')).toHaveText('这是翻译后的内容。');
  await popup.close();
  popup = await openNativePopup(page.url());
  await expect.poll(async () => (await popupLayout(popup)).status).toContain('已翻译');
  expect((await popupLayout(popup)).controls).toEqual(Array(6).fill(true));
  await popup.screenshot('popup-native-translated');
  await popup.click('#restore');
  await expect(page.locator('#text')).toHaveText('Our next release ships on Friday.');
  await popup.close();
});

test('keeps native Discord actions visible while expanded draft content scrolls, in both themes', async () => {
  const page = context.pages()[0]!;
  await page.goto('https://discord.com/channels/1/1');
  await page.getByRole('textbox', { name: 'Message engineering' }).fill('你好，周五见。');
  await page.bringToFront();
  const popup = await openNativePopup(page.url());
  await expect.poll(async () => (await popupLayout(popup)).channelVisible).toBe(true);
  expect((await popupLayout(popup)).controls).toEqual(Array(6).fill(true));
  await popup.screenshot('popup-native-discord');
  await popup.click('#discord-auto');
  await expect
    .poll(() =>
      popup.evaluate(() => (document.querySelector('#discord-auto') as HTMLInputElement).checked),
    )
    .toBe(true);
  await popup.click('#draft-panel summary');
  await popup.evaluate(() =>
    document.querySelector('#translate-draft')!.scrollIntoView({ block: 'center' }),
  );
  await popup.click('#translate-draft');
  await expect
    .poll(() =>
      popup.evaluate(() => (document.querySelector('#draft-output') as HTMLTextAreaElement).value),
    )
    .toBe('这是翻译后的内容。');
  const expanded = await popupLayout(popup);
  expect(expanded.height).toBe(600);
  expect(expanded.mainHeight).toBeGreaterThan(300);
  expect(expanded.mainScrollHeight).toBeGreaterThan(expanded.mainHeight);
  expect(expanded.controls.slice(3)).toEqual([true, true, true]);
  await test.info().attach('native-expanded-layout', {
    body: JSON.stringify(expanded),
    contentType: 'application/json',
  });
  await popup.evaluate(() => {
    const main = document.querySelector('main')!;
    main.scrollTop = main.scrollHeight;
  });
  expect((await popupLayout(popup)).actions).toEqual(expanded.actions);
  await popup.screenshot('popup-native-discord-draft');
  await popup.evaluate(() => {
    document.querySelector('main')!.scrollTop = 0;
  });
  await popup.screenshot('popup-native-discord-expanded');
  await popup.darkMode();
  await popup.evaluate(async () => {
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
  });
  await popup.screenshot('popup-native-discord-dark');
  expect((await popupLayout(popup)).controls.slice(3)).toEqual([true, true, true]);
  await popup.close();
});
