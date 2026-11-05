import { discordChannel, isDiscordHost } from './settings';

/** sender.url retains the document's initial URL after Discord's history.pushState navigation. */
export async function discordSenderChannel(
  sender: chrome.runtime.MessageSender,
): Promise<string | null> {
  if (sender.tab?.id == null || sender.frameId !== 0) return null;
  const documentUrl = new URL(sender.url ?? 'about:blank');
  if (documentUrl.protocol !== 'https:' || !isDiscordHost(documentUrl.hostname)) return null;
  const tab = await chrome.tabs.get(sender.tab.id);
  const currentUrl = new URL(tab.url ?? 'about:blank');
  if (currentUrl.origin !== documentUrl.origin) return null;
  return discordChannel(currentUrl.pathname);
}
