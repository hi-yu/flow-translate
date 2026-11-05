import { describe, expect, it, vi } from 'vitest';
import { buildRequest, extractTranslation, translateWithProvider } from '../../src/providers';
import {
  DEFAULT_SETTINGS,
  publicSettings,
  validateProvider,
  validateSettings,
} from '../../src/settings';
import type { Provider } from '../../src/types';

const provider: Provider = { ...DEFAULT_SETTINGS.providers[0]!, apiKey: 'test-key' };

describe('provider boundaries', () => {
  it('uses the authenticated local gateway and never puts keys into URLs', () => {
    const { url, init } = buildRequest(provider, 'Hello', 'zh-CN');
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.body).not.toContain('test-key');
    expect(JSON.parse(init.body as string).stream).toBe(true);
  });
  it('supports DeepL native authorization and language codes', () => {
    const { url, init } = buildRequest(
      { ...provider, kind: 'deepl', baseUrl: 'https://api-free.deepl.com/v2' },
      'Hello',
      'zh-CN',
    );
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(init.headers).toMatchObject({ Authorization: 'DeepL-Auth-Key test-key' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      text: ['Hello'],
      target_lang: 'ZH-HANS',
    });
  });
  it('supports Gemini with a header key and excludes thought parts', () => {
    const gemini = {
      ...provider,
      kind: 'gemini' as const,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'test-model',
    };
    const { url, init } = buildRequest(gemini, 'Hello', 'zh-CN');
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent',
    );
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
    expect(
      extractTranslation(gemini, {
        candidates: [
          { content: { parts: [{ text: 'secret reasoning', thought: true }, { text: '你好' }] } },
        ],
      }),
    ).toBe('你好');
  });
  it.each([
    'http://example.com/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=secret',
    'file:///tmp/model',
    'https://example.com/v1#key',
  ])('rejects unsafe endpoint %s', (baseUrl) => {
    expect(() => validateProvider({ ...provider, baseUrl })).toThrow();
  });
  it('redacts credentials before settings reach a content script', () => {
    const result = publicSettings({ ...DEFAULT_SETTINGS, providers: [provider] });
    expect(JSON.stringify(result)).not.toContain('test-key');
    expect(result.providers[0]).not.toHaveProperty('apiKey');
  });
  it('rejects invalid automatic channels and duplicate IDs', () => {
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, discordAutoChannels: ['/channels/@me'] }),
    ).toThrow();
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, providers: [provider, provider] }),
    ).toThrow();
  });
  it('fails clearly on wrong credentials without echoing response secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('test-key private server detail', { status: 401 })),
    );
    await expect(translateWithProvider(provider, 'Hello', 'zh-CN')).rejects.toThrow('HTTP 401');
  });
  it('decodes streamed UTF-8 split across byte boundaries', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        ),
    );
    await expect(translateWithProvider(provider, 'Hello', 'zh-CN')).resolves.toBe('你好');
  });
  it('does not treat truncated streams as completed translations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('data: {"choices":[{"delta":{"content":"一半"}}]}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    await expect(translateWithProvider(provider, 'Hello', 'zh-CN')).rejects.toThrow('未完整返回');
    expect(() =>
      extractTranslation(provider, {
        choices: [{ message: { content: '一半' }, finish_reason: 'length' }],
      }),
    ).toThrow('截断');
  });
  it('parses non-streaming compatibility responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '你好' } }] })),
    );
    await expect(translateWithProvider(provider, 'Hello', 'zh-CN')).resolves.toBe('你好');
  });
  it('publishes streamed text before the response completes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encode = (text: string) => new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        ),
    );
    const progress = vi.fn();
    let done = false;
    const pending = translateWithProvider(provider, 'Hello', 'zh-CN', undefined, progress).then(
      (value) => {
        done = true;
        return value;
      },
    );
    controller.enqueue(encode('data: {"choices":[{"delta":{"content":"第一部分"}}]}\n\n'));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('第一部分'));
    expect(done).toBe(false);
    controller.enqueue(
      encode(
        'data: {"choices":[{"delta":{"content":"和后半段"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
    controller.close();
    expect(await pending).toBe('第一部分和后半段');
  });
});
