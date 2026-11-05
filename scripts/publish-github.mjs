import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, releaseInfo } from './release-info.mjs';
import { sha256 } from './package-crx.mjs';
import { pushGitHubRef } from './sync-github.mjs';

export function githubClient({ repo, token, fetch = globalThis.fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GitHub 仓库必须为 owner/repo。');
  if (!token || /[\r\n]/.test(token)) throw new Error('缺少有效的 FLOW_GITHUB_TOKEN。');
  const base = `https://api.github.com/repos/${repo}`;
  return async (path, { method = 'GET', body, binary = false, optional = false } = {}) => {
    const url = new URL(path.startsWith('https:') ? path : base + path);
    if (
      !['api.github.com', 'uploads.github.com'].includes(url.hostname) ||
      url.protocol !== 'https:'
    ) {
      throw new Error('拒绝向非 GitHub 地址发送发布凭据。');
    }
    const response = await fetch(url.href, {
      method,
      signal: AbortSignal.timeout(120_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'flow-translate-cnb-release',
        ...(body
          ? {
              'Content-Type': Buffer.isBuffer(body)
                ? 'application/octet-stream'
                : 'application/json',
            }
          : {}),
      },
      body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
    });
    if (optional && response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub ${method} ${url.pathname} 返回 HTTP ${response.status}。`);
    if (response.status === 204) return null;
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}

export async function publishRelease({ api, info, files, notes }) {
  let release = await api(`/releases/tags/${encodeURIComponent(info.tag)}`, { optional: true });
  if (!release) {
    for (let page = 1; ; page++) {
      const releases = await api(`/releases?per_page=100&page=${page}`);
      const drafts = releases.filter((item) => item.draft && item.tag_name === info.tag);
      if (drafts.length > 1) throw new Error(`${info.tag} 存在多个草稿，请先清理重复草稿。`);
      if (drafts.length) {
        release = drafts[0];
        break;
      }
      if (releases.length < 100) break;
    }
  }
  if (!release) {
    release = await api('/releases', {
      method: 'POST',
      body: {
        tag_name: info.tag,
        name: `译流 ${info.tag}`,
        body: notes,
        draft: true,
        prerelease: !!info.prerelease,
        target_commitish: info.commit,
      },
    });
  }
  const existing = await api(`/releases/${release.id}/assets?per_page=100`);
  const upload = new URL(release.upload_url.split('{')[0]);
  if (upload.hostname !== 'uploads.github.com') throw new Error('GitHub 上传地址无效。');
  for (const file of files) {
    let asset = existing.find((item) => item.name === file.name);
    if (asset && release.draft && asset.state === 'starter' && asset.size === 0) {
      await api(`/releases/assets/${asset.id}`, { method: 'DELETE' });
      asset = null;
    }
    if (asset) {
      const digest =
        asset.digest ||
        'sha256:' + sha256(await api(`/releases/assets/${asset.id}`, { binary: true }));
      if (digest !== 'sha256:' + sha256(file.bytes)) {
        throw new Error(`${file.name} 已存在但校验值不同；请递增版本，不覆盖已有安装包。`);
      }
      continue;
    }
    upload.searchParams.set('name', file.name);
    const saved = await api(upload.href, { method: 'POST', body: file.bytes });
    const digest =
      saved.digest ||
      'sha256:' + sha256(await api(`/releases/assets/${saved.id}`, { binary: true }));
    if (digest !== 'sha256:' + sha256(file.bytes)) throw new Error(`${file.name} 上传后校验失败。`);
  }
  if (release.draft) {
    release = await api(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false } });
  }
  return release.html_url;
}

export async function publishGitHub() {
  const snapshot = process.env.FLOW_RELEASE_KIND === 'build';
  const info = await releaseInfo({ requireTag: !snapshot });
  if (snapshot) {
    if (process.env.CNB_BRANCH !== 'main' || process.env.CNB_IS_TAG === 'true') {
      throw new Error('构建版 Release 仅供 CNB main 分支使用。');
    }
    info.tag = info.buildTag;
    info.prerelease = true;
  }
  const repo = process.env.FLOW_GITHUB_REPO || 'hi-yu/flow-translate';
  const token = process.env.FLOW_GITHUB_TOKEN;
  const api = githubClient({ repo, token });
  const metadata = JSON.parse(await readFile('releases/release.json', 'utf8'));
  if (
    metadata.version !== info.version ||
    metadata.commit !== info.commit ||
    metadata.tag !== info.tag
  ) {
    throw new Error('安装包元数据与本次版本或提交不一致。');
  }
  const branch = await api(
    '/git/ref/heads/' + info.syncBranch.split('/').map(encodeURIComponent).join('/'),
  );
  if (branch.object.sha !== info.commit) throw new Error('GitHub 同步分支尚未指向本次构建提交。');
  const files = [];
  const packages = snapshot ? [info.zip] : [info.zip, info.crx];
  for (const name of [...packages, 'SHA256SUMS', 'release.json']) {
    const bytes = await readFile(join('releases', name));
    if (
      packages.includes(name) &&
      metadata.files.find((file) => file.name === name)?.sha256 !== sha256(bytes)
    ) {
      throw new Error(`${name} 与签名时的校验值不同。`);
    }
    files.push({ name, bytes });
  }
  const tagRef = `refs/tags/${info.tag}`;
  if (snapshot) {
    const existing = git(['for-each-ref', '--format=%(objectname)', tagRef]);
    if (!existing) git(['tag', info.tag, info.commit]);
    if (git(['rev-parse', `${tagRef}^{commit}`]) !== info.commit) {
      throw new Error('构建标签已存在但提交不同。');
    }
  }
  await pushGitHubRef({ repo, token, ref: tagRef });
  const notes = await readFile('releases/release-notes.md', 'utf8');
  const url = await publishRelease({ api, info, files, notes });
  console.log(`GitHub Release 已同步：${url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await publishGitHub();
}
