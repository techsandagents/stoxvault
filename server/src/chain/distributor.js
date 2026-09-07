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
 * The double-send guard is built on signatures, never on balances:
 *
 *   1. A batch transaction is signed BEFORE it is sent, so its signature is
 *      known before anything leaves this process. `opts.onAttempt(rows, sig)`
 *      hands that signature to the caller to persist first; only then is the
 *      transaction sent. A crash anywhere after that leaves a durable record
 *      that a send was attempted.
 *   2. On entry, any input row that already carries a signature (`attemptedTx`,
 *      from a previous run) is looked up with `searchTransactionHistory: true`.
 *      Confirmed → the row is DONE with that signature and nothing is resent.
 *      Landed-with-an-error → the tokens never moved, so it may be resent.
 *      Anything else → the fate is genuinely unknown: the row is left
 *      UNRESOLVED, carrying its signature, for an operator. It is never resent
 *      on a guess and never reported as paid on a guess.
 *   3. Inside an invocation the same rule applies per attempt: a row is marked
 *      DONE only by a signature that (a) was confirmed and (b) actually carried
 *      that row's transfer. A retry happens only when every attempt containing
 *      the row is provably dead — the transaction failed on chain, or its
 *      blockhash expired and the cluster has no record of it in history.
 *
 * A rising balance is NOT proof of payment — the recipient may simply have
 * bought the same stock — so it can never mark a row DONE, and a signature that
 * was not confirmed is never written to a row's `tx`. The public ledger only
 * ever carries explorer links that resolve.
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

import { b58decode, b58encode } from './vault.js';

export const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();

/**
 * A transfer whose fate we could not establish. Not paid, not failed: it has a
 * signature that the cluster neither confirmed nor ruled out. It is never
 * resent automatically and never published as paid.
 */
export const UNRESOLVED = 'UNRESOLVED';

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

  /* ------------------------------------------------- signatures & verdicts */

  /**
   * The signature of an already-signed transaction, exactly as the cluster will
   * know it. Available before the transaction is sent, which is what makes the
   * attempt recordable in advance.
   */
  function signatureOf(tx) {
    const raw = tx?.signatures?.[0];
    if (!raw || raw.length !== 64 || raw.every((byte) => byte === 0)) {
      throw new DistributorError('refusing to send an unsigned transaction', 'unsigned_transaction');
    }
    return b58encode(raw);
  }

  /** 64 base58 bytes: the shape of every signature this module ever records. */
  function looksLikeSignature(value) {
    if (typeof value !== 'string' || value.length < 64 || value.length > 90) return false;
    try {
      return b58decode(value).length === 64;
    } catch {
      return false;
    }
  }

  /** Signatures a caller-supplied row already carries from an earlier run. */
  function priorSignatures(transfer) {
    const out = [];
    const push = (value) => {
      if (Array.isArray(value)) value.forEach(push);
      else if (typeof value !== 'string' || value.trim() === '') return;
      else if (looksLikeSignature(value.trim())) out.push(value.trim());
      else logger?.warn?.(`distributor: ignoring ${JSON.stringify(value)} on ${transfer?.wallet}: not a transaction signature`);
    };
    push(transfer?.attemptedTx);
    push(transfer?.attemptedTxs);
    push(transfer?.attemptedSignature);
    push(transfer?.tx);
    return [...new Set(out)];
  }

  /**
   * Ask the cluster what became of every attempt whose fate is still open, and
   * move each one to a verdict:
   *   confirmed — it landed successfully; everyone it carried has been paid.
   *   dead      — it landed with an error, or its blockhash expired and the
   *               ledger (searchTransactionHistory) has no record of it, so it
   *               can never land. Safe to rebuild and send again.
   *   unknown   — anything else. Never resend, never claim it was paid.
   */
  async function refreshAttempts(attempts) {
    const open = attempts.filter((a) => a.outcome !== 'confirmed' && a.outcome !== 'dead');
    if (open.length === 0) return;
    let statuses = null;
    try {
      statuses = await rpc.getSignatureStatuses(open.map((a) => a.signature), { searchTransactionHistory: true });
    } catch (err) {
      // We asked and were not told. That is not evidence of anything, so every
      // open attempt stays open and its rows stay unresolved.
      logger?.warn?.(`distributor: could not read signature statuses (${err.message}); leaving attempts unresolved`);
      return;
    }
    open.forEach((attempt, i) => {
      const status = Array.isArray(statuses) ? statuses[i] ?? null : null;
      if (!status) {
        // Not in the ledger. Only meaningful once the blockhash is spent: then
        // the transaction can never land.
        if (attempt.outcome === 'expired') attempt.outcome = 'dead';
        return;
      }
      if (status.err) {
        attempt.outcome = 'dead';
        return;
      }
      const level = status.confirmationStatus || (status.confirmations === null ? 'finalized' : 'processed');
      if (level === 'confirmed' || level === 'finalized') attempt.outcome = 'confirmed';
      // 'processed' can still be dropped by the cluster: not a confirmation.
    });
  }

  /**
   * What do the attempts prove about one wallet?
   * @returns {{state: 'DONE'|'UNRESOLVED'|'OPEN', signature: string|null}}
   */
  function classifyRow(wallet, attempts) {
    let blocking = null;
    let confirmedCount = 0;
    let confirmed = null;
    for (const attempt of attempts) {
      if (!attempt.wallets.has(wallet)) continue;
      if (attempt.outcome === 'confirmed') {
        confirmedCount += 1;
        if (!confirmed) confirmed = attempt;
        continue;
      }
      if (attempt.outcome !== 'dead' && !blocking) blocking = attempt;
    }
    if (confirmed) {
      if (confirmedCount > 1) {
        logger?.warn?.(`distributor: ${wallet.slice(0, 6)}… appears in ${confirmedCount} confirmed transactions for this batch`);
      }
      return { state: 'DONE', signature: confirmed.signature };
    }
    if (blocking) return { state: 'UNRESOLVED', signature: blocking.signature };
    return { state: 'OPEN', signature: null };
  }

  function markDone(results, row, mint, signature) {
    results[row.index] = {
      ...results[row.index],
      wallet: row.wallet,
      mint: String(mint),
      amountRaw: row.amount.toString(),
      tx: signature,
      status: 'DONE',
      error: null,
    };
  }

  /**
   * A balance reading, used only to describe an unresolved row to an operator.
   * It is deliberately never an input to any DONE / resend decision: a holder
   * who bought the same stock on Jupiter during the window looks identical to a
   * holder we paid.
   */
  async function balanceNote(row, mint, before) {
    if (!before || !before.has(row.wallet)) return '';
    const was = before.get(row.wallet);
    if (was === null || was === undefined) return '';
    let now = null;
    try {
      now = await balanceOf(row.wallet, mint);
    } catch {
      return '';
    }
    if (now === null || now === undefined) return '';
    const delta = now - was;
    if (delta <= 0n) return ' recipient balance is unchanged since the attempt.';
    return ` recipient balance rose by ${delta} base units since the attempt, which is not proof of payment.`;
  }

  async function markUnresolved(results, row, mint, signature, before, prefix) {
    const note = await balanceNote(row, mint, before);
    results[row.index] = {
      ...results[row.index],
      wallet: row.wallet,
      mint: String(mint),
      amountRaw: row.amount.toString(),
      tx: null,
      attemptedTx: signature,
      status: UNRESOLVED,
      error: `${prefix} signature ${signature} was neither confirmed nor ruled out; not resending.${note} An operator must check it before this row is retried.`,
    };
    logger?.warn?.(`distributor: ${mint} transfer to ${row.wallet.slice(0, 6)}… is UNRESOLVED behind ${signature}`);
  }

  /**
   * Apply the attempts to `rows`: mark what is settled, and return the rows
   * that are still open (every attempt containing them is provably dead, so
   * rebuilding and sending again cannot double-pay).
   */
  async function settle({ mint, rows, attempts, results, before, prefix = 'unresolved:' }) {
    const open = [];
    for (const row of rows) {
      const verdict = classifyRow(row.wallet, attempts);
      if (verdict.state === 'DONE') {
        markDone(results, row, mint, verdict.signature);
        continue;
      }
      if (verdict.state === 'UNRESOLVED') {
        await markUnresolved(results, row, mint, verdict.signature, before, prefix);
        continue;
      }
      open.push(row);
    }
    return open;
  }

  /* ----------------------------------------------------------- the sender */

  /**
   * ensureAndTransfer(vaultKeypair, mint, decimals, transfers, opts)
   *
   * @param {import('@solana/web3.js').Keypair} vaultKeypair
   * @param {string} mint
   * @param {number} decimals
   * @param {{wallet: string, amountRaw: string|bigint, symbol?: string, attemptedTx?: string|string[]}[]} transfers
   *   `attemptedTx` is the signature a previous run recorded through `onAttempt`
   *   before sending. Pass it back and a restart can never double-send.
   * @param {{
   *   batchSize?: number, priorityFeeLamports?: number, maxAttempts?: number,
   *   confirmTimeoutMs?: number, verifyBalances?: boolean,
   *   onAttempt?: (rows: object[], signature: string) => any|Promise<any>,
   *   onBatch?: (results: object[]) => any|Promise<any>
   * }} [opts]
   *   `onAttempt` MUST persist the signature it is given against those rows. It
   *   is awaited before the transaction is sent, and a rejection cancels the
   *   send: an unrecorded transaction is worse than an unsent one.
   * @returns {Promise<{wallet, mint, amountRaw, tx, attemptedTx, status, error}[]>} one row per input transfer
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
    const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
    const vaultAddress = vaultKeypair.publicKey.toBase58();

    if (!onAttempt) {
      logger?.warn?.(
        'distributor: no onAttempt callback — signatures cannot be recorded before sending, so a crash between send and persistence leaves this batch unresolvable',
      );
    }

    const results = [];
    let sendable = [];

    for (const transfer of Array.isArray(transfers) ? transfers : []) {
      const wallet = transfer?.wallet;
      const base = { wallet: String(wallet ?? ''), mint: String(mint), amountRaw: '0', tx: null, attemptedTx: null, status: 'FAILED', error: null };
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
      const prior = priorSignatures(transfer);
      sendable.push({ wallet, owner, amount, index: results.length, prior });
      results.push({ ...base, status: 'PENDING', attemptedTx: prior.length > 0 ? prior[prior.length - 1] : null });
    }

    if (sendable.length === 0) {
      if (onBatch) await onBatch(results.slice());
      return results;
    }

    /* ------------------------------------------------ what a previous run did */

    // Rows that already carry a signature are settled against that signature —
    // never against a balance delta, which cannot tell our payment apart from
    // the recipient buying the same stock.
    const priorAttempts = new Map();
    for (const row of sendable) {
      for (const signature of row.prior) {
        if (!priorAttempts.has(signature)) priorAttempts.set(signature, { signature, wallets: new Set(), outcome: 'unknown' });
        priorAttempts.get(signature).wallets.add(row.wallet);
      }
    }
    if (priorAttempts.size > 0) {
      const attempts = [...priorAttempts.values()];
      await refreshAttempts(attempts);
      const carried = sendable.filter((row) => row.prior.length > 0);
      const stillOpen = await settle({
        mint,
        rows: carried,
        attempts,
        results,
        before: null,
        prefix: 'unresolved: a previous run attempted this transfer and',
      });
      const openIndexes = new Set(stillOpen.map((row) => row.index));
      const resolved = carried.filter((row) => !openIndexes.has(row.index));
      sendable = sendable.filter((row) => row.prior.length === 0 || openIndexes.has(row.index));
      if (resolved.length > 0 && onBatch) await onBatch(resolved.map((row) => results[row.index]));
      if (sendable.length === 0) return results;
    }

    await assertMintIsTransferable(mint, decimals);

    for (const batch of chunk(sendable, batchSize)) {
      /** wallet -> balance before we sent anything. Operator context only. */
      const before = new Map();
      if (verifyBalances) {
        const readings = await Promise.all(batch.map((row) => balanceOf(row.wallet, mint).catch(() => null)));
        batch.forEach((row, i) => before.set(row.wallet, readings[i]));
      }

      let remaining = batch.slice();
      /** @type {{signature: string, wallets: Set<string>, outcome: string}[]} */
      const attempts = [];
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts && remaining.length > 0; attempt++) {
        if (attempt > 1) {
          // Establish the truth before doing anything again. Only rows whose
          // every attempt is provably dead come back open.
          await refreshAttempts(attempts);
          remaining = await settle({ mint, rows: remaining, attempts, results, before });
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

        /** The attempt we are about to make, recorded before it can happen. */
        let record = null;
        try {
          const { tx } = buildBatchTx({
            vaultKeypair,
            mint,
            decimals,
            batch: remaining,
            blockhash,
            priorityFeeLamports,
          });
          // The signature exists as soon as the transaction is signed. Persist
          // it first: after this line a send may land without us seeing it, and
          // the only thing that makes that recoverable is a stored signature.
          const signature = signatureOf(tx);
          if (onAttempt) {
            await onAttempt(
              remaining.map((row) => ({
                wallet: row.wallet,
                mint: String(mint),
                amountRaw: row.amount.toString(),
                attemptedTx: signature,
                status: 'PENDING',
              })),
              signature,
            );
          }
          record = { signature, wallets: new Set(remaining.map((row) => row.wallet)), outcome: 'unknown' };
          attempts.push(record);
          for (const row of remaining) results[row.index].attemptedTx = signature;

          const returned = await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          if (typeof returned === 'string' && returned !== '' && returned !== signature) {
            // Should not happen: the signature is a property of the bytes. If a
            // node ever disagrees, track both rather than lose one.
            logger?.warn?.(`distributor: node returned ${returned} for a transaction signed as ${signature}`);
            attempts.push({ signature: returned, wallets: new Set(record.wallets), outcome: 'unknown' });
          }
        } catch (err) {
          lastError = err;
          if (!record) {
            // Nothing was signed, recorded or sent — nothing can have landed.
            logger?.warn?.(`distributor: ${mint} batch attempt ${attempt}/${maxAttempts} was not sent: ${err.message}`);
            continue;
          }
          logger?.warn?.(
            `distributor: ${mint} batch attempt ${attempt}/${maxAttempts} failed after signing (${err.message}); ${record.signature} may still land`,
          );
        }

        try {
          const confirmation = await rpc.confirmSignature(record.signature, { lastValidBlockHeight, timeoutMs: confirmTimeoutMs });
          if (confirmation.status === 'confirmed') {
            record.outcome = 'confirmed';
            remaining = await settle({ mint, rows: remaining, attempts, results, before });
            break;
          }
          if (confirmation.status === 'failed') {
            // It landed and reverted: no tokens moved, so a retry is safe.
            record.outcome = 'dead';
            lastError = new DistributorError(`transaction failed on chain: ${JSON.stringify(confirmation.err)}`, 'tx_failed');
          } else if (confirmation.status === 'expired') {
            // Cannot land any more once the ledger agrees it is not there.
            record.outcome = 'expired';
            lastError = new DistributorError(`blockhash expired before ${record.signature.slice(0, 8)}… confirmed`, 'blockhash_expired');
          } else {
            record.outcome = 'unknown';
            lastError = new DistributorError(`confirmation timed out for ${record.signature.slice(0, 8)}…`, 'confirm_timeout');
          }
          logger?.warn?.(`distributor: ${mint} batch attempt ${attempt}/${maxAttempts}: ${lastError.message}`);
        } catch (err) {
          lastError = err;
          record.outcome = 'unknown';
          logger?.warn?.(`distributor: ${mint} batch attempt ${attempt}/${maxAttempts}: could not confirm ${record.signature.slice(0, 8)}… (${err.message})`);
        }
      }

      if (remaining.length > 0) {
        // One last reconciliation: a transaction can confirm after we gave up.
        await refreshAttempts(attempts);
        remaining = await settle({ mint, rows: remaining, attempts, results, before });
        for (const row of remaining) {
          // Every attempt that carried this row is provably dead, so nothing is
          // in flight and no signature belongs on the row.
          results[row.index] = {
            ...results[row.index],
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

  return {
    ensureAndTransfer,
    measureReceived,
    balanceOf,
    assertMintIsTransferable,
    buildBatchTx,
  };
}

export default createDistributor;
