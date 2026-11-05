import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discordSenderChannel } from '../../src/discord-context';

const getTab = vi.fn();
const sender: chrome.runtime.MessageSender = {
  url: 'https://discord.com/channels/1/2',
  frameId: 0,
  tab: { id: 10 } as chrome.tabs.Tab,
};

beforeEach(() => {
  vi.stubGlobal('chrome', { tabs: { get: getTab } });
  getTab.mockResolvedValue({ id: 10, url: 'https://discord.com/channels/1/3' });
});
afterEach(() => vi.unstubAllGlobals());

describe('Discord sender authorization after SPA navigation', () => {
  it('uses the current tab channel even when sender.url contains the initial channel', async () => {
    expect(await discordSenderChannel(sender)).toBe('/channels/1/3');
    expect(getTab).toHaveBeenCalledWith(10);
  });

  it('supports direct messages and Discord alternate hosts', async () => {
    getTab.mockResolvedValue({ url: 'https://ptb.discord.com/channels/@me/30' });
    expect(
      await discordSenderChannel({ ...sender, url: 'https://ptb.discord.com/channels/1/2' }),
    ).toBe('/channels/@me/30');
  });

  it.each([
    { ...sender, tab: undefined },
    { ...sender, frameId: 1 },
    { ...sender, url: 'https://example.org/channels/1/3' },
    { ...sender, url: 'http://discord.com/channels/1/3' },
  ])('rejects senders outside the top-level HTTPS Discord document', async (value) => {
    expect(await discordSenderChannel(value)).toBeNull();
  });

  it.each([
    'https://example.org/channels/1/3',
    'https://canary.discord.com/channels/1/3',
    'https://discord.com/login',
    undefined,
  ])(
    'rejects a tab that no longer contains the same Discord origin and a channel: %s',
    async (url) => {
      getTab.mockResolvedValue({ url });
      expect(await discordSenderChannel(sender)).toBeNull();
    },
  );
});
