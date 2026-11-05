import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseInfo } from './release-info.mjs';
import { sha256 } from './package-crx.mjs';

export async function packageSnapshot({ cwd = process.cwd(), env = process.env } = {}) {
  const info = await releaseInfo({ cwd, env });
  if (env.CNB_BRANCH !== 'main' || env.CNB_IS_TAG === 'true') {
    throw new Error('构建版 Release 仅供 CNB main 分支使用。');
  }
  const output = resolve(cwd, 'releases');
  const files = [{ name: info.zip, sha256: sha256(await readFile(join(output, info.zip))) }];
  await writeFile(join(output, 'SHA256SUMS'), `${files[0].sha256}  ${info.zip}\n`);
  await writeFile(
    join(output, 'release.json'),
    JSON.stringify(
      { version: info.version, tag: info.buildTag, commit: info.commit, prerelease: true, files },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(output, 'release-notes.md'),
    `main 分支构建版，版本 ${info.version}。\n\n构建提交：\`${info.commit}\`\n\n下载 ZIP，解压后通过 Chrome 开发者模式加载。正式版本标签另行提供签名 CRX。\n`,
  );
  console.log(`已准备构建版 Release：${info.buildTag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await packageSnapshot();
}
