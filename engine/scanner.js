/**
 * engine/scanner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HIGH-PERFORMANCE EVENT-DRIVEN SCANNER
 *
 * Design principles:
 *   ✓ WebSocket events ONLY — no polling intervals
 *   ✓ Parallel opportunity processing via Promise.allSettled
 *   ✓ Zero route computation during hot path (pre-loaded at startup)
 *   ✓ Shared price state updated in-place (no object allocation in hot loop)
 *   ✓ Automatic WS reconnection with exponential backoff
 *   ✓ Heartbeat monitor — detects stale connections
 */

"use strict";

const { ethers }  = require("ethers");
const logger       = require("../utils/logger");
const config       = require("../config");
const PipelineRunner = require("./pipeline");

// ─── Constants ────────────────────────────────────────────────────────────────

const Q96               = 2n ** 96n;
const WS_PING_INTERVAL  = 15_000;  // 15s heartbeat
const WS_RECONNECT_BASE = 1_000;   // 1s initial backoff
const WS_RECONNECT_MAX  = 30_000;  // 30s max backoff
const PRICE_STALENESS   = 30_000;  // 30s — reject stale price data

// ─── Scanner ──────────────────────────────────────────────────────────────────

class Scanner {
  /**
   * @param {object} preloaderState  - Frozen state from Preloader
   * @param {object} wsProvider      - ethers WebSocketProvider
   */
  constructor(preloaderState, wsProvider) {
    this.state      = preloaderState;  // pools, routes, contractCache, wsContracts
    this.wsProvider = wsProvider;
    this.pipeline   = new PipelineRunner(preloaderState);

    this._running     = false;
    this._listeners   = [];            // { contract, event, handler }
    this._pingTimer   = null;
    this._wsReady     = false;

    // Stats (no allocation in hot path)
    this.stats = { events: 0, opportunities: 0, executed: 0, errors: 0 };
  }

  // ── Start / Stop ─────────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    logger.info("⚡ Scanner starting (WebSocket-only mode)…");

    await this._doInitialPriceFetch();
    await this._attachAllListeners();
    this._startHeartbeat();

    logger.info(`📡 Listening on ${this._listeners.length} event streams`);
    logger.info(`🗺  Monitoring ${this.state.routes.length} arb routes`);
  }

  async stop() {
    this._running = false;
    clearInterval(this._pingTimer);

    for (const { contract, event, handler } of this._listeners) {
      try { contract.off(event, handler); } catch { /* ignore */ }
    }
    this._listeners = [];

    try { await this.wsProvider.destroy(); } catch { /* ignore */ }

    logger.info("🛑 Scanner stopped");
  }

  // ── Initial price fetch (batch via multicall) ─────────────────────────────────

  async _doInitialPriceFetch() {
    const { pools, contractCache } = this.state;
    const t0 = Date.now();

    logger.info(`📥 Fetching initial prices for ${pools.length} pools…`);

    // Build multicall batch
    const Multicall = require("../utils/multicall");
    const mc = new Multicall(this.wsProvider);

    const v2Pools = pools.filter(p => p.version === 2);
    const v3Pools = pools.filter(p => p.version === 3);

    const [v2Results, v3Results] = await Promise.all([
      v2Pools.length ? mc.call(v2Pools.map(p => ({
        target: p.address,
        abi:    ["function getReserves() external view returns (uint112,uint112,uint32)"],
        method: "getReserves",
        args:   [],
      }))) : [],
      v3Pools.length ? mc.call(v3Pools.map(p => ({
        target: p.address,
        abi:    ["function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() external view returns (uint128)"],
        method: "slot0",
        args:   [],
      }))) : [],
    ]);

    for (let i = 0; i < v2Pools.length; i++) {
      const res = v2Results[i];
      if (res?.result) this._applyV2Reserves(v2Pools[i], res.result[0], res.result[1]);
    }
    for (let i = 0; i < v3Pools.length; i++) {
      const res = v3Results[i];
      if (res?.result) this._applyV3SqrtPrice(v3Pools[i], res.result[0]);
    }

    logger.info(`✅ Initial prices loaded in ${Date.now() - t0}ms`);
  }

  // ── Attach WS event listeners ─────────────────────────────────────────────────

  async _attachAllListeners() {
    for (const pool of this.state.pools) {
      const wsContract = this.state.wsContracts.get(pool.address.toLowerCase());
      if (!wsContract) continue;

      if (pool.version === 2) {
        this._listen(wsContract, "Sync", pool, (r0, r1) => {
          this._applyV2Reserves(pool, r0, r1);
          this._onPoolUpdated(pool);
        });
      } else {
        this._listen(wsContract, "Swap", pool, (_s, _r, _a0, _a1, sqrtPriceX96) => {
          this._applyV3SqrtPrice(pool, sqrtPriceX96);
          this._onPoolUpdated(pool);
        });
      }
    }
  }

  _listen(contract, event, pool, handler) {
    const wrapped = (...args) => {
      if (!this._running) return;
      this.stats.events++;
      try { handler(...args); }
      catch (err) {
        this.stats.errors++;
        logger.debug(`Event handler error [${pool.address.slice(0,8)}]: ${err.message}`);
      }
    };
    contract.on(event, wrapped);
    this._listeners.push({ contract, event, handler: wrapped });
  }

  // ── Price state updates (in-place, no allocation) ─────────────────────────────

  _applyV2Reserves(pool, r0, r1) {
    pool.reserve0   = r0;
    pool.reserve1   = r1;
    pool.lastUpdate = Date.now();

    // price = reserve1 / reserve0 adjusted for decimals
    const f0 = Number(r0) / (10 ** pool.pair.decimals0);
    const f1 = Number(r1) / (10 ** pool.pair.decimals1);
    pool.price = f0 > 0 ? f1 / f0 : 0;
  }

  _applyV3SqrtPrice(pool, sqrtPriceX96) {
    pool.sqrtPriceX96 = sqrtPriceX96;
    pool.lastUpdate   = Date.now();

    // price = (sqrtPriceX96 / 2^96)^2 * 10^(dec0-dec1)
    const sq  = Number(sqrtPriceX96) / Number(Q96);
    const adj = 10 ** (pool.pair.decimals0 - pool.pair.decimals1);
    pool.price = sq * sq * adj;
  }

  // ── Pool update → check all routes touching this pool ─────────────────────────

  _onPoolUpdated(updatedPool) {
    // Find all routes that include this pool
    const affectedRoutes = this.state.routes.filter(
      r => r.poolA === updatedPool || r.poolB === updatedPool
    );

    if (affectedRoutes.length === 0) return;

    // Process all affected routes IN PARALLEL — never await in sequence
    const tasks = affectedRoutes.map(route => this._evaluateRoute(route));
    Promise.allSettled(tasks); // fire-and-forget with error containment
  }

  // ── Route evaluation (hot path — must be fast) ────────────────────────────────

  async _evaluateRoute(route) {
    const { poolA, poolB } = route;

    // Reject stale data
    const now = Date.now();
    if (now - poolA.lastUpdate > PRICE_STALENESS) return;
    if (now - poolB.lastUpdate > PRICE_STALENESS) return;

    // Reject zero prices
    if (poolA.price === 0 || poolB.price === 0) return;

    // Spread calculation (cheapest multiply path)
    const lo    = poolA.price < poolB.price ? poolA : poolB;
    const hi    = poolA.price < poolB.price ? poolB : poolA;
    const spread = (hi.price - lo.price) / lo.price * 100;

    if (spread < config.MIN_SPREAD_PERCENT) return;

    this.stats.opportunities++;

    logger.opportunity({
      id:        route.id,
      pair:      route.symbol,
      spread:    spread.toFixed(4),
      buyDex:    lo.dex.name,
      buyPrice:  lo.price.toFixed(8),
      sellDex:   hi.dex.name,
      sellPrice: hi.price.toFixed(8),
    });

    // Hand off to pipeline (filters → sizing → sim → rank → execute)
    const executed = await this.pipeline.run({
      route,
      buyPool:  lo,
      sellPool: hi,
      spread,
    });

    if (executed) this.stats.executed++;
  }

  // ── Heartbeat / reconnect ─────────────────────────────────────────────────────

  _startHeartbeat() {
    this._pingTimer = setInterval(async () => {
      try {
        await this.wsProvider.getBlockNumber();
        this._wsReady = true;
      } catch (err) {
        logger.warn(`💔 WS heartbeat failed: ${err.message}`);
        this._wsReady = false;
        this._reconnect();
      }
    }, WS_PING_INTERVAL);
  }

  async _reconnect(attempt = 1) {
    const delay = Math.min(WS_RECONNECT_BASE * 2 ** (attempt - 1), WS_RECONNECT_MAX);
    logger.warn(`🔄 WS reconnect attempt ${attempt} in ${delay}ms…`);
    await sleep(delay);

    try {
      // Remove old listeners
      for (const { contract, event, handler } of this._listeners) {
        try { contract.off(event, handler); } catch { /* ignore */ }
      }
      this._listeners = [];

      // Rebuild ws provider
      this.wsProvider = new ethers.WebSocketProvider(config.WS_URL_BASE);

      // Rebuild ws contract instances in preloader state
      for (const [addr, pool] of this.state.poolMap) {
        const abi = pool.version === 2
          ? ["event Sync(uint112 reserve0, uint112 reserve1)"]
          : ["event Swap(address indexed sender,address indexed recipient,int256,int256,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"];
        this.state.wsContracts.set(addr, new ethers.Contract(pool.address, abi, this.wsProvider));
      }

      await this._attachAllListeners();
      this._wsReady = true;
      logger.info("✅ WS reconnected");
    } catch (err) {
      logger.error(`WS reconnect failed: ${err.message}`);
      this._reconnect(attempt + 1);
    }
  }

  getStats() { return { ...this.stats }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = Scanner;
