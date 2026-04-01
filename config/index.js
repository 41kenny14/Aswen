/**
 * config/index.js  (V2)
 * ─────────────────────────────────────────────────────────────────────────────
 * V2 additions: private RPC, relayer, dynamic gas boost, ETH price oracle toggle
 */

"use strict";

require("dotenv").config();

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key, def) { return process.env[key] ?? def; }

function parsePairs(raw) {
  const pairs = raw.split(",").map(e => {
    const [symbol, token0, dec0, token1, dec1] = e.trim().split(":");
    if (!symbol || !token0 || !token1) {
      throw new Error(`Invalid TOKEN_PAIRS entry: ${e}`);
    }
    return { symbol, token0: token0.trim(), token1: token1.trim(), decimals0: +dec0 || 18, decimals1: +dec1 || 18 };
  });
  if (pairs.length === 0) throw new Error("TOKEN_PAIRS cannot be empty");
  return pairs;
}

function parseDexConfigs(raw) {
  const dexes = raw.split(",").map(e => {
    const [name, version, factory, router] = e.trim().split(":");
    if (!name || !version || !factory || !router) {
      throw new Error(`Invalid DEX_CONFIGS entry: ${e}`);
    }
    if (+version !== 2 && +version !== 3) {
      throw new Error(`DEX version must be 2 or 3: ${e}`);
    }
    return { name, version: +version, factory: factory.trim(), router: router.trim() };
  });
  if (dexes.length === 0) throw new Error("DEX_CONFIGS cannot be empty");
  return dexes;
}

const config = {
  // Network
  RPC_URL_BASE:  required("RPC_URL_BASE"),
  WS_URL_BASE:   required("WS_URL_BASE"),  // REQUIRED in V2 (no polling fallback)

  // Wallet + contract
  PRIVATE_KEY:       required("PRIVATE_KEY"),
  CONTRACT_ADDRESS:  required("CONTRACT_ADDRESS"),

  // Aave
  AAVE_ADDRESSES_PROVIDER: optional("AAVE_ADDRESSES_PROVIDER", "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D"),

  // Flash loan
  FLASH_LOAN_AMOUNT: BigInt(required("FLASH_LOAN_AMOUNT")),

  // ── MEV Protection ───────────────────────────────────────────────────────
  // Set ONE of these for frontrun protection:
  PRIVATE_RPC_URL: optional("PRIVATE_RPC_URL", null),  // e.g. Flashbots Protect
  RELAYER_URL:     optional("RELAYER_URL",     null),  // custom relayer endpoint
  RELAYER_AUTH:    optional("RELAYER_AUTH",    null),  // bearer token for relayer

  // ── Thresholds ───────────────────────────────────────────────────────────
  MIN_SPREAD_PERCENT:      parseFloat(optional("MIN_SPREAD_PERCENT",      "0.3")),
  MIN_PROFIT:              parseFloat(optional("MIN_PROFIT",               "1.0")),
  MAX_GAS_COST:            parseFloat(optional("MAX_GAS_COST",             "0.005")),
  MAX_GAS_PRICE_GWEI:      parseFloat(optional("MAX_GAS_PRICE_GWEI",       "0.05")),
  MAX_SLIPPAGE:            parseFloat(optional("MAX_SLIPPAGE",             "1.0")),
  MIN_LIQUIDITY_THRESHOLD: parseFloat(optional("MIN_LIQUIDITY_THRESHOLD",  "50000")),
  MAX_TAX_THRESHOLD:       parseFloat(optional("MAX_TAX_THRESHOLD",        "0.05")),

  // ── Pairs & DEXs ─────────────────────────────────────────────────────────
  TOKEN_PAIRS:  parsePairs(required("TOKEN_PAIRS")),
  DEX_CONFIGS:  parseDexConfigs(required("DEX_CONFIGS")),

  BASE_TOKEN:   optional("BASE_TOKEN", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),

  // ── Misc ─────────────────────────────────────────────────────────────────
  ETH_PRICE_USD:    parseFloat(optional("ETH_PRICE_USD",    "3000")),
  LOG_LEVEL:        optional("LOG_LEVEL",   "info"),
  WEBHOOK_URL:      optional("WEBHOOK_URL", null),
};

module.exports = config;
