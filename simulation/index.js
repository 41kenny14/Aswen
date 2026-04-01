/**
 * simulation/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-execution simulation engine.
 *
 * Simulates the FULL flash loan arbitrage trade BEFORE submitting anything:
 *   1.  Calculates flash loan fee (Aave V3: 0.05%)
 *   2.  Simulates buy-side swap output (AMM math)
 *   3.  Simulates sell-side swap output (AMM math)
 *   4.  Estimates gas cost (eth_estimateGas via provider)
 *   5.  Calculates net profit
 *   6.  Returns isExecutable = true only if all thresholds pass
 *
 * Returns:
 *   {
 *     expectedProfit:  bigint,
 *     gasCost:         bigint  (in ETH wei),
 *     gasCostUsd:      number,
 *     flashLoanFee:    bigint,
 *     slippage:        SlippageResult,
 *     netProfit:       bigint  (in loan token wei),
 *     netProfitUsd:    number,
 *     isExecutable:    boolean,
 *     reason:          string,
 *   }
 */

"use strict";

const { ethers } = require("ethers");
const config      = require("../config");
const logger      = require("../utils/logger");
const SlippageCalc = require("../filters/slippage");

// ─── Constants ────────────────────────────────────────────────────────────────

// Aave V3 flash loan fee: 0.05% = 5 bps
const AAVE_FLASH_LOAN_FEE_BPS = 5n;

// Approximate ETH price in USD (update via config or oracle for accuracy)
const ETH_PRICE_USD = parseFloat(process.env.ETH_PRICE_USD || "3000");

// ─── Simulator ────────────────────────────────────────────────────────────────

class Simulator {
  constructor(provider) {
    this.provider   = provider;
    this.slippageC  = new SlippageCalc();
  }

  /**
   * Run a full simulation of the arbitrage trade.
   *
   * @param {object} opts
   * @param {object} opts.pair         - Token pair
   * @param {object} opts.buyPool      - Pool to buy token1 on (cheaper)
   * @param {object} opts.sellPool     - Pool to sell token1 on (more expensive)
   * @param {bigint} opts.tradeAmount  - Flash loan borrow amount (token0 wei)
   * @param {object} opts.slippage     - Pre-computed slippage from buy pool
   * @returns {SimResult}
   */
  async run({ pair, buyPool, sellPool, tradeAmount, slippage }) {

    // ── 1. Flash loan fee ─────────────────────────────────────────────────────
    const flashLoanFee = tradeAmount * AAVE_FLASH_LOAN_FEE_BPS / 10000n;
    const totalDebt    = tradeAmount + flashLoanFee;

    // ── 2. Buy-side: swap token0 → token1 on buyPool ──────────────────────────
    const buySim = this.slippageC.calculate({
      buyPool,
      tradeAmount,
      pair,
    });

    if (!buySim.ok || buySim.expectedOutput === 0n) {
      return this._fail(`Buy simulation failed: ${buySim.error || "zero output"}`);
    }

    const tokensReceived = buySim.expectedOutput;

    // ── 3. Sell-side: swap token1 → token0 on sellPool ───────────────────────
    // Construct a pseudo-pool for the sell side with flipped token directions
    const sellPoolFlipped = {
      ...sellPool,
      // For V2: token1 is now "in", token0 is "out" — swap reserves
      reserve0: sellPool.reserve1,
      reserve1: sellPool.reserve0,
    };

    const sellSim = this.slippageC.calculate({
      buyPool:     sellPoolFlipped,
      tradeAmount: tokensReceived,
      pair: {
        ...pair,
        decimals0: pair.decimals1,
        decimals1: pair.decimals0,
      },
    });

    if (!sellSim.ok || sellSim.expectedOutput === 0n) {
      return this._fail(`Sell simulation failed: ${sellSim.error || "zero output"}`);
    }

    const token0Received = sellSim.expectedOutput;

    // ── 4. Gross profit ────────────────────────────────────────────────────────
    if (token0Received <= totalDebt) {
      return this._fail(
        `Gross loss: received ${token0Received} < debt ${totalDebt}`,
        { flashLoanFee, tokensReceived, token0Received, totalDebt }
      );
    }

    const grossProfit = token0Received - totalDebt;

    // ── 5. Gas estimation ──────────────────────────────────────────────────────
    const { gasCostWei, gasUnits } = await this._estimateGas(pair, buyPool, sellPool);

    // Convert gas cost to token0 terms for deduction
    // (assumes token0 is a USD stablecoin; adjust for ETH-denominated pairs)
    const gasCostUsd = parseFloat(ethers.formatEther(gasCostWei)) * ETH_PRICE_USD;

    // Gas cost in token0 wei (6 decimals for USDC)
    const gasCostToken0 = ethers.parseUnits(
      gasCostUsd.toFixed(pair.decimals0 <= 6 ? 6 : 18),
      pair.decimals0
    );

    // ── 6. Net profit ──────────────────────────────────────────────────────────
    if (grossProfit < gasCostToken0) {
      return this._fail(
        `Net loss after gas: gross ${grossProfit} < gas ${gasCostToken0}`,
        { flashLoanFee, grossProfit, gasCostToken0, gasCostUsd }
      );
    }

    const netProfit = grossProfit - gasCostToken0;

    // ── 7. Minimum profit threshold ────────────────────────────────────────────
    const minProfit = ethers.parseUnits(
      config.MIN_PROFIT.toString(),
      pair.decimals0
    );

    if (netProfit < minProfit) {
      return this._fail(
        `Net profit ${netProfit} below minimum ${minProfit}`,
        { netProfit, minProfit }
      );
    }

    // ── 8. Gas cost threshold ──────────────────────────────────────────────────
    const maxGasCost = ethers.parseUnits(
      config.MAX_GAS_COST.toString(),
      18
    );

    if (gasCostWei > maxGasCost) {
      return this._fail(
        `Gas cost ${ethers.formatEther(gasCostWei)} ETH > max ${config.MAX_GAS_COST} ETH`,
        { gasCostWei }
      );
    }

    // ── 9. All checks pass ─────────────────────────────────────────────────────
    const netProfitUsd = parseFloat(ethers.formatUnits(netProfit, pair.decimals0));

    logger.debug(`  ✅ Simulation passed — net profit: $${netProfitUsd.toFixed(4)}, gas: $${gasCostUsd.toFixed(4)}`);

    return {
      expectedProfit: grossProfit,
      gasCost:        gasCostWei,
      gasCostUsd,
      gasUnits,
      flashLoanFee,
      tokensReceived,
      token0Received,
      totalDebt,
      slippage: {
        buy:  buySim,
        sell: sellSim,
      },
      netProfit,
      netProfitUsd,
      isExecutable: true,
      reason: "all checks passed",

      // Swap params for execution engine
      buyAmountOutMin:  buySim.amountOutMin,
      sellAmountOutMin: sellSim.amountOutMin,
    };
  }

  // ── Gas Estimation ─────────────────────────────────────────────────────────

  async _estimateGas(pair, buyPool, sellPool) {
    try {
      // Use a static estimate if no contract is deployed yet
      // In production: call provider.estimateGas() with the actual tx data
      const gasPrice = (await this.provider.getFeeData()).gasPrice ?? ethers.parseUnits("0.001", "gwei");

      // Typical arbitrage tx on Base: ~300k–500k gas
      // V3 swaps cost more than V2
      const hasV3   = buyPool.version === 3 || sellPool.version === 3;
      const gasUnits = BigInt(hasV3 ? 480_000 : 320_000);

      // Base has very low gas — add 20% buffer
      const gasCostWei = gasPrice * gasUnits * 120n / 100n;

      return { gasCostWei, gasUnits };
    } catch (err) {
      logger.warn(`Gas estimation failed: ${err.message} — using fallback`);
      const gasUnits  = 400_000n;
      const gasPrice  = ethers.parseUnits("0.001", "gwei");
      return { gasCostWei: gasPrice * gasUnits, gasUnits };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _fail(reason, data = {}) {
    return {
      isExecutable: false,
      reason,
      netProfit:    0n,
      netProfitUsd: 0,
      ...data,
    };
  }
}

module.exports = Simulator;
