import { pageDomainPattern } from './settings';

const SCRIPT_ID = 'flow-page-auto';

export async function authorizedPageDomains(domains: string[]): Promise<string[]> {
  const allowed = await Promise.all(
    domains.map((domain) => chrome.permissions.contains({ origins: [pageDomainPattern(domain)] })),
  );
  return domains.filter((_, index) => allowed[index]);
}

export async function registerPageDomains(domains: string[]): Promise<void> {
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  const matches = domains.map(pageDomainPattern).sort();
  if (!matches.length) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  if (existing && JSON.stringify([...existing.matches!].sort()) === JSON.stringify(matches)) return;
  const script: chrome.scripting.RegisteredContentScript = {
    id: SCRIPT_ID,
    matches,
    js: ['content.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
    world: 'ISOLATED',
  };
  if (existing) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}
