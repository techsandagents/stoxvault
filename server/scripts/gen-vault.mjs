// generates the vault keypair and appends VAULT_SECRET_KEY to ../.env if absent.
// prints ONLY the public address. never prints the secret.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One base58 implementation, shared with the server, rather than a second copy here:
// a duplicate encoder is exactly the kind of thing that silently disagrees later.
process.env.STOCKDROP_QUIET = '1';
const { b58encode } = await import(new URL('../src/config.js', import.meta.url).href);

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
