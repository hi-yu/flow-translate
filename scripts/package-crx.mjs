import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import crx3 from 'crx3';
import { defaultKeyPath, extensionId, signingKey } from './signing-key.mjs';
import { releaseInfo } from './release-info.mjs';

export async function signZip({ zipPath, crxPath, pem }) {
  const key = signingKey(pem);
  const temporary = await mkdtemp(join(tmpdir(), 'flow-sign-'));
  try {
    const keyPath = join(temporary, 'key.pem');
    await writeFile(keyPath, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await crx3(createReadStream(zipPath), { keyPath, crxPath });
    return extensionId(key);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function packageCrx({ cwd = process.cwd(), env = process.env } = {}) {
  const info = await releaseInfo({ cwd, env, requireTag: env.CNB_IS_TAG === 'true' });
  const built = JSON.parse(await readFile(resolve(cwd, 'dist/manifest.json'), 'utf8'));
  if (built.version !== info.version) throw new Error('dist 版本过期，请先重新构建。');
  const pem =
    env.FLOW_EXTENSION_KEY_PEM ||
    (await readFile(env.FLOW_EXTENSION_KEY_FILE || defaultKeyPath(), 'utf8'));
  const output = resolve(cwd, 'releases');
  const id = await signZip({
    zipPath: join(output, info.zip),
    crxPath: join(output, info.crx),
    pem,
  });
  const files = [];
  for (const name of [info.zip, info.crx]) {
    files.push({ name, sha256: sha256(await readFile(join(output, name))) });
  }
  await writeFile(
    join(output, 'SHA256SUMS'),
    files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
  );
  await writeFile(
    join(output, 'release.json'),
    JSON.stringify(
      {
        version: info.version,
        tag: info.tag,
        commit: info.commit,
        extensionId: id,
        files,
      },
      null,
      2,
    ) + '\n',
  );
  const changelog = await readFile(resolve(cwd, 'CHANGELOG.md'), 'utf8');
  const heading = `## [${info.version}]`;
  const section = changelog.split('\n').findIndex((line) => line.startsWith(heading));
  if (section < 0) throw new Error('CHANGELOG.md 缺少当前版本的更新记录。');
  const lines = changelog.split('\n').slice(section + 1);
  const next = lines.findIndex((line) => /^## /.test(line));
  const changes = (next < 0 ? lines : lines.slice(0, next)).join('\n').trim();
  await writeFile(
    join(output, 'release-notes.md'),
    `${changes}\n\n构建提交：\`${info.commit}\`\n\nZIP 解压后通过开发者模式加载。CRX 为自行签名，安装仍受 Chrome 平台策略限制。\n`,
  );
  console.log(`已生成 ${info.crx}，扩展 ID：${id}`);
  return { ...info, extensionId: id, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await packageCrx();
}
