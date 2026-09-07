// generates the vault keypair and appends VAULT_SECRET_KEY to ../.env if absent.
// prints ONLY the public address. never prints the secret.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { const x = (digits[i] << 8) + carry; digits[i] = x % 58; carry = (x / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let lead = ''; for (const b of buf) { if (b === 0) lead += '1'; else break; }
  return lead + digits.reverse().map((d) => B58[d]).join('');
}
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '..', '.env');
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
if (/^VAULT_SECRET_KEY=\S+/m.test(existing)) { console.log('VAULT_SECRET_KEY already present in server/.env, not overwriting.'); process.exit(0); }
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
const seed = Buffer.from(pkcs8.subarray(pkcs8.length - 32));
const spki = publicKey.export({ format: 'der', type: 'spki' });
const pub = Buffer.from(spki.subarray(spki.length - 32));
const secret64 = Buffer.concat([seed, pub]);
const line = `VAULT_SECRET_KEY=${b58encode(secret64)}`;
fs.writeFileSync(envPath, (existing ? existing.replace(/\s*$/, '') + '\n' : '') + line + '\n' + `VAULT_ADDRESS=${b58encode(pub)}\n`);
console.log('vault address:', b58encode(pub));
console.log('secret written to server/.env (gitignored). back it up now.');
