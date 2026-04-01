/**
 * engine/pipeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * EXECUTION PIPELINE
 *
 * Orchestrates the complete flow for a single opportunity candidate:
 *
 *   Liquidity check → Honeypot check → Dynamic sizing →
 *   Simulation → Ranking → Execution lock → MEV-aware send
 *
 * Designed for concurrent invocation — multiple routes may hit this
 * simultaneously. The ranker's execution lock ensures only one TX
 * is submitted at a time.
 *
 * Timing budget per pipeline run (target < 200ms before execution):
 *   Liquidity:     < 5ms   (in-memory reserve math)
 *   Honeypot:      < 1ms   (cached)
 *   Sizing:        < 2ms   (pure math, no RPC)
 *   Simulation:    < 10ms  (pure math + 1 RPC for gas)
 *   Gas estimate:  < 50ms  (eth_feeData)
 *   TX sign:       < 1ms   (in-memory wallet)
 *   TX send:       network
 */

"use strict";

const { ethers } = require("ethers");
const crypto      = require("crypto");

const config          = require("../config");
const logger          = require("../utils/logger");
const LiquidityFilter = require("../filters/liquidity");
const HoneypotFilter  = require("../filters/honeypot");
const SlippageCalc    = require("../filters/slippage");
const Simulator       = require("../simulation");
const TradeSizer      = require("../sizing");
const OpportunityRanker = require("../ranking");
const MevSender       = require("../mev/sender");

// ─── Singleton components (shared across all pipeline runs) ───────────────────

// These are instantiated once and reused — critical for performance
let _ranker   = null;
let _sender   = null;
let _liquidF  = null;
let _honeypotF = null;
let _slippageC = null;
let _simulator = null;
let _sizer     = null;

// ─────────────────────────────────────────────────────────────────────────────

class PipelineRunner {
  constructor(preloaderState) {
    this.state    = preloaderState;
    this.provider = preloaderState.wallet?.provider;

    // Initialize singletons once
    if (!_ranker)    _ranker    = new OpportunityRanker();
    if (!_sizer)     _sizer     = new TradeSizer();
    if (!_slippageC) _slippageC = new SlippageCalc();
    if (!_simulator) _simulator = new Simulator(this.provider);

    if (!_liquidF) {
      _liquidF = new LiquidityFilter(this.provider);
    }
    if (!_honeypotF) {
      _honeypotF = new HoneypotFilter(this.provider);
    }
    if (!_sender && preloaderState.wallet) {
      _sender = new MevSender(preloaderState.wallet, this.provider);
    }
  }

  /**
   * Run the full pipeline for one opportunity.
   * @returns {boolean} true if execution was attempted
   */
  async run({ route, buyPool, sellPool, spread }) {
    const t0      = Date.now();
    let decision  = "SKIP";
    let reason    = "";
    let txHash    = null;

    try {

      // ── 1. Liquidity check (fast — uses cached reserves) ──────────────────
      const liqResult = await _liquidF.check({
        buyPool,
        sellPool,
        pair:        buyPool.pair,
        tradeAmount: config.FLASH_LOAN_AMOUNT,
      });

      if (!liqResult.ok) {
        reason = `Liq: ${liqResult.reason}`;
        return false;
      }

      // ── 2. Honeypot check (cached — usually < 1ms) ────────────────────────
      const hpResult = await _honeypotF.check({
        token0: buyPool.pair.token0,
        token1: buyPool.pair.token1,
      });

      if (!hpResult.ok) {
        reason = `Honeypot: ${hpResult.reason}`;
        return false;
      }

      // ── 3. Gas estimate (one RPC call, cached for 5s) ─────────────────────
      const { gasCostWei, gasUnits } = await this._estimateGas(buyPool, sellPool);

      // ── 4. Dynamic trade sizing ───────────────────────────────────────────
      const sizing = _sizer.optimize({
        buyPool,
        sellPool,
        pair:        buyPool.pair,
        gasCostWei,
        ethPriceUsd: config.ETH_PRICE_USD,
      });

      if (sizing.optimalAmount === 0n) {
        reason = "No profitable size found";
        return false;
      }

      // ── 5. Slippage at optimal size ────────────────────────────────────────
      const slippage = _slippageC.calculate({
        buyPool,
        tradeAmount: sizing.optimalAmount,
        pair:        buyPool.pair,
      });

      if (!slippage.ok || slippage.slippagePercent > config.MAX_SLIPPAGE) {
        reason = `Slippage ${slippage.slippagePercent?.toFixed(2)}% > max`;
        return false;
      }

      // ── 6. Full simulation at optimal size ────────────────────────────────
      const sim = await _simulator.run({
        pair:        buyPool.pair,
        buyPool,
        sellPool,
        tradeAmount: sizing.optimalAmount,
        slippage,
      });

      if (!sim.isExecutable) {
        reason = `Sim: ${sim.reason}`;
        return false;
      }

      // ── 7. Rank + try execution lock ──────────────────────────────────────
      const score = _ranker.score(sim, route.id, spread);

      if (score <= 0) {
        reason = `Score too low: ${score.toFixed(2)}`;
        return false;
      }

      // Only one execution at a time — if another is in flight, skip
      if (!_ranker.tryLock()) {
        reason = "Execution locked (concurrent TX in flight)";
        return false;
      }

      decision = "EXECUTE";

      try {
        logger.info(`\n💥 EXECUTE | ${route.id} | profit=$${sim.netProfitUsd?.toFixed(4)} | score=${score.toFixed(2)}`);

        const opportunityId = this._genOpportunityId(route.id, sizing.optimalAmount);
        const steps         = this._buildSteps(buyPool, sellPool, slippage, sim);

        txHash = await _sender.send({
          steps,
          amount:         sizing.optimalAmount,
          asset:          buyPool.pair.token0,
          expectedProfit: sim.expectedProfit,
          netProfitWei:   sim.netProfit,
          gasUnits:       BigInt(gasUnits),
          opportunityId,
        });

        _ranker.recordSuccess(route.id);
        return true;

      } catch (err) {
        _ranker.recordFailure(route.id);
        reason = `TX error: ${err.message}`;
        logger.error(`  ❌ TX failed: ${err.message}`);
        return false;

      } finally {
        _ranker.unlock();
      }

    } catch (err) {
      reason = `Pipeline error: ${err.message}`;
      logger.debug(`Pipeline error [${route.id}]: ${err.message}`);
      return false;

    } finally {
      logger.decision({
        pair:     route.symbol,
        spread:   spread.toFixed(4),
        decision,
        reason,
        duration: Date.now() - t0,
        txHash,
      });
    }
  }

  // ── Build SwapStep[] ────────────────────────────────────────────────────────

  _buildSteps(buyPool, sellPool, slippage, sim) {
    return [
      {
        dexType:     buyPool.version === 2 ? 0 : 1,
        router:      buyPool.dex.router,
        tokenIn:     buyPool.pair.token0,
        tokenOut:    buyPool.pair.token1,
        fee:         buyPool.fee ?? 3000,
        v3Path:      "0x",
        amountOutMin: sim.buyAmountOutMin ?? slippage.amountOutMin ?? 0n,
      },
      {
        dexType:     sellPool.version === 2 ? 0 : 1,
        router:      sellPool.dex.router,
        tokenIn:     sellPool.pair.token1,
        tokenOut:    sellPool.pair.token0,
        fee:         sellPool.fee ?? 3000,
        v3Path:      "0x",
        amountOutMin: sim.sellAmountOutMin ?? 0n,
      },
    ];
  }

  // ── Gas estimation with cache ───────────────────────────────────────────────

  _gasCache = null;
  _gasCacheAt = 0;
  _GAS_CACHE_TTL = 5000; // 5s

  async _estimateGas(buyPool, sellPool) {
    const now = Date.now();
    if (this._gasCache && now - this._gasCacheAt < this._GAS_CACHE_TTL) {
      return this._gasCache;
    }

    const feeData  = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? ethers.parseUnits("0.001", "gwei");
    const hasV3    = buyPool.version === 3 || sellPool.version === 3;
    const gasUnits = hasV3 ? 480_000 : 320_000;
    const gasCostWei = gasPrice * BigInt(gasUnits) * 120n / 100n;

    this._gasCache   = { gasCostWei, gasUnits };
    this._gasCacheAt = now;

    return this._gasCache;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _genOpportunityId(routeId, amount) {
    const raw = `${routeId}:${amount}:${Date.now()}`;
    return "0x" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 64);
  }
}

module.exports = PipelineRunner;
