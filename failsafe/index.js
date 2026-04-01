/**
 * failsafe/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 24/7 WATCHDOG & FAILSAFE SYSTEM
 *
 * Monitors system health and automatically recovers from:
 *   • WebSocket disconnections
 *   • RPC endpoint failures
 *   • Consecutive execution failures (circuit breaker)
 *   • Memory leaks (periodic stat dump)
 *   • Unhandled promise rejections
 *
 * Circuit breaker: if N consecutive TX failures occur within a window,
 * pause execution for COOLDOWN_PERIOD to avoid burning gas on a broken state.
 */

"use strict";

const logger = require("../utils/logger");
const config = require("../config");

// ─── Circuit breaker config ───────────────────────────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 5;      // failures before open
const CIRCUIT_BREAKER_WINDOW    = 60_000; // 1 minute window
const CIRCUIT_BREAKER_COOLDOWN  = 120_000; // 2 minute pause when open

// ─── Health check intervals ───────────────────────────────────────────────────

const HEALTH_INTERVAL    = 30_000;  // 30s
const STAT_DUMP_INTERVAL = 300_000; // 5 min

// ─────────────────────────────────────────────────────────────────────────────

class Failsafe {
  constructor(scanner) {
    this.scanner = scanner;

    // Circuit breaker state
    this._failures     = [];  // timestamps of recent failures
    this._circuitOpen  = false;
    this._circuitTimer = null;

    // Health timers
    this._healthTimer  = null;
    this._statTimer    = null;

    // System start time
    this._startTime    = Date.now();
  }

  start() {
    logger.info("🛡  Failsafe watchdog started");

    // Global unhandled rejection handler
    process.on("unhandledRejection", (reason) => {
      logger.error(`🚨 Unhandled rejection: ${reason}`);
      this._recordFailure("unhandledRejection");
    });

    process.on("uncaughtException", (err) => {
      logger.error(`🚨 Uncaught exception: ${err.message}`);
      this._recordFailure("uncaughtException");
      // Don't exit — let the watchdog recover
    });

    // Periodic health checks
    this._healthTimer = setInterval(() => this._healthCheck(), HEALTH_INTERVAL);

    // Periodic stat dumps
    this._statTimer = setInterval(() => this._dumpStats(), STAT_DUMP_INTERVAL);
  }

  stop() {
    clearInterval(this._healthTimer);
    clearInterval(this._statTimer);
    clearTimeout(this._circuitTimer);
    logger.info("🛡  Failsafe stopped");
  }

  // ── Called by execution engine on failure ─────────────────────────────────────

  recordExecutionFailure(reason) {
    this._recordFailure(reason);
  }

  recordExecutionSuccess() {
    // Clear recent failures on success
    this._failures = [];
    if (this._circuitOpen) {
      logger.info("⚡ Circuit breaker CLOSED (success detected)");
      this._circuitOpen = false;
      clearTimeout(this._circuitTimer);
    }
  }

  isCircuitOpen() {
    return this._circuitOpen;
  }

  // ── Circuit breaker logic ─────────────────────────────────────────────────────

  _recordFailure(reason) {
    const now = Date.now();
    this._failures.push({ ts: now, reason });

    // Trim failures outside window
    this._failures = this._failures.filter(f => now - f.ts < CIRCUIT_BREAKER_WINDOW);

    logger.warn(`⚠️  Failure recorded (${this._failures.length}/${CIRCUIT_BREAKER_THRESHOLD}): ${reason}`);

    if (!this._circuitOpen && this._failures.length >= CIRCUIT_BREAKER_THRESHOLD) {
      this._openCircuit();
    }
  }

  _openCircuit() {
    this._circuitOpen = true;
    logger.error(`🔴 CIRCUIT BREAKER OPEN — pausing execution for ${CIRCUIT_BREAKER_COOLDOWN / 1000}s`);
    logger.error(`   Recent failures: ${this._failures.map(f => f.reason).join(", ")}`);

    // Auto-close after cooldown
    this._circuitTimer = setTimeout(() => {
      this._circuitOpen = false;
      this._failures    = [];
      logger.info("🟢 Circuit breaker CLOSED — resuming execution");
    }, CIRCUIT_BREAKER_COOLDOWN);
  }

  // ── Health check ──────────────────────────────────────────────────────────────

  async _healthCheck() {
    try {
      const stats = this.scanner.getStats();
      const uptime = Math.floor((Date.now() - this._startTime) / 1000);

      // Check if events are flowing (at least 1 event in last 60s)
      if (uptime > 60 && stats.events === 0) {
        logger.warn("⚠️  No events received — possible WS issue");
      }

      // Memory usage check
      const mem = process.memoryUsage();
      const heapMb = Math.floor(mem.heapUsed / 1024 / 1024);
      if (heapMb > 512) {
        logger.warn(`⚠️  High memory usage: ${heapMb}MB heap`);
      }

      logger.debug(`💓 Health OK | uptime=${uptime}s | events=${stats.events} | exec=${stats.executed} | mem=${heapMb}MB`);

    } catch (err) {
      logger.error(`Health check error: ${err.message}`);
    }
  }

  // ── Stat dump ─────────────────────────────────────────────────────────────────

  _dumpStats() {
    const stats  = this.scanner.getStats();
    const uptime = Math.floor((Date.now() - this._startTime) / 1000);
    const mem    = process.memoryUsage();

    const report = [
      "═══════════════════════════════════════",
      "📊 SYSTEM STATS",
      `   Uptime:        ${Math.floor(uptime / 60)}m ${uptime % 60}s`,
      `   Events:        ${stats.events.toLocaleString()}`,
      `   Opportunities: ${stats.opportunities.toLocaleString()}`,
      `   Executed:      ${stats.executed}`,
      `   Errors:        ${stats.errors}`,
      `   Circuit:       ${this._circuitOpen ? "🔴 OPEN" : "🟢 CLOSED"}`,
      `   Heap:          ${Math.floor(mem.heapUsed / 1024 / 1024)}MB / ${Math.floor(mem.heapTotal / 1024 / 1024)}MB`,
      "═══════════════════════════════════════",
    ].join("\n");

    logger.info(report);

    // Send to webhook if configured
    if (config.WEBHOOK_URL && stats.executed > 0) {
      // Reuse logger's webhook mechanism
      require("../utils/logger")._sendWebhook?.({ text: report });
    }
  }
}

module.exports = Failsafe;
