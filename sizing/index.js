/**
 * sizing/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * DYNAMIC TRADE SIZE OPTIMIZER
 *
 * Problem: The optimal borrow amount is NOT always the maximum configured.
 *   - Too small → insufficient profit after gas + flash loan fee
 *   - Too large → price impact destroys the spread
 *
 * Solution: Binary search + golden section search over the profit function.
 *
 * Math:
 *   netProfit(x) = sellOutput(buyOutput(x)) - x - flashFee(x) - gasCost
 *
 *   where:
 *     buyOutput(x)  = V2/V3 AMM formula for buying x token0
 *     sellOutput(y) = V2/V3 AMM formula for selling y token1
 *     flashFee(x)   = x * 5 / 10000  (Aave 0.05%)
 *
 * This is a unimodal concave function (price impact increases monotonically),
 * so golden section search converges in O(log n) iterations.
 *
 * Returns:
 *   { optimalAmount, optimalProfit, candidates }
 */

"use strict";

const { ethers } = require("ethers");
const config      = require("../config");

// ─── Constants ────────────────────────────────────────────────────────────────

const AAVE_FEE_BPS    = 5n;               // 0.05%
const GOLDEN_RATIO    = 0.618033988749895;
const SEARCH_ITERS    = 12;               // convergence iterations (fast)
const CANDIDATE_STEPS = 8;               // coarse grid search first

// ─────────────────────────────────────────────────────────────────────────────

class TradeSizer {

  /**
   * Find the optimal trade size for a given arb route.
   *
   * @param {object} opts
   * @param {object} opts.buyPool      - Pool to buy on
   * @param {object} opts.sellPool     - Pool to sell on
   * @param {object} opts.pair         - Token pair metadata
   * @param {bigint} opts.gasCostWei   - Estimated gas cost (ETH wei)
   * @param {number} opts.ethPriceUsd  - ETH price in USD
   * @returns {{ optimalAmount: bigint, optimalProfit: bigint, candidates: Array }}
   */
  optimize({ buyPool, sellPool, pair, gasCostWei, ethPriceUsd }) {
    const minAmount = this._parseMin(pair);
    const maxAmount = config.FLASH_LOAN_AMOUNT;

    if (minAmount >= maxAmount) {
      return { optimalAmount: maxAmount, optimalProfit: 0n, candidates: [] };
    }

    // Gas cost in token0 terms
    const gasCostToken0 = this._gasToToken0(gasCostWei, ethPriceUsd, pair.decimals0);

    // Profit function (pure — evaluates without side effects)
    const profit = (amount) => this._netProfit(amount, buyPool, sellPool, pair, gasCostToken0);

    // ── Phase 1: coarse grid to find promising region ─────────────────────────
    const candidates = [];
    const step = (maxAmount - minAmount) / BigInt(CANDIDATE_STEPS);

    for (let i = 0; i <= CANDIDATE_STEPS; i++) {
      const amount = minAmount + step * BigInt(i);
      const p      = profit(amount);
      candidates.push({ amount, profit: p });
    }

    // Sort to find best candidate
    candidates.sort((a, b) => (a.profit < b.profit ? 1 : -1));
    const bestCandidate = candidates[0];

    if (bestCandidate.profit <= 0n) {
      // No profitable size found
      return { optimalAmount: 0n, optimalProfit: 0n, candidates };
    }

    // ── Phase 2: golden section search around best candidate ──────────────────
    // Search window: ±2 steps around the best candidate
    let lo = bestCandidate.amount - step * 2n;
    let hi = bestCandidate.amount + step * 2n;
    if (lo < minAmount) lo = minAmount;
    if (hi > maxAmount) hi = maxAmount;

    const { amount: optimalAmount, profit: optimalProfit } = this._goldenSearch(profit, lo, hi);

    return {
      optimalAmount:  optimalProfit > 0n ? optimalAmount : 0n,
      optimalProfit:  optimalProfit > 0n ? optimalProfit : 0n,
      candidates,
    };
  }

  // ── Net profit function (hot — called O(CANDIDATE_STEPS + SEARCH_ITERS) times) ──

  _netProfit(amount, buyPool, sellPool, pair, gasCostToken0) {
    if (amount <= 0n) return -1n;

    // Buy side: token0 → token1
    const token1Received = buyPool.version === 2
      ? this._v2Out(amount, buyPool.reserve0, buyPool.reserve1)
      : this._v3Out(amount, buyPool.sqrtPriceX96, buyPool.liquidity ?? 0n, buyPool.fee ?? 3000);

    if (token1Received <= 0n) return -1n;

    // Sell side: token1 → token0 (reserves flipped)
    const token0Received = sellPool.version === 2
      ? this._v2Out(token1Received, sellPool.reserve1, sellPool.reserve0)
      : this._v3Out(token1Received, sellPool.sqrtPriceX96, sellPool.liquidity ?? 0n, sellPool.fee ?? 3000, true);

    if (token0Received <= 0n) return -1n;

    // Deductions
    const flashFee  = amount * AAVE_FEE_BPS / 10000n;
    const totalDebt = amount + flashFee;

    if (token0Received <= totalDebt + gasCostToken0) return -1n;

    return token0Received - totalDebt - gasCostToken0;
  }

  // ── AMM output formulas ───────────────────────────────────────────────────────

  /**
   * Uniswap V2: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
   */
  _v2Out(amountIn, reserveIn, reserveOut) {
    if (reserveIn === 0n || reserveOut === 0n) return 0n;
    const fee     = amountIn * 997n;
    const num     = fee * reserveOut;
    const den     = reserveIn * 1000n + fee;
    return den > 0n ? num / den : 0n;
  }

  /**
   * Uniswap V3: single-tick approximation using effective reserves derived from sqrtPrice + liquidity.
   * @param {boolean} inverted - if true, treat token1 as input (sell side)
   */
  _v3Out(amountIn, sqrtPriceX96, liquidity, feePpm, inverted = false) {
    if (!sqrtPriceX96 || sqrtPriceX96 === 0n || liquidity === 0n) return 0n;

    const Q = 2n ** 96n;
    const sqP  = sqrtPriceX96;

    // effectiveR0 = L / sqrtP,   effectiveR1 = L * sqrtP / Q96
    const effR0 = (liquidity * Q) / sqP;
    const effR1 = (liquidity * sqP) / Q;

    const [rIn, rOut] = inverted ? [effR1, effR0] : [effR0, effR1];

    if (rIn === 0n || rOut === 0n) return 0n;

    const feeNum = BigInt(1_000_000 - feePpm);
    const inFee  = (amountIn * feeNum) / 1_000_000n;
    const num    = inFee * rOut;
    const den    = rIn + inFee;
    return den > 0n ? num / den : 0n;
  }

  // ── Golden section search ──────────────────────────────────────────────────────

  _goldenSearch(f, lo, hi) {
    let a = lo, b = hi;
    let c = b - BigInt(Math.floor(Number(b - a) * GOLDEN_RATIO));
    let d = a + BigInt(Math.floor(Number(b - a) * GOLDEN_RATIO));
    let fc = f(c), fd = f(d);

    for (let i = 0; i < SEARCH_ITERS; i++) {
      if (fc < fd) {
        a = c; c = d; fc = fd;
        d = a + BigInt(Math.floor(Number(b - a) * GOLDEN_RATIO));
        fd = f(d);
      } else {
        b = d; d = c; fd = fc;
        c = b - BigInt(Math.floor(Number(b - a) * GOLDEN_RATIO));
        fc = f(c);
      }
    }

    const mid = (a + b) / 2n;
    return { amount: mid, profit: f(mid) };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────

  _parseMin(pair) {
    // Minimum trade = 100 token0 units
    return ethers.parseUnits("100", pair.decimals0);
  }

  _gasToToken0(gasCostWei, ethPriceUsd, decimals0) {
    const gasUsd  = parseFloat(ethers.formatEther(gasCostWei)) * ethPriceUsd;
    // Assumes token0 ≈ USD stablecoin (USDC). For non-stable pairs, use oracle.
    return ethers.parseUnits(gasUsd.toFixed(6), decimals0);
  }
}

module.exports = TradeSizer;
