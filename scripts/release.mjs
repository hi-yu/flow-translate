import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, releaseInfo } from './release-info.mjs';

export async function release({ cwd = process.cwd() } = {}) {
  if (git(['branch', '--show-current'], cwd) !== 'main') {
    throw new Error('请在 main 分支发布。');
  }
  if (git(['status', '--porcelain'], cwd)) throw new Error('工作区有未提交的更改。');

  const info = await releaseInfo({ cwd, env: {} });
  const remoteMain = git(['ls-remote', '--heads', 'cnb', 'refs/heads/main'], cwd).split(/\s/)[0];
  if (remoteMain !== info.commit) throw new Error('本地 main 与 CNB main 不一致。');

  const ref = `refs/tags/${info.tag}`;
  const remoteTag = git(['ls-remote', '--tags', 'cnb', ref], cwd);
  if (remoteTag) throw new Error(`${info.tag} 已发布；请递增版本，或在 CNB 重试已有构建。`);
  const localTag = git(['for-each-ref', '--format=%(objectname)', ref], cwd);
  if (localTag) {
    if (git(['rev-parse', `${ref}^{commit}`], cwd) !== info.commit) {
      throw new Error(`${info.tag} 已指向其他提交；请勿覆盖已有版本。`);
    }
  } else {
    execFileSync('git', ['tag', '-a', info.tag, '-m', `译流 ${info.tag}`], {
      cwd,
      stdio: 'inherit',
    });
  }
  execFileSync('git', ['push', 'cnb', `${ref}:${ref}`], { cwd, stdio: 'inherit' });
  console.log(`已推送 ${info.tag}，CNB 将自动构建并同步 Release。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await release();
}
