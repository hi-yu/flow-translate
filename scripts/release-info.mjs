import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function releaseInfo({
  cwd = process.cwd(),
  env = process.env,
  requireTag = false,
} = {}) {
  const { version } = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(cwd, 'public/manifest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.version !== version) {
    throw new Error('package.json 与 manifest.json 的版本必须一致。');
  }
  const commit = git(['rev-parse', 'HEAD'], cwd);
  if (env.CNB_COMMIT && env.CNB_COMMIT !== commit)
    throw new Error('构建提交与 CNB_COMMIT 不一致。');
  const tag = `v${version}`;
  if (requireTag) {
    if (env.CNB_IS_TAG !== 'true' || env.CNB_BRANCH !== tag) {
      throw new Error(`仅允许在 ${tag} 的 tag_push 构建中发布。`);
    }
    if (git(['rev-parse', `refs/tags/${tag}^{commit}`], cwd) !== commit) {
      throw new Error('版本标签未指向本次构建提交。');
    }
  }
  const source = env.CNB_BRANCH || git(['branch', '--show-current'], cwd);
  const syncBranch =
    env.CNB_IS_TAG !== 'true' && source === 'main'
      ? 'main'
      : `cnb-sync/${env.CNB_IS_TAG === 'true' ? 'tags/' : ''}${source}`;
  git(['check-ref-format', '--branch', syncBranch], cwd);
  return {
    version,
    tag,
    buildTag: `build-${version}-${commit.slice(0, 12)}`,
    commit,
    syncBranch,
    zip: `flow-translate-${version}-chrome.zip`,
    crx: `flow-translate-${version}-chrome.crx`,
  };
}

async function prepareSync() {
  const info = await releaseInfo({ requireTag: process.env.CNB_IS_TAG === 'true' });
  const existing = git(['for-each-ref', '--format=%(objectname)', `refs/heads/${info.syncBranch}`]);
  if (existing && existing !== info.commit) throw new Error('本地同步分支已存在且提交不同。');
  if (!existing) git(['branch', info.syncBranch, info.commit]);
  for (const [key, value] of Object.entries({
    version: info.version,
    tag: info.tag,
    build_tag: info.buildTag,
    sync_branch: info.syncBranch,
    zip: `releases/${info.zip}`,
    crx: `releases/${info.crx}`,
  })) {
    console.log(`##[set-output ${key}=${value}]`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareSync();
}
