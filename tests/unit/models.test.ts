import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProviderModels } from '../../src/providers';
import { DEFAULT_SETTINGS, validateProvider } from '../../src/settings';
import type { Provider } from '../../src/types';

const provider: Provider = {
  ...DEFAULT_SETTINGS.providers[0]!,
  apiKey: 'model-list-test-key',
  model: '',
};
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('provider model lists', () => {
  it('lists OpenAI compatible models without requiring a model or exposing credentials in the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        data: [
          { id: 'z-model' },
          { id: 'a-model' },
          { id: 'a-model' },
          null,
          1,
          { id: 23 },
          { id: '' },
          { id: 'bad\nmodel' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(() => validateProvider(provider)).toThrow('模型名称');
    await expect(
      listProviderModels({ ...provider, baseUrl: provider.baseUrl + '/chat/completions' }),
    ).resolves.toEqual(['a-model', 'z-model']);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer model-list-test-key' },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      }),
    );
    expect(fetch.mock.calls[0]![0]).not.toContain(provider.apiKey);
  });

  it('lists Gemini generation models across pages with a header key and encoded page tokens', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          models: [
            { name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'next?&page=2',
        }),
      )
      .mockResolvedValueOnce(
        json({
          models: [{ name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] }],
        }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(
      listProviderModels({
        ...provider,
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      }),
    ).resolves.toEqual(['gemini-flash', 'gemini-pro']);
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    );
    expect(fetch.mock.calls[0]![1].headers).toEqual({ 'x-goog-api-key': provider.apiKey });
    const secondUrl = new URL(fetch.mock.calls[1]![0]);
    expect(secondUrl.searchParams.get('pageToken')).toBe('next?&page=2');
    expect([...secondUrl.searchParams.keys()]).toEqual(['pageSize', 'pageToken']);
  });

  it('returns an empty list when the service has no models', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: [] })));
    await expect(listProviderModels(provider)).resolves.toEqual([]);
  });

  it('rejects missing credentials and DeepL before making a network request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(listProviderModels({ ...provider, apiKey: '' })).rejects.toThrow('API Key');
    await expect(listProviderModels({ ...provider, kind: 'deepl' })).rejects.toThrow(
      '无需选择模型',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 404])('explains HTTP %s without echoing the server response', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('private server detail ' + provider.apiKey, { status })),
    );
    await expect(listProviderModels(provider)).rejects.toThrow(`HTTP ${status}`);
  });

  it('rejects malformed and oversized model lists', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ models: [] }))
        .mockResolvedValueOnce(json({ data: [], padding: 'x'.repeat(1_000_001) })),
    );
    await expect(listProviderModels(provider)).rejects.toThrow('有效的模型列表');
    await expect(listProviderModels(provider)).rejects.toThrow('响应过大');
  });

  it('stops repeated Gemini page tokens instead of making an unbounded request loop', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => json({ models: [], nextPageToken: 'repeated' }));
    vi.stubGlobal('fetch', fetch);
    await expect(listProviderModels({ ...provider, kind: 'gemini' })).rejects.toThrow('分页异常');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports connection failures without reflecting transport details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('private detail ' + provider.apiKey)),
    );
    await expect(listProviderModels(provider)).rejects.toThrow('无法连接接口');
  });

  it('reports timeout when the model request is aborted', async () => {
    const signal = AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(signal.reason));
    await expect(listProviderModels(provider)).rejects.toThrow('拉取模型列表超时');
  });
});
