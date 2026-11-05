import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { packageZip } from '../../scripts/package.mjs';
import { signZip } from '../../scripts/package-crx.mjs';
import { extensionId, signingKey } from '../../scripts/signing-key.mjs';
import { releaseInfo } from '../../scripts/release-info.mjs';
import { packageSnapshot } from '../../scripts/package-snapshot.mjs';

const require = createRequire(import.meta.url);
const Pbf = require('pbf');
function decodeBytes(bytes) {
  return new Pbf(bytes).readFields((tag, fields, reader) => {
    (fields[tag] ||= []).push(Buffer.from(reader.readBytes()));
  }, {});
}

test('重复打包的 ZIP 与 CRX 一致，RSA 签名覆盖原始 ZIP 且扩展 ID 稳定', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flow-package-test-'));
  try {
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'package.json'), '{"version":"0.1.0"}');
    await writeFile(
      join(directory, 'dist/manifest.json'),
      '{"manifest_version":3,"version":"0.1.0","name":"Test"}',
    );
    await writeFile(join(directory, 'dist/content.js'), 'console.log("test");');
    const zipPath = await packageZip(directory);
    const zip = await readFile(zipPath);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const crxPath = join(directory, 'extension.crx');
    const id = await signZip({ zipPath, crxPath, pem });
    const crx = await readFile(crxPath);
    assert.equal(crx.toString('ascii', 0, 4), 'Cr24');
    assert.equal(crx.readUInt32LE(4), 3);
    const headerEnd = 12 + crx.readUInt32LE(8);
    const header = decodeBytes(crx.subarray(12, headerEnd));
    assert.deepEqual(crx.subarray(headerEnd), zip);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header[10000][0].length);
    const signed = Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, header[10000][0], zip]);
    const proof = decodeBytes(header[2][0]);
    assert.ok(
      verify(
        'sha256',
        signed,
        createPublicKey({ key: proof[1][0], type: 'spki', format: 'der' }),
        proof[2][0],
      ),
    );
    const signedData = decodeBytes(header[10000][0]);
    assert.equal(signedData[1][0].length, 16);
    assert.equal(
      signedData[1][0]
        .toString('hex')
        .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16))),
      id,
    );
    assert.equal(id, extensionId(privateKey));
    await utimes(join(directory, 'dist/content.js'), new Date(), new Date());
    assert.deepEqual(await readFile(await packageZip(directory)), zip);
    assert.equal(await signZip({ zipPath, crxPath, pem }), id);
    assert.deepEqual(await readFile(crxPath), crx);
    assert.throws(() => signingKey('invalid-private-key'), /有效的 PEM/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('版本标签与实际提交不一致时拒绝发布', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'flow-ref-test-'));
  const run = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    await mkdir(join(cwd, 'public'));
    await writeFile(join(cwd, 'package.json'), '{"version":"0.1.0"}');
    await writeFile(join(cwd, 'public/manifest.json'), '{"version":"0.1.0"}');
    run('init', '-b', 'test-release');
    run('config', 'user.name', 'Release Test');
    run('config', 'user.email', 'release-test@example.invalid');
    run('add', '.');
    run('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test fixture');
    run('tag', 'v0.1.0');
    const env = { CNB_IS_TAG: 'true', CNB_BRANCH: 'v0.1.0' };
    assert.equal(
      (await releaseInfo({ cwd, env, requireTag: true })).syncBranch,
      'cnb-sync/tags/v0.1.0',
    );
    const mainEnv = { CNB_BRANCH: 'main', CNB_COMMIT: run('rev-parse', 'HEAD').toString().trim() };
    const main = await releaseInfo({ cwd, env: mainEnv });
    assert.equal(main.syncBranch, 'main');
    assert.equal(main.buildTag, `build-0.1.0-${main.commit.slice(0, 12)}`);
    await mkdir(join(cwd, 'releases'));
    await writeFile(join(cwd, 'releases', main.zip), 'snapshot zip');
    await packageSnapshot({ cwd, env: mainEnv });
    const metadata = JSON.parse(await readFile(join(cwd, 'releases/release.json'), 'utf8'));
    assert.equal(metadata.tag, main.buildTag);
    assert.equal(metadata.commit, main.commit);
    assert.equal(metadata.prerelease, true);
    assert.deepEqual(
      metadata.files.map((file) => file.name),
      [main.zip],
    );
    await assert.rejects(packageSnapshot({ cwd, env: { CNB_BRANCH: 'feature' } }), /仅供/);
    await assert.rejects(
      releaseInfo({ cwd, env: { ...env, CNB_BRANCH: 'v0.2.0' }, requireTag: true }),
      /仅允许/,
    );
    await writeFile(join(cwd, 'new-file'), 'changed');
    run('add', '.');
    run('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'second fixture');
    await assert.rejects(releaseInfo({ cwd, env, requireTag: true }), /标签未指向/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
