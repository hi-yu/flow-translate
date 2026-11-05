import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { release } from '../../scripts/release.mjs';

test('发布命令只为已同步且干净的 main 创建版本标签', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flow-release-command-'));
  const source = join(directory, 'source');
  const remote = join(directory, 'remote.git');
  const run = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    run(directory, 'init', '--bare', remote);
    run(directory, 'init', '-b', 'main', source);
    run(source, 'config', 'user.name', 'Release Test');
    run(source, 'config', 'user.email', 'release-test@example.invalid');
    await mkdir(join(source, 'public'));
    await writeFile(join(source, 'package.json'), '{"version":"0.1.0"}');
    await writeFile(join(source, 'public/manifest.json'), '{"version":"0.1.0"}');
    run(source, 'add', '.');
    run(source, 'commit', '-m', 'initial');
    run(source, 'remote', 'add', 'cnb', remote);
    run(source, 'push', 'cnb', 'main');

    await release({ cwd: source });
    assert.equal(
      run(remote, 'rev-parse', 'refs/tags/v0.1.0^{commit}'),
      run(source, 'rev-parse', 'HEAD'),
    );
    await assert.rejects(release({ cwd: source }), /已发布/);

    await writeFile(join(source, 'extra'), 'uncommitted');
    await assert.rejects(release({ cwd: source }), /未提交/);
    run(source, 'add', 'extra');
    run(source, 'commit', '-m', 'not pushed');
    await assert.rejects(release({ cwd: source }), /不一致/);
    run(source, 'switch', '-c', 'feature');
    await assert.rejects(release({ cwd: source }), /main 分支/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
