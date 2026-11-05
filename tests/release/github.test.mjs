import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubClient, publishRelease } from '../../scripts/publish-github.mjs';
import { sha256 } from '../../scripts/package-crx.mjs';
import { pushGitHubRef } from '../../scripts/sync-github.mjs';

const info = { tag: 'v0.1.0' };
const bytes = Buffer.from('test extension package');
const files = [{ name: 'test.zip', bytes }];

function mockAPI({ failUpload = false, assets = [], drafts = [] } = {}) {
  const calls = [];
  const release = {
    id: 7,
    draft: true,
    html_url: 'https://github.com/example/test/releases/tag/v0.1.0',
    upload_url: 'https://uploads.github.com/repos/example/test/releases/7/assets{?name,label}',
  };
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.startsWith('/releases/tags/')) return null;
    if (path === '/releases?per_page=100&page=1') return drafts;
    if (path === '/releases') return release;
    if (path.endsWith('/assets?per_page=100')) return assets;
    if (path.startsWith('/releases/assets/') && options.method === 'DELETE') return null;
    if (path.startsWith('https://uploads.github.com/')) {
      if (failUpload) throw new Error('upload failed');
      return { id: 8, name: 'test.zip', digest: 'sha256:' + sha256(bytes) };
    }
    if (options.method === 'PATCH') return { ...release, draft: false };
    throw new Error('Unexpected API request: ' + path);
  };
  return { api, calls };
}

test('安装包上传校验通过后才公开 GitHub Release', async () => {
  const { api, calls } = mockAPI();
  await publishRelease({ api, info, files, notes: 'Release notes' });
  assert.equal(calls.find((call) => call.path === '/releases').body.draft, true);
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.equal(calls.at(-1).body.draft, false);
});

test('上传重试恢复已有草稿，并清理上传失败留下的空附件', async () => {
  const draft = {
    id: 7,
    draft: true,
    tag_name: info.tag,
    html_url: 'https://github.com/example/test/releases/tag/v0.1.0',
    upload_url: 'https://uploads.github.com/repos/example/test/releases/7/assets{?name,label}',
  };
  const { api, calls } = mockAPI({
    drafts: [draft],
    assets: [{ id: 9, name: 'test.zip', state: 'starter', size: 0 }],
  });
  await publishRelease({ api, info, files, notes: 'Notes' });
  assert.ok(!calls.some((call) => call.path === '/releases' && call.method === 'POST'));
  assert.ok(calls.some((call) => call.path === '/releases/assets/9' && call.method === 'DELETE'));
  assert.ok(calls.some((call) => call.path.startsWith('https://uploads.github.com/')));
  assert.equal(calls.at(-1).method, 'PATCH');
});

test('上传失败时保留草稿，不发布残缺版本', async () => {
  const { api, calls } = mockAPI({ failUpload: true });
  await assert.rejects(publishRelease({ api, info, files, notes: 'Notes' }), /upload failed/);
  assert.ok(!calls.some((call) => call.method === 'PATCH'));
});

test('重试跳过相同附件，拒绝覆盖校验值不同的附件', async () => {
  const existing = [{ name: 'test.zip', digest: 'sha256:' + sha256(bytes) }];
  const same = mockAPI({ assets: existing });
  await publishRelease({ api: same.api, info, files, notes: 'Notes' });
  assert.ok(!same.calls.some((call) => call.path.startsWith('https://uploads.github.com/')));
  const different = mockAPI({ assets: [{ name: 'test.zip', digest: 'sha256:other' }] });
  await assert.rejects(
    publishRelease({ api: different.api, info, files, notes: 'Notes' }),
    /不覆盖/,
  );
  assert.ok(!different.calls.some((call) => call.method === 'DELETE' || call.method === 'PATCH'));
});

test('发布凭据只能发送到 GitHub 官方 API', async () => {
  let called = false;
  const api = githubClient({
    repo: 'example/test',
    token: 'test-token',
    fetch: async () => {
      called = true;
    },
  });
  await assert.rejects(api('https://untrusted.example/upload'), /非 GitHub/);
  assert.equal(called, false);
});

test('同步保留远端的分歧提交，仅从对应 CNB main 构建更新主干', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flow-sync-test-'));
  const source = join(directory, 'source');
  const remote = join(directory, 'target.git');
  const other = join(directory, 'other');
  const run = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Release Test',
        GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
        GIT_COMMITTER_NAME: 'Release Test',
        GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
      },
    }).trim();
  try {
    run(directory, 'init', '--bare', remote);
    run(directory, 'init', '-b', 'cnb-sync/test', source);
    await writeFile(join(source, 'file'), 'baseline');
    run(source, 'add', '.');
    run(source, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline');
    const options = {
      repo: 'example/test',
      token: 'test-token',
      ref: 'refs/heads/cnb-sync/test',
      cwd: source,
      // 将官方 URL 改写到隔离的本地裸仓库，测试不访问网络或真实凭据。
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/example/test.git',
      },
    };
    await pushGitHubRef(options);
    run(directory, 'clone', '-b', 'cnb-sync/test', remote, other);
    await writeFile(join(other, 'file'), 'remote change');
    run(other, 'add', '.');
    run(other, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'remote change');
    run(other, 'push', 'origin', 'cnb-sync/test');
    const remoteCommit = run(remote, 'rev-parse', options.ref);
    await writeFile(join(source, 'file'), 'local change');
    run(source, 'add', '.');
    run(source, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'local change');
    await assert.rejects(pushGitHubRef(options), /推送失败/);
    assert.equal(run(remote, 'rev-parse', options.ref), remoteCommit);
    run(source, 'branch', 'main');
    const mainOptions = { ...options, ref: 'refs/heads/main' };
    await assert.rejects(pushGitHubRef(mainOptions), /仅允许/);
    await assert.rejects(
      pushGitHubRef({
        ...mainOptions,
        env: {
          ...options.env,
          CNB_BRANCH: 'feature',
          CNB_COMMIT: run(source, 'rev-parse', 'HEAD'),
        },
      }),
      /仅允许/,
    );
    await pushGitHubRef({
      ...mainOptions,
      env: {
        ...options.env,
        CNB_BRANCH: 'main',
        CNB_IS_TAG: 'false',
        CNB_COMMIT: run(source, 'rev-parse', 'HEAD'),
      },
    });
    assert.equal(run(remote, 'rev-parse', 'refs/heads/main'), run(source, 'rev-parse', 'HEAD'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
