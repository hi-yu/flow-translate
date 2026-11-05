import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, releaseInfo } from './release-info.mjs';

export async function pushGitHubRef({ repo, token, ref, cwd = process.cwd(), env = process.env }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GitHub 仓库必须为 owner/repo。');
  if (!token || /[\r\n]/.test(token)) throw new Error('缺少有效的 FLOW_GITHUB_TOKEN。');
  if (ref === 'refs/heads/main') {
    if (
      env.CNB_BRANCH !== 'main' ||
      env.CNB_IS_TAG === 'true' ||
      !env.CNB_COMMIT ||
      git(['rev-parse', ref], cwd) !== env.CNB_COMMIT ||
      git(['rev-parse', 'HEAD'], cwd) !== env.CNB_COMMIT
    ) {
      throw new Error('仅允许从已通过检查的 CNB main 构建同步 GitHub main。');
    }
  } else if (!/^refs\/(heads\/cnb-sync\/|tags\/(v|build-))/.test(ref)) {
    throw new Error('仅允许同步 main、专用分支或发布标签。');
  }
  git(['check-ref-format', ref], cwd);
  const directory = await mkdtemp(join(tmpdir(), 'flow-github-'));
  try {
    const askpass = join(directory, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\nprintf "%s\\n" "$FLOW_GITHUB_TOKEN"\n', { mode: 0o700 });
    try {
      execFileSync(
        'git',
        [
          '-c',
          'credential.helper=',
          '-c',
          'credential.username=x-access-token',
          'push',
          '--porcelain',
          `https://github.com/${repo}.git`,
          `${ref}:${ref}`,
        ],
        {
          cwd,
          env: {
            ...env,
            FLOW_GITHUB_TOKEN: token,
            GIT_ASKPASS: askpass,
            GIT_TERMINAL_PROMPT: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch {
      // 不回显 Git 的认证信息；未使用强推，分歧和受保护引用会由服务端拒绝。
      throw new Error('GitHub 推送失败，请检查认证、网络和远端引用是否存在分歧。');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function syncGitHub() {
  const info = await releaseInfo({ requireTag: process.env.CNB_IS_TAG === 'true' });
  const ref = `refs/heads/${info.syncBranch}`;
  if (git(['rev-parse', ref]) !== info.commit) throw new Error('同步分支未指向本次构建提交。');
  await pushGitHubRef({
    repo: process.env.FLOW_GITHUB_REPO || 'hi-yu/flow-translate',
    token: process.env.FLOW_GITHUB_TOKEN,
    ref,
  });
  console.log(`已同步 GitHub 分支：${info.syncBranch}，提交：${info.commit}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await syncGitHub();
}
