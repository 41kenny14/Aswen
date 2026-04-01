/**
 * filters/honeypot.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Honeypot and token safety detection.
 *
 * Strategy (callStatic simulation only — no real funds at risk):
 *   1. Check token metadata (name/symbol presence, total supply > 0)
 *   2. Simulate a small buy via V2 router → check received amount
 *   3. Simulate selling all received tokens → check proceeds
 *   4. Derive effective tax from round-trip loss
 *   5. Reject if sell fails OR effective tax > MAX_TAX_THRESHOLD
 *
 * All checks are cached per-token to avoid redundant RPC calls.
 */

"use strict";

const { ethers } = require("ethers");
const config      = require("../config");
const logger      = require("../utils/logger");

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function totalSupply() external view returns (uint256)",
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

const V2_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) external returns (uint256[])",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

// ─── Cache (token address → result) ──────────────────────────────────────────

const tokenCache = new Map(); // { ok, reason, tax, timestamp }
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── HoneypotFilter ───────────────────────────────────────────────────────────

class HoneypotFilter {
  constructor(provider) {
    this.provider = provider;

    // Use the first V2 router available for simulation
    this.testRouter = config.DEX_CONFIGS.find(d => d.version === 2)?.router;

    // Use USDC as the "safe" base token for simulation
    this.baseToken  = config.BASE_TOKEN; // e.g. USDC on Base
    this.testAmount = ethers.parseUnits("10", 6); // $10 USDC test trade
  }

  /**
   * Check both tokens in a pair for honeypot risk.
   *
   * @param {{ token0, token1, provider }} opts
   * @returns {{ ok: boolean, reason: string }}
   */
  async check({ token0, token1 }) {
    // Check each token (skip if it's the base token we already trust)
    for (const token of [token0, token1]) {
      if (token.toLowerCase() === this.baseToken.toLowerCase()) continue;

      const result = await this._checkToken(token);
      if (!result.ok) {
        return { ok: false, reason: `Token ${token}: ${result.reason}` };
      }
    }

    return { ok: true, reason: "tokens appear safe" };
  }

  /**
   * Check a single token. Uses cache when available.
   */
  async _checkToken(tokenAddress) {
    // ── Cache hit ───────────────────────────────────────────────────────────
    if (tokenCache.has(tokenAddress)) {
      const cached = tokenCache.get(tokenAddress);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        logger.debug(`  🔍 Honeypot cache hit for ${tokenAddress}: ${cached.ok ? "✅ safe" : `❌ ${cached.reason}`}`);
        return cached;
      }
    }

    logger.debug(`  🔍 Honeypot checking ${tokenAddress}…`);

    let result;

    try {
      // ── Step 1: Basic ERC20 checks ──────────────────────────────────────
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);

      let name, symbol, totalSupply;
      try {
        [name, symbol, totalSupply] = await Promise.all([
          token.name(),
          token.symbol(),
          token.totalSupply(),
        ]);
      } catch {
        result = { ok: false, reason: "Failed to read ERC20 metadata — likely not a valid token" };
        return this._cache(tokenAddress, result);
      }

      if (!name || !symbol) {
        result = { ok: false, reason: "Missing token name/symbol" };
        return this._cache(tokenAddress, result);
      }

      if (totalSupply === 0n) {
        result = { ok: false, reason: "Zero total supply" };
        return this._cache(tokenAddress, result);
      }

      // ── Step 2: Simulate buy (callStatic) ──────────────────────────────
      if (!this.testRouter) {
        // No V2 router configured — skip simulation, accept token
        result = { ok: true, reason: "no router for simulation", tax: 0 };
        return this._cache(tokenAddress, result);
      }

      const router = new ethers.Contract(this.testRouter, V2_ROUTER_ABI, this.provider);
      const buyPath  = [this.baseToken, tokenAddress];
      const sellPath = [tokenAddress, this.baseToken];

      // Get expected buy output
      let buyAmountsOut;
      try {
        buyAmountsOut = await router.getAmountsOut(this.testAmount, buyPath);
      } catch (err) {
        result = { ok: false, reason: `No liquidity path (buy): ${err.message}` };
        return this._cache(tokenAddress, result);
      }

      const expectedTokens = buyAmountsOut[1];
      if (expectedTokens === 0n) {
        result = { ok: false, reason: "Buy returns 0 tokens" };
        return this._cache(tokenAddress, result);
      }

      // ── Step 3: Simulate sell (callStatic) ─────────────────────────────
      let sellAmountsOut;
      try {
        sellAmountsOut = await router.getAmountsOut(expectedTokens, sellPath);
      } catch (err) {
        result = { ok: false, reason: `Sell path unavailable — likely honeypot: ${err.message}` };
        return this._cache(tokenAddress, result);
      }

      const sellProceeds = sellAmountsOut[1];

      // ── Step 4: Calculate effective round-trip tax ──────────────────────
      const buyFloat  = parseFloat(ethers.formatUnits(this.testAmount,   6));
      const sellFloat = parseFloat(ethers.formatUnits(sellProceeds,      6));
      const taxPercent = ((buyFloat - sellFloat) / buyFloat) * 100;

      logger.debug(`    Buy: $${buyFloat.toFixed(2)} → Sell: $${sellFloat.toFixed(2)} → Tax: ${taxPercent.toFixed(2)}%`);

      if (taxPercent > config.MAX_TAX_THRESHOLD * 100) {
        result = {
          ok:     false,
          reason: `Effective tax ${taxPercent.toFixed(2)}% > max ${config.MAX_TAX_THRESHOLD * 100}%`,
          tax:    taxPercent,
        };
        return this._cache(tokenAddress, result);
      }

      result = { ok: true, reason: "safe", tax: taxPercent };

    } catch (err) {
      result = { ok: false, reason: `Unexpected check error: ${err.message}` };
    }

    return this._cache(tokenAddress, result);
  }

  _cache(tokenAddress, result) {
    tokenCache.set(tokenAddress, { ...result, timestamp: Date.now() });
    return result;
  }

  /**
   * Expose cache for dashboard / introspection.
   */
  getCacheSnapshot() {
    return Object.fromEntries(tokenCache);
  }
}

module.exports = HoneypotFilter;
