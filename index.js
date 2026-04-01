/**
 * index.js — V2 Main Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * Boot sequence:
 *   1. Validate config
 *   2. Preload all pool data, routes, contracts, wallet (cold path)
 *   3. Start failsafe watchdog
 *   4. Start WebSocket-only scanner (hot path)
 *   5. Run 24/7 until SIGINT/SIGTERM
 */

"use strict";

process.title = "base-arb-v2";

let config;
try {
  config = require("./config");
} catch (err) {
  console.error(`\n❌ Config error: ${err.message}\n`);
  process.exit(1);
}

const { ethers } = require("ethers");
const Preloader   = require("./preloader");
const Scanner     = require("./engine/scanner");
const Failsafe    = require("./failsafe");
const logger      = require("./utils/logger");

// ─── Banner ───────────────────────────────────────────────────────────────────

console.log(`\x1b[1m\x1b[36m
╔══════════════════════════════════════════════════╗
║  ⚡ BASE ARBITRAGE ENGINE  V2                    ║
║  Event-driven | MEV-aware | Dynamic sizing       ║
║  Network: Base L2                                ║
╚══════════════════════════════════════════════════╝
\x1b[0m`);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Providers
  const httpProvider = new ethers.JsonRpcProvider(config.RPC_URL_BASE);
  const wsProvider   = new ethers.WebSocketProvider(config.WS_URL_BASE);

  logger.info(`🌐 HTTP RPC: ${config.RPC_URL_BASE}`);
  logger.info(`🔌 WS  RPC: ${config.WS_URL_BASE}`);
  logger.info(`💼 Wallet:  ${new ethers.Wallet(config.PRIVATE_KEY).address}`);
  logger.info(`📋 Contract:${config.CONTRACT_ADDRESS}`);
  logger.info(`🛡  MEV:     ${config.PRIVATE_RPC_URL ? "PRIVATE RPC" : config.RELAYER_URL ? "RELAYER" : "PUBLIC"}`);
  logger.info("");

  // ── 1. Preload (cold path — do everything heavy here) ──────────────────────
  logger.info("⏳ Running preloader (this runs once at startup)…");
  const preloader = new Preloader(httpProvider, wsProvider);
  const state     = await preloader.init();

  if (!state.ready) {
    logger.error("Preloader failed — cannot continue");
    process.exit(1);
  }

  // ── 2. Start scanner ────────────────────────────────────────────────────────
  const scanner = new Scanner(state, wsProvider);
  await scanner.start();

  // ── 3. Start failsafe watchdog ──────────────────────────────────────────────
  const failsafe = new Failsafe(scanner);
  failsafe.start();

  logger.info("\n✅ System fully operational — monitoring 24/7\n");

  // ── Shutdown ─────────────────────────────────────────────────────────────────
  async function shutdown(sig) {
    logger.info(`\n${sig} received — shutting down…`);
    failsafe.stop();
    await scanner.stop();
    logger.info("✅ Clean shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
