import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function signingKey(pem) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('CRX 签名私钥不是有效的 PEM 私钥。');
  }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('CRX 签名需要至少 2048 位的 RSA 私钥。');
  }
  return key;
}

export function extensionId(key) {
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

export function defaultKeyPath() {
  return resolve(homedir(), '.config/flow-translate/signing-key.pem');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.env.FLOW_EXTENSION_KEY_FILE || defaultKeyPath();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`签名私钥已保存：${path}`);
  console.log(`扩展 ID：${extensionId(privateKey)}`);
}
