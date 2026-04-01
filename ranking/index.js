/**
 * ranking/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OPPORTUNITY RANKER
 *
 * When multiple arb opportunities surface simultaneously (common at block
 * boundaries), we must execute ONLY the most profitable one to avoid:
 *   1. Competing with ourselves across multiple submissions
 *   2. Wasting gas on inferior trades
 *   3. Draining wallet balance with failed redundant TXs
 *
 * Ranking formula (composite score, higher = better):
 *
 *   score = w1 * netProfitUsd
 *         + w2 * (netProfitUsd / gasCostUsd)   // profit efficiency
 *         - w3 * slippagePercent                 // penalize high slippage
 *         + w4 * spreadBonus                     // bonus for wide spread
 *         - w5 * competitionPenalty              // penalize crowded routes
 *
 * The ranker also maintains a cooldown per route to avoid re-entering a
 * just-executed route before the on-chain state has settled.
 */

"use strict";

const logger = require("../utils/logger");

// ─── Weights ──────────────────────────────────────────────────────────────────

const W = {
  profit:      10.0,  // net profit (USD)
  efficiency:   3.0,  // profit / gas ratio
  slippage:    -5.0,  // slippage penalty
  spread:       2.0,  // spread bonus
  competition: -2.0,  // penalty if route recently failed
};

const COOLDOWN_MS = 10_000; // 10s per route after execution/failure

// ─────────────────────────────────────────────────────────────────────────────

class OpportunityRanker {
  constructor() {
    // routeId → { lastExecuted, failCount, successCount }
    this._routeHistory = new Map();

    // Lock: only one execution at a time
    this._executionLock = false;
  }

  /**
   * Score a simulation result.
   *
   * @param {object} sim        - Simulation result
   * @param {string} routeId    - Unique route identifier
   * @param {number} spread     - Price spread %
   * @returns {number} score
   */
  score(sim, routeId, spread) {
    if (!sim.isExecutable) return -Infinity;

    const hist = this._routeHistory.get(routeId) ?? { failCount: 0 };

    const profitScore    = sim.netProfitUsd * W.profit;
    const efficiencyScore = sim.gasCostUsd > 0
      ? (sim.netProfitUsd / sim.gasCostUsd) * W.efficiency
      : 0;
    const slippagePenalty = (sim.slippage?.buy?.slippagePercent ?? 0) * Math.abs(W.slippage);
    const spreadBonus      = spread * W.spread;
    const compPenalty      = hist.failCount * Math.abs(W.competition);

    const score = profitScore + efficiencyScore - slippagePenalty + spreadBonus - compPenalty;

    return score;
  }

  /**
   * Select the best opportunity from a batch of candidates.
   *
   * @param {Array<{routeId, sim, spread}>} candidates
   * @returns {object|null} best candidate or null if none viable
   */
  selectBest(candidates) {
    if (candidates.length === 0) return null;

    let best = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      // Skip routes in cooldown
      if (this._inCooldown(candidate.routeId)) {
        logger.debug(`  ⏳ Route ${candidate.routeId} in cooldown — skipping`);
        continue;
      }

      const s = this.score(candidate.sim, candidate.routeId, candidate.spread);

      logger.debug(`  📊 Route ${candidate.routeId}: score=${s.toFixed(2)} profit=$${candidate.sim.netProfitUsd?.toFixed(4)}`);

      if (s > bestScore) {
        bestScore = s;
        best      = { ...candidate, score: s };
      }
    }

    if (best) {
      logger.info(`🏆 Best opportunity: ${best.routeId} | score=${bestScore.toFixed(2)} | profit=$${best.sim.netProfitUsd?.toFixed(4)}`);
    }

    return best;
  }

  // ── Execution lock ────────────────────────────────────────────────────────────

  /**
   * Try to acquire execution lock.
   * Returns false if another execution is in progress.
   */
  tryLock() {
    if (this._executionLock) return false;
    this._executionLock = true;
    return true;
  }

  unlock() {
    this._executionLock = false;
  }

  // ── Route history ─────────────────────────────────────────────────────────────

  recordSuccess(routeId) {
    const hist = this._routeHistory.get(routeId) ?? { failCount: 0, successCount: 0 };
    hist.successCount = (hist.successCount ?? 0) + 1;
    hist.lastExecuted = Date.now();
    this._routeHistory.set(routeId, hist);
  }

  recordFailure(routeId) {
    const hist = this._routeHistory.get(routeId) ?? { failCount: 0, successCount: 0 };
    hist.failCount    = (hist.failCount ?? 0) + 1;
    hist.lastExecuted = Date.now();
    this._routeHistory.set(routeId, hist);
  }

  _inCooldown(routeId) {
    const hist = this._routeHistory.get(routeId);
    if (!hist?.lastExecuted) return false;
    return Date.now() - hist.lastExecuted < COOLDOWN_MS;
  }

  getHistory() {
    return Object.fromEntries(this._routeHistory);
  }
}

module.exports = OpportunityRanker;
