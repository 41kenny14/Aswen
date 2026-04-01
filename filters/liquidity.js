/**
 * filters/liquidity.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Liquidity quality filter.
 *
 * Before evaluating an arb opportunity:
 *   1. Confirm buy-side pool has enough reserves
 *   2. Confirm sell-side pool has enough reserves
 *   3. Reject if trade size would cause > MAX_PRICE_IMPACT on either pool
 */

"use strict";

const { ethers } = require("ethers");
const config      = require("../config");
const logger      = require("../utils/logger");

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

const V3_POOL_ABI = [
  "function liquidity() external view returns (uint128)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

// ─── Constants ────────────────────────────────────────────────────────────────

// Maximum price impact allowed on a single pool (2 %)
const MAX_PRICE_IMPACT_PERCENT = 2.0;

// ─── LiquidityFilter ──────────────────────────────────────────────────────────

class LiquidityFilter {
  constructor(provider) {
    this.provider = provider;
  }

  /**
   * Run liquidity checks on both pools for a given trade.
   *
   * @param {object} opts
   * @param {object} opts.buyPool      - Cache entry for the pool we buy from
   * @param {object} opts.sellPool     - Cache entry for the pool we sell into
   * @param {object} opts.pair         - Token pair descriptor
   * @param {bigint} opts.tradeAmount  - Flash loan amount in token wei
   * @returns {{ ok: boolean, reason: string, liquidity: object }}
   */
  async check({ buyPool, sellPool, pair, tradeAmount }) {
    // Convert tradeAmount to float for math
    const tradeFloat = parseFloat(ethers.formatUnits(tradeAmount, pair.decimals0));

    // ── Buy pool check ────────────────────────────────────────────────────────
    const buyLiqResult = await this._checkPool(buyPool, pair, tradeFloat, "buy");
    if (!buyLiqResult.ok) {
      return buyLiqResult;
    }

    // ── Sell pool check ───────────────────────────────────────────────────────
    const sellLiqResult = await this._checkPool(sellPool, pair, tradeFloat, "sell");
    if (!sellLiqResult.ok) {
      return sellLiqResult;
    }

    logger.debug(`  ✅ Liquidity OK — buy: $${buyLiqResult.liquidityUsd.toFixed(0)} | sell: $${sellLiqResult.liquidityUsd.toFixed(0)}`);

    return {
      ok: true,
      reason: "liquidity sufficient",
      buy:  buyLiqResult,
      sell: sellLiqResult,
    };
  }

  /**
   * Check a single pool's liquidity relative to the trade size.
   */
  async _checkPool(pool, pair, tradeFloat, side) {
    try {
      let liquidityUsd = 0;
      let priceImpact  = 0;

      if (pool.version === 2) {
        // ── V2: use reserve data (already cached) ────────────────────────────

        if (!pool.reserve0 || !pool.reserve1) {
          // Fresh fetch if not in cache
          const contract = new ethers.Contract(pool.address, V2_PAIR_ABI, this.provider);
          const [r0, r1] = await contract.getReserves();
          pool.reserve0 = r0;
          pool.reserve1 = r1;
        }

        const r0f = parseFloat(ethers.formatUnits(pool.reserve0, pair.decimals0));
        const r1f = parseFloat(ethers.formatUnits(pool.reserve1, pair.decimals1));

        // Total liquidity in base token terms (reserve0 value)
        liquidityUsd = r0f * 2 * pool.price; // rough USD equiv via price

        // Threshold: absolute reserve0 must exceed MIN_LIQUIDITY_THRESHOLD
        if (r0f < config.MIN_LIQUIDITY_THRESHOLD) {
          return {
            ok: false,
            reason: `${side} pool reserve0 ${r0f.toFixed(2)} < MIN ${config.MIN_LIQUIDITY_THRESHOLD}`,
          };
        }

        // Price impact from AMM math: k = r0 * r1
        // new_r0 = r0 + tradeIn  →  new_r1 = k / new_r0
        // price_impact = (r0 / new_r0) - 1
        const newR0 = r0f + tradeFloat;
        priceImpact = Math.abs((r0f / newR0) - 1) * 100;

      } else {
        // ── V3: use sqrtPriceX96 + liquidity ────────────────────────────────
        // Simplified: treat concentrated liquidity as ~50% effective vs V2
        // Full tick math is complex; we use a conservative heuristic here.

        if (!pool.sqrtPriceX96) {
          const contract = new ethers.Contract(pool.address, V3_POOL_ABI, this.provider);
          const [sqrtPriceX96] = await contract.slot0();
          pool.sqrtPriceX96 = sqrtPriceX96;
        }

        // For V3, price impact is approximated as: tradeSize / (virtualLiquidity)
        // Virtual liquidity in token0 terms: L / sqrtPrice
        // We use a conservative 2× multiplier vs V2 for safety
        const sqrtPrice = parseFloat(pool.sqrtPriceX96.toString()) / (2 ** 96);
        const virtualR0 = sqrtPrice > 0 ? (parseFloat(pool.liquidity || 0) / sqrtPrice) * 0.5 : 0;

        liquidityUsd = virtualR0 * pool.price;

        if (virtualR0 < config.MIN_LIQUIDITY_THRESHOLD) {
          return {
            ok: false,
            reason: `${side} V3 pool virtual liquidity ${virtualR0.toFixed(2)} < MIN ${config.MIN_LIQUIDITY_THRESHOLD}`,
          };
        }

        priceImpact = virtualR0 > 0 ? (tradeFloat / virtualR0) * 100 : 999;
      }

      // ── Price impact check ────────────────────────────────────────────────
      if (priceImpact > MAX_PRICE_IMPACT_PERCENT) {
        return {
          ok: false,
          reason: `${side} price impact ${priceImpact.toFixed(2)}% > max ${MAX_PRICE_IMPACT_PERCENT}%`,
        };
      }

      return { ok: true, liquidityUsd, priceImpact, reason: "ok" };

    } catch (err) {
      return { ok: false, reason: `${side} liquidity check error: ${err.message}` };
    }
  }
}

module.exports = LiquidityFilter;
