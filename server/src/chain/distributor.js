/**
 * STOCKDROP chain / distributor
 *
 * The only code in the repo that moves tokens. Everything here is written
 * against one requirement: a holder must never be paid twice, and must never be
 * silently skipped.
 *
 * Shape of a send:
 *   ComputeBudget(limit, price)
 *   for each recipient in the batch:
 *     createAssociatedTokenAccountIdempotent(payer = vault)   <- project pays rent
 *     transferChecked(vault ATA -> holder ATA, amount, decimals)
 *   compiled to a v0 message, signed by the vault, sent, confirmed.
 *
 * The idempotent ATA instruction is what makes a retry safe: if the account
 * already exists (because the previous attempt actually landed and we never saw
 * the confirmation) it is a no-op instead of a failure.
 *
 * Before any retry of a batch we establish what really happened on chain:
 *   1. ask the cluster about the previous signature(s) — a confirmed one means
 *      the batch landed and nothing is resent;
 *   2. compare each recipient's balance against the pre-batch reading — if the
 *      tokens are already there, that transfer is marked DONE, not repeated.
 * Only transfers that provably did not arrive are rebuilt and sent again.
 *
 * Guard of last resort: ensureAndTransfer refuses to run at all unless
 * cfg.mode === 'LIVE'. DRY_RUN never reaches the network through this module.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { setTimeout as delay } from 'node:timers/promises';

export const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();

export class DistributorError extends Error {
  constructor(message, code = 'distributor_error') {
    super(message);
    this.name = 'DistributorError';
    this.code = code;
  }
}

function toBig(value, what) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new DistributorError(`${what}: expected a base-unit integer, got ${JSON.stringify(value)}`, 'bad_amount');
}

function chunk(items, size) {
  const out = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/**
 * Compute budget for a batch. An idempotent ATA creation is the expensive part
 * (~22k CU); a transferChecked on Token-2022 is ~10k with the extensions these
 * mints carry. 45k per recipient plus overhead is comfortably above both, and
 * unused CUs cost nothing.
 */
export function computeUnitsFor(count) {
  return Math.min(1_400_000, 40_000 + Math.max(1, count) * 45_000);
}

/** priorityFeeLamports for the whole tx -> microLamports per compute unit. */
export function microLamportsFor(priorityFeeLamports, computeUnitLimit) {
  const lamports = Math.max(0, Number(priorityFeeLamports) || 0);
  const units = Math.max(1, Number(computeUnitLimit) || 1);
  return Math.floor((lamports * 1_000_000) / units);
}

/**
 * @param {{cfg: object, rpc: object, logger?: object, sleep?: (ms:number)=>Promise<void>}} deps
 */
export function createDistributor({ cfg, rpc, logger = null, sleep = (ms) => delay(ms) } = {}) {
  if (!cfg) throw new DistributorError('createDistributor: cfg is required', 'bad_argument');
  if (!rpc) throw new DistributorError('createDistributor: rpc is required', 'bad_argument');

  /* --------------------------------------------------------- measurement */

  /**
   * measureReceived(vaultAddress, mint, beforeRaw)
   * The real delta of the vault's holding of `mint`. This — not the Jupiter
   * quote — is what a LIVE round distributes.
   * @returns {Promise<{beforeRaw: bigint, afterRaw: bigint, receivedRaw: bigint}>}
   */
  async function measureReceived(vaultAddress, mint, beforeRaw = 0n) {
    const before = toBig(beforeRaw ?? 0, 'beforeRaw');
    const after = await rpc.getTokenAccountBalanceRaw(String(vaultAddress), String(mint), TOKEN_2022_PROGRAM);
    let received = after - before;
    if (received < 0n) {
      // The balance went down across a buy. Something else moved tokens; do not
      // invent a positive number, distribute nothing for this stock.
      logger?.warn?.(`distributor: ${mint} balance fell during the swap (before ${before}, after ${after}); treating received as 0`);
      received = 0n;
    }
    return { beforeRaw: before, afterRaw: after, receivedRaw: received };
  }

  /** Current holding of `mint` for one owner. */
  async function balanceOf(owner, mint) {
    return rpc.getTokenAccountBalanceRaw(String(owner), String(mint), TOKEN_2022_PROGRAM);
  }

  /* ----------------------------------------------------------- mint check */

  /**
   * Read the mint once per round and refuse to send if its rules changed under
   * us: a transfer hook would need extra accounts we do not build, a pause
   * would make every transfer fail, and a decimals mismatch would move the
   * decimal point on every holder's payout.
   */
  async function assertMintIsTransferable(mint, decimals) {
    const info = await rpc.getMintInfo(String(mint));
    if (!info) throw new DistributorError(`mint ${mint} not found on chain`, 'mint_not_found');
    if (info.programId !== TOKEN_2022_PROGRAM) {
      throw new DistributorError(`mint ${mint} is owned by ${info.programId}, expected Token-2022`, 'wrong_token_program');
    }
    if (Number(info.decimals) !== Number(decimals)) {
      throw new DistributorError(`mint ${mint} has ${info.decimals} decimals, round assumed ${decimals}`, 'decimals_mismatch');
    }
    if (info.transferHookProgramId) {
      throw new DistributorError(
        `mint ${mint} now has a transfer hook (${info.transferHookProgramId}); plain transferChecked is no longer valid`,
        'transfer_hook',
      );
    }
    if (info.paused) throw new DistributorError(`mint ${mint} is paused by the issuer`, 'mint_paused');
    return info;
  }

  /* -------------------------------------------------------- tx assembly */

  /**
   * One versioned transaction for a batch of transfers.
   * @returns {{tx: VersionedTransaction, computeUnitLimit: number}}
   */
  function buildBatchTx({ vaultKeypair, mint, decimals, batch, blockhash, priorityFeeLamports }) {
    const mintKey = new PublicKey(mint);
    const source = getAssociatedTokenAddressSync(mintKey, vaultKeypair.publicKey, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const computeUnitLimit = computeUnitsFor(batch.length);
    const microLamports = microLamportsFor(priorityFeeLamports, computeUnitLimit);
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })];
    if (microLamports > 0) instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));

    for (const row of batch) {
      const owner = new PublicKey(row.wallet);
      const destination = getAssociatedTokenAddressSync(mintKey, owner, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          vaultKeypair.publicKey,
          destination,
          owner,
          mintKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createTransferCheckedInstruction(
          source,
          mintKey,
          destination,
          vaultKeypair.publicKey,
          row.amount,
          Number(decimals),
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      );
    }

    const message = new TransactionMessage({
      payerKey: vaultKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([vaultKeypair]);
    return { tx, computeUnitLimit };
  }

  /* ----------------------------------------------------------- the sender */

  /**
   * ensureAndTransfer(vaultKeypair, mint, decimals, transfers, opts)
   *
   * @param {import('@solana/web3.js').Keypair} vaultKeypair
   * @param {string} mint
   * @param {number} decimals
   * @param {{wallet: string, amountRaw: string|bigint, symbol?: string}[]} transfers
   * @param {{
   *   batchSize?: number, priorityFeeLamports?: number, maxAttempts?: number,
   *   confirmTimeoutMs?: number, verifyBalances?: boolean,
   *   onBatch?: (results: object[]) => any|Promise<any>
   * }} [opts]
   * @returns {Promise<{wallet, mint, amountRaw, tx, status, error}[]>} one row per input transfer
   */
  async function ensureAndTransfer(vaultKeypair, mint, decimals, transfers = [], opts = {}) {
    if (cfg.mode !== 'LIVE') {
      throw new DistributorError(`refusing to send: mode is ${cfg.mode || 'unset'}, not LIVE`, 'not_live');
    }
    if (!vaultKeypair?.publicKey || typeof vaultKeypair.secretKey === 'undefined') {
      throw new DistributorError('ensureAndTransfer: a vault keypair is required', 'no_signer');
    }

    const batchSize = Math.max(1, Math.min(Number(opts.batchSize) || 8, 12));
    const priorityFeeLamports = Number.isFinite(opts.priorityFeeLamports) ? opts.priorityFeeLamports : (cfg.priorityFeeLamports ?? 200000);
    const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 3);
    const confirmTimeoutMs = Number.isFinite(opts.confirmTimeoutMs) ? opts.confirmTimeoutMs : 90_000;
    const verifyBalances = opts.verifyBalances !== false;
    const onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : null;
    const vaultAddress = vaultKeypair.publicKey.toBase58();

    const results = [];
    const sendable = [];

    for (const transfer of Array.isArray(transfers) ? transfers : []) {
      const wallet = transfer?.wallet;
      const base = { wallet: String(wallet ?? ''), mint: String(mint), amountRaw: '0', tx: null, status: 'FAILED', error: null };
      let amount;
      try {
        amount = toBig(transfer?.amountRaw ?? 0, `amountRaw of ${wallet}`);
      } catch (err) {
        results.push({ ...base, error: err.message });
        continue;
      }
      base.amountRaw = amount.toString();

      if (amount === 0n) {
        // Never create an account to deliver nothing: rent would cost more than
        // the payout is worth. This is dust, and it carries to the next round.
        results.push({ ...base, status: 'SKIPPED_DUST', error: null });
        continue;
      }
      if (typeof wallet !== 'string' || wallet === '') {
        results.push({ ...base, error: 'missing wallet' });
        continue;
      }
      if (wallet === vaultAddress) {
        results.push({ ...base, error: 'refusing to transfer to the vault itself' });
        continue;
      }
      let owner;
      try {
        owner = new PublicKey(wallet);
      } catch {
        results.push({ ...base, error: 'not a valid solana address' });
        continue;
      }
      sendable.push({ wallet, owner, amount, index: results.length });
      results.push({ ...base, status: 'PENDING' });
    }

    if (sendable.length === 0) {
      if (onBatch) await onBatch(results.slice());
      return results;
    }

    await assertMintIsTransferable(mint, decimals);

    for (const batch of chunk(sendable, batchSize)) {
      /** wallet -> balance before we sent anything, for the double-send guard. */
      const before = new Map();
      if (verifyBalances) {
        const readings = await Promise.all(batch.map((row) => balanceOf(row.wallet, mint).catch(() => null)));
        batch.forEach((row, i) => before.set(row.wallet, readings[i]));
      }

      let remaining = batch.slice();
      const signatures = [];
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts && remaining.length > 0; attempt++) {
        if (attempt > 1) {
          // Establish the truth before doing anything again.
          const settled = await reconcile({ mint, rows: remaining, signatures, before, results, verifyBalances });
          remaining = remaining.filter((row) => !settled.has(row.wallet));
          if (remaining.length === 0) break;
          await sleep(Math.min(4000, 500 * 2 ** (attempt - 2)));
        }

        let blockhash;
        let lastValidBlockHeight;
        try {
          ({ blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed'));
        } catch (err) {
          lastError = err;
          continue;
        }

        let signature = null;
        try {
          const { tx } = buildBatchTx({
            vaultKeypair,
            mint,
            decimals,
            batch: remaining,
            blockhash,
            priorityFeeLamports,
          });
          signature = await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          signatures.push(signature);

          const confirmation = await rpc.confirmSignature(signature, { lastValidBlockHeight, timeoutMs: confirmTimeoutMs });
          if (confirmation.status === 'confirmed') {
            for (const row of remaining) {
              results[row.index] = {
                wallet: row.wallet,
                mint: String(mint),
                amountRaw: row.amount.toString(),
                tx: signature,
                status: 'DONE',
                error: null,
              };
            }
            remaining = [];
            break;
          }
          lastError = new DistributorError(
            confirmation.status === 'expired'
              ? `blockhash expired before ${signature.slice(0, 8)}… confirmed`
              : confirmation.status === 'failed'
                ? `transaction failed on chain: ${JSON.stringify(confirmation.err)}`
                : `confirmation timed out for ${signature.slice(0, 8)}…`,
            confirmation.status === 'expired' ? 'blockhash_expired' : confirmation.status === 'failed' ? 'tx_failed' : 'confirm_timeout',
          );
          logger?.warn?.(`distributor: ${mint} batch attempt ${attempt}/${maxAttempts}: ${lastError.message}`);
        } catch (err) {
          lastError = err;
          logger?.warn?.(`distributor: ${mint} batch attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        }
      }

      if (remaining.length > 0) {
        // One last reconciliation: a transaction can confirm after we gave up.
        const settled = await reconcile({ mint, rows: remaining, signatures, before, results, verifyBalances });
        for (const row of remaining) {
          if (settled.has(row.wallet)) continue;
          results[row.index] = {
            wallet: row.wallet,
            mint: String(mint),
            amountRaw: row.amount.toString(),
            tx: null,
            status: 'FAILED',
            error: lastError ? String(lastError.message) : 'transfer did not confirm',
          };
        }
      }

      if (onBatch) await onBatch(batch.map((row) => results[row.index]));
    }

    return results;
  }

  /**
   * Which of `rows` already have their tokens? Marks those DONE in `results`
   * and returns the set of wallets that are settled.
   */
  async function reconcile({ mint, rows, signatures, before, results, verifyBalances }) {
    const settled = new Set();

    // 1. A confirmed signature means the whole batch it carried landed.
    if (signatures.length > 0) {
      let statuses = [];
      try {
        statuses = await rpc.getSignatureStatuses(signatures, { searchTransactionHistory: true });
      } catch (err) {
        logger?.warn?.(`distributor: could not read signature statuses (${err.message}); falling back to balances`);
      }
      for (let i = 0; i < statuses.length; i++) {
        const status = statuses[i];
        if (!status || status.err) continue;
        const level = status.confirmationStatus || (status.confirmations === null ? 'finalized' : 'processed');
        if (level !== 'confirmed' && level !== 'finalized') continue;
        for (const row of rows) {
          if (settled.has(row.wallet)) continue;
          settled.add(row.wallet);
          results[row.index] = {
            wallet: row.wallet,
            mint: String(mint),
            amountRaw: row.amount.toString(),
            tx: signatures[i],
            status: 'DONE',
            error: null,
          };
        }
      }
      if (settled.size > 0) return settled;
    }

    // 2. Otherwise ask the chain about each recipient directly.
    if (!verifyBalances) return settled;
    const readings = await Promise.all(rows.map((row) => balanceOf(row.wallet, mint).catch(() => null)));
    rows.forEach((row, i) => {
      const now = readings[i];
      const was = before.get(row.wallet);
      if (now === null || now === undefined || was === null || was === undefined) return;
      if (now - was >= row.amount) {
        settled.add(row.wallet);
        results[row.index] = {
          wallet: row.wallet,
          mint: String(mint),
          amountRaw: row.amount.toString(),
          tx: signatures.length > 0 ? signatures[signatures.length - 1] : null,
          status: 'DONE',
          error: null,
        };
        logger?.info?.(`distributor: ${row.wallet.slice(0, 6)}… already holds this round's ${mint} allocation; not resending`);
      }
    });
    return settled;
  }

  return {
    ensureAndTransfer,
    measureReceived,
    balanceOf,
    assertMintIsTransferable,
    buildBatchTx,
  };
}

export default createDistributor;
