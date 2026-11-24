#!/usr/bin/env node
/**
 * Generates the Ed25519 key pair that signs on-prem licences.
 *
 *   node scripts/generate-onprem-license-key.mjs <private-key-file> [kid]
 *
 * - Writes the PRIVATE key (PKCS#8 PEM) to <private-key-file>, mode 0600, and
 *   refuses to overwrite an existing file. It goes into the SaaS secret store as
 *   ONPREM_LICENSE_SIGNING_KEY (with ONPREM_LICENSE_SIGNING_KEY_ID=<kid>) and
 *   nowhere else: never into git, an image or a customer artefact.
 * - Prints only the PUBLIC key (SPKI DER, base64): that line goes into
 *   TRUSTED_PUBLIC_KEYS in src/licensing/artifact/license-artifact.crypto.ts.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [file, kid = 'v1'] = process.argv.slice(2);

if (!file) {
  console.error(
    'usage: generate-onprem-license-key.mjs <private-key-file> [kid]',
  );
  process.exit(1);
}
if (existsSync(file)) {
  console.error(`refusing to overwrite ${file}`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  mode: 0o600,
  flag: 'wx',
});

console.log(`private key written to ${file} (kid ${kid})`);
console.log(`public key for TRUSTED_PUBLIC_KEYS['${kid}']:`);
console.log(
  publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
);
