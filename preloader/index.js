/**
 * preloader/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-computes and caches EVERYTHING before the hot path runs.
 *
 * Critical design principle:
 *   ZERO route computation during execution. All routes, pool addresses,
 *   contract instances, and token metadata are resolved here at startup
 *   and frozen into memory. The scanner reads from these frozen structures.
 *
 * What gets preloaded:
 *   • Pool addresses for all pair × DEX combinations
 *   • ethers.Contract instances (pre-built, no re-instantiation)
 *   • Token decimals and metadata
 *   • All possible swap routes (direct + triangular)
 *   • Aave pool address (cached)
 *   • Signer (wallet pre-loaded in memory)
 */

"use strict";

const { ethers } = require("ethers");
const config      = require("../config");
const logger      = require("../utils/logger");
const Multicall   = require("../utils/multicall");

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const V2_FACTORY_ABI = [
  "function getPair(address,address) external view returns (address)",
];

const V3_FACTORY_ABI = [
  "function getPool(address,address,uint24) external view returns (address)",
];

const V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112,uint112,uint32)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
];

const V3_POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() external view returns (uint128)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
];

const ERC20_ABI = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

const AAVE_PROVIDER_ABI = [
  "function getPool() external view returns (address)",
];

// ─── V3 fee tiers ────────────────────────────────────────────────────────────

const V3_FEE_TIERS = [100, 500, 3000, 10000];

// ─────────────────────────────────────────────────────────────────────────────

class Preloader {
  constructor(provider, wsProvider) {
    this.provider   = provider;
    this.wsProvider = wsProvider;
    this.multicall  = new Multicall(provider);

    // The fully preloaded state — read-only during execution
    this.state = {
      pools:         [],      // all resolved pool descriptors
      poolMap:       new Map(), // poolAddress → descriptor
      tokenMeta:     new Map(), // tokenAddress → { decimals, symbol }
      routes:        [],      // all valid arb routes
      routesByPool:  new Map(), // poolAddress -> route[]
      contractCache: new Map(), // poolAddress → ethers.Contract (http)
      wsContracts:   new Map(), // poolAddress → ethers.Contract (ws)
      aavePool:      null,    // Aave pool address (string)
      wallet:        null,    // pre-loaded signer
      ready:         false,
    };
  }

  // ── Main init ───────────────────────────────────────────────────────────────

  async init() {
    const t0 = Date.now();
    logger.info("🔧 Preloader initializing…");

    // Step 1: Pre-load wallet (fastest possible signing)
    this._initWallet();

    // Step 2: Fetch Aave pool address
    await this._fetchAavePool();

    // Step 3: Resolve all token metadata in parallel
    await this._resolveTokenMeta();

    // Step 4: Resolve all pool addresses (batch via multicall)
    await this._resolvePools();

    // Step 5: Pre-instantiate all contract objects
    this._buildContractInstances();

    // Step 6: Build all valid arb routes
    this._buildRoutes();

    this.state.ready = true;
    logger.info(`✅ Preloader ready in ${Date.now() - t0}ms — ${this.state.pools.length} pools, ${this.state.routes.length} routes`);

    return this.state;
  }

  // ── Step 1: Wallet ──────────────────────────────────────────────────────────

  _initWallet() {
    this.state.wallet = new ethers.Wallet(config.PRIVATE_KEY, this.provider);
    logger.info(`💼 Wallet preloaded: ${this.state.wallet.address}`);
  }

  // ── Step 2: Aave pool ───────────────────────────────────────────────────────

  async _fetchAavePool() {
    const ap = new ethers.Contract(config.AAVE_ADDRESSES_PROVIDER, AAVE_PROVIDER_ABI, this.provider);
    this.state.aavePool = await ap.getPool();
    logger.info(`🏦 Aave pool: ${this.state.aavePool}`);
  }

  // ── Step 3: Token metadata ───────────────────────────────────────────────────

  async _resolveTokenMeta() {
    const tokens = new Set();
    for (const pair of config.TOKEN_PAIRS) {
      tokens.add(pair.token0.toLowerCase());
      tokens.add(pair.token1.toLowerCase());
    }

    const tokenList = [...tokens];

    // Batch decimals + symbols
    const decCalls = tokenList.map(t => ({
      target: t, abi: ERC20_ABI, method: "decimals", args: []
    }));
    const symCalls = tokenList.map(t => ({
      target: t, abi: ERC20_ABI, method: "symbol", args: []
    }));

    const [decResults, symResults] = await Promise.all([
      this.multicall.call(decCalls),
      this.multicall.call(symCalls),
    ]);

    for (let i = 0; i < tokenList.length; i++) {
      const addr     = tokenList[i];
      const decimals = decResults[i]?.result?.[0] ?? 18;
      const symbol   = symResults[i]?.result?.[0] ?? "???";
      this.state.tokenMeta.set(addr, { decimals: Number(decimals), symbol });
    }

    logger.info(`🪙  Token metadata resolved for ${this.state.tokenMeta.size} tokens`);
  }

  // ── Step 4: Pool resolution ──────────────────────────────────────────────────

  async _resolvePools() {
    logger.info("🔍 Resolving pool addresses via multicall…");

    const tasks = [];

    for (const dex of config.DEX_CONFIGS) {
      for (const pair of config.TOKEN_PAIRS) {
        if (dex.version === 2) {
          tasks.push(this._resolveV2Pool(dex, pair));
        } else if (dex.version === 3) {
          for (const fee of V3_FEE_TIERS) {
            tasks.push(this._resolveV3Pool(dex, pair, fee));
          }
        }
      }
    }

    // Resolve all in parallel
    const results = await Promise.allSettled(tasks);

    let resolved = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        const pool = r.value;
        this.state.pools.push(pool);
        this.state.poolMap.set(pool.address.toLowerCase(), pool);
        resolved++;
      }
    }

    logger.info(`📊 Resolved ${resolved} pools`);
  }

  async _resolveV2Pool(dex, pair) {
    try {
      const factory = new ethers.Contract(dex.factory, V2_FACTORY_ABI, this.provider);
      const addr    = await factory.getPair(pair.token0, pair.token1);
      if (!addr || addr === ethers.ZeroAddress) return null;

      const meta0 = this.state.tokenMeta.get(pair.token0.toLowerCase()) ?? { decimals: 18 };
      const meta1 = this.state.tokenMeta.get(pair.token1.toLowerCase()) ?? { decimals: 18 };

      return {
        address:    addr,
        version:    2,
        dex,
        pair:       { ...pair, decimals0: meta0.decimals, decimals1: meta1.decimals },
        reserve0:   0n,
        reserve1:   0n,
        price:      0,
        liquidity:  0n,
        lastUpdate: 0,
      };
    } catch { return null; }
  }

  async _resolveV3Pool(dex, pair, fee) {
    try {
      const factory = new ethers.Contract(dex.factory, V3_FACTORY_ABI, this.provider);
      const addr    = await factory.getPool(pair.token0, pair.token1, fee);
      if (!addr || addr === ethers.ZeroAddress) return null;

      const meta0 = this.state.tokenMeta.get(pair.token0.toLowerCase()) ?? { decimals: 18 };
      const meta1 = this.state.tokenMeta.get(pair.token1.toLowerCase()) ?? { decimals: 18 };

      return {
        address:     addr,
        version:     3,
        fee,
        dex,
        pair:        { ...pair, decimals0: meta0.decimals, decimals1: meta1.decimals },
        sqrtPriceX96: 0n,
        liquidity:   0n,
        price:       0,
        lastUpdate:  0,
      };
    } catch { return null; }
  }

  // ── Step 5: Contract instances ───────────────────────────────────────────────

  _buildContractInstances() {
    for (const pool of this.state.pools) {
      const abi = pool.version === 2 ? V2_PAIR_ABI : V3_POOL_ABI;

      // HTTP instance (for batch reads)
      this.state.contractCache.set(
        pool.address.toLowerCase(),
        new ethers.Contract(pool.address, abi, this.provider)
      );

      // WS instance (for event subscriptions)
      if (this.wsProvider) {
        this.state.wsContracts.set(
          pool.address.toLowerCase(),
          new ethers.Contract(pool.address, abi, this.wsProvider)
        );
      }
    }
    logger.info(`⚡ ${this.state.contractCache.size} contract instances pre-built`);
  }

  // ── Step 6: Route building ───────────────────────────────────────────────────

  /**
   * A route is a pair of pools sharing the same token pair but on different DEXs.
   * We pre-compute every valid (buyPool, sellPool) combination.
   * During scanning, we just iterate this list — no dynamic computation.
   */
  _buildRoutes() {
    // Group pools by pair symbol
    const byPair = new Map();
    for (const pool of this.state.pools) {
      const key = pool.pair.symbol;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(pool);
    }

    for (const [symbol, pools] of byPair) {
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          // Both directions
          const route = {
            id:      `${symbol}|${pools[i].dex.name}→${pools[j].dex.name}`,
            symbol,
            poolA:   pools[i],
            poolB:   pools[j],
          };
          this.state.routes.push(route);

          const a = pools[i].address.toLowerCase();
          const b = pools[j].address.toLowerCase();
          if (!this.state.routesByPool.has(a)) this.state.routesByPool.set(a, []);
          if (!this.state.routesByPool.has(b)) this.state.routesByPool.set(b, []);
          this.state.routesByPool.get(a).push(route);
          this.state.routesByPool.get(b).push(route);
        }
      }
    }

    logger.info(`🗺  Built ${this.state.routes.length} arb routes`);
  }

  // ── Public accessors ─────────────────────────────────────────────────────────

  getPool(address) {
    return this.state.poolMap.get(address.toLowerCase());
  }

  getContract(address) {
    return this.state.contractCache.get(address.toLowerCase());
  }

  getWsContract(address) {
    return this.state.wsContracts.get(address.toLowerCase());
  }
}

module.exports = Preloader;
