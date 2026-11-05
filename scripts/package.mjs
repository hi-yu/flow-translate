import { chmod, mkdir, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(join(directory, entry.name), name)));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`打包目录不允许包含符号链接：${name}`);
  }
  return files.sort();
}

export async function packageZip(cwd = process.cwd()) {
  const { version } = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
  const dist = resolve(cwd, 'dist');
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('dist 版本过期，请重新构建。');
  await mkdir(resolve(cwd, 'releases'), { recursive: true });
  const archive = resolve(cwd, `releases/flow-translate-${version}-chrome.zip`);
  const files = await filesIn(dist);
  // 固定时间、权限和排序，使同一构建重试时保持相同的 ZIP 与 CRX 校验值。
  const timestamp = new Date('2000-01-01T00:00:00Z');
  for (const name of files) {
    await chmod(join(dist, name), 0o644);
    await utimes(join(dist, name), timestamp, timestamp);
  }
  await rm(archive, { force: true });
  execFileSync('zip', ['-X', '-q', '-9', archive, ...files], {
    cwd: dist,
    env: { ...process.env, TZ: 'UTC' },
  });
  return archive;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await packageZip());
}
