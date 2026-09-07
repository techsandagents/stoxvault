/**
 * STOCKDROP engine — the whole round math, pure and reproducible.
 *
 * Nothing in here touches the network, the clock, the filesystem or randomness.
 * Give it the same inputs and it gives the same lamports, forever. That is the
 * property that lets anyone re-derive a published round from its document.
 */

export {
  rankUniverse,
  normalizeUniverse,
  topStocks,
  mcapOf,
  liquidityOf,
  toFiniteNumber,
  cmpStr,
} from './ranking.js';

export {
  PickError,
  DEFAULT_RULES,
  validatePicks,
  defaultPicks,
  comparePicks,
} from './validate.js';

export {
  toBigInt,
  toNonNegativeBigInt,
  eligibleThreshold,
  computeEligible,
  respreadPicks,
  effectiveBasket,
  computeDemand,
  splitPool,
  allocate,
} from './allocate.js';

export {
  canonicalSnapshot,
  snapshotHash,
  buildRoundPlan,
  applySwapResults,
} from './round.js';
