/**
 * filters/slippage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real slippage calculator using AMM formulas.
 *
 * Supported models:
 *   • Uniswap V2 (x*y=k constant product)
 *   • Uniswap V3 (sqrt price math — simplified single-tick estimate)
 *
 * Returns:
 *   {
 *     expectedOutput:   bigint  — tokens received after trade
 *     priceImpact:      number  — % price moved by our trade
 *     slippagePercent:  number  — total effective slippage %
 *     amountOutMin:     bigint  — amountOutMinimum to pass to router (with tolerance)
 *   }
 */

"use strict";

const { ethers } = require("ethers");
const config      = require("../config");

// ─── SlippageCalc ─────────────────────────────────────────────────────────────

class SlippageCalc {

  /**
   * Calculate slippage for a trade on a given pool.
   *
   * @param {object} opts
   * @param {object} opts.buyPool      - Pool cache entry (version, reserve0/1 or sqrtPriceX96)
   * @param {bigint} opts.tradeAmount  - Amount of token0 to trade (in wei)
   * @param {object} opts.pair         - { decimals0, decimals1, symbol }
   * @returns {SlippageResult}
   */
  calculate({ buyPool, tradeAmount, pair }) {
    if (buyPool.version === 2) {
      return this._calcV2(buyPool, tradeAmount, pair);
    } else {
      return this._calcV3(buyPool, tradeAmount, pair);
    }
  }

  // ── Uniswap V2 ──────────────────────────────────────────────────────────────

  /**
   * V2 constant-product formula:
   *   amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
   *
   * Price impact = (amountIn / reserveIn) × 100  [simplified]
   */
  _calcV2(pool, amountIn, pair) {
    if (!pool.reserve0 || !pool.reserve1) {
      return this._errorResult("V2 reserves not available");
    }

    const reserveIn  = pool.reserve0; // token0 is the "in" token
    const reserveOut = pool.reserve1;

    // Integer AMM math (no floating point loss)
    const amountInWithFee = amountIn * 997n;
    const numerator       = amountInWithFee * reserveOut;
    const denominator     = reserveIn * 1000n + amountInWithFee;

    if (denominator === 0n) {
      return this._errorResult("V2 zero denominator");
    }

    const expectedOutput = numerator / denominator;

    // Spot price before trade
    const spotPrice = Number(ethers.formatUnits(reserveOut, pair.decimals1))
      / Number(ethers.formatUnits(reserveIn, pair.decimals0));

    // Price received in this trade
    const amountInFloat  = Number(ethers.formatUnits(amountIn, pair.decimals0));
    const amountOutFloat = Number(ethers.formatUnits(expectedOutput, pair.decimals1));
    const execPrice      = amountOutFloat / amountInFloat;

    // Price impact = (spotPrice - execPrice) / spotPrice
    const priceImpact = Math.abs((spotPrice - execPrice) / spotPrice) * 100;

    // Total slippage = price impact + fee (0.3% for standard V2)
    const feePercent    = 0.3;
    const slippagePercent = priceImpact + feePercent;

    // amountOutMin = expectedOutput * (1 - MAX_SLIPPAGE / 100)
    const tolerance   = BigInt(Math.floor(config.MAX_SLIPPAGE * 100)); // basis points
    const amountOutMin = expectedOutput * (10000n - tolerance) / 10000n;

    return {
      expectedOutput,
      priceImpact,
      slippagePercent,
      amountOutMin,
      feePercent,
      version: 2,
      ok: slippagePercent <= config.MAX_SLIPPAGE,
    };
  }

  // ── Uniswap V3 ──────────────────────────────────────────────────────────────

  /**
   * V3 single-tick approximation.
   *
   * For small trades relative to pool liquidity the V3 price behaves
   * like a V2 pool with effective reserves derived from the sqrt price.
   *
   * effectiveReserve0 = L / sqrtP
   * effectiveReserve1 = L * sqrtP
   *
   * Then apply V2 formula as an approximation.
   */
  _calcV3(pool, amountIn, pair) {
    if (!pool.sqrtPriceX96) {
      return this._errorResult("V3 sqrtPriceX96 not available");
    }

    // Convert sqrtPriceX96 to float
    const Q96       = 2n ** 96n;
    const sqrtPrice = Number(pool.sqrtPriceX96.toString()) / Number(Q96.toString());
    if (!Number.isFinite(sqrtPrice) || sqrtPrice <= 0) {
      return this._errorResult("V3 invalid sqrtPrice");
    }

    // We need liquidity — use a safe fallback if not cached
    const liquidity = pool.liquidity ? Number(pool.liquidity.toString()) : 1e18;

    // Effective reserves
    const effectiveR0 = BigInt(Math.floor(liquidity / sqrtPrice));
    const effectiveR1 = BigInt(Math.floor(liquidity * sqrtPrice));

    if (effectiveR0 === 0n || effectiveR1 === 0n) {
      return this._errorResult("V3 effective reserves zero");
    }

    // V3 fee tiers: 0.05% (500), 0.3% (3000), 1% (10000)
    const feePpm    = pool.fee ?? 3000; // parts per million
    const feeNum    = BigInt(1_000_000 - feePpm); // e.g. 997000 for 0.3%
    const feeDen    = 1_000_000n;

    const amountInWithFee = amountIn * feeNum / feeDen;
    const numerator       = amountInWithFee * effectiveR1;
    const denominator     = effectiveR0 + amountInWithFee;

    if (denominator === 0n) {
      return this._errorResult("V3 zero denominator");
    }

    const expectedOutput = numerator / denominator;

    const spotPrice     = Number(ethers.formatUnits(effectiveR1, pair.decimals1))
      / Number(ethers.formatUnits(effectiveR0, pair.decimals0));
    const amountInFloat = Number(ethers.formatUnits(amountIn, pair.decimals0));
    const execPrice     = Number(ethers.formatUnits(expectedOutput, pair.decimals1)) / amountInFloat;
    const priceImpact   = Math.abs((spotPrice - execPrice) / spotPrice) * 100;

    const feePercent    = feePpm / 10000; // e.g. 0.3 for 3000 ppm
    const slippagePercent = priceImpact + feePercent;

    const tolerance    = BigInt(Math.floor(config.MAX_SLIPPAGE * 100));
    const amountOutMin = expectedOutput * (10000n - tolerance) / 10000n;

    return {
      expectedOutput,
      priceImpact,
      slippagePercent,
      amountOutMin,
      feePercent,
      feePpm,
      version: 3,
      ok: slippagePercent <= config.MAX_SLIPPAGE,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _errorResult(reason) {
    return {
      expectedOutput:  0n,
      priceImpact:     999,
      slippagePercent: 999,
      amountOutMin:    0n,
      feePercent:      0,
      ok:              false,
      error:           reason,
    };
  }
}

module.exports = SlippageCalc;
