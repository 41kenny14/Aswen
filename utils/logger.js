/**
 * utils/logger.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Structured logger with colorized CLI output.
 *
 * Log levels: debug < info < warn < error
 * Supports: console output, file output (logs/), webhook alerts
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const config  = require("../config");

// ─── ANSI Colors ──────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  bgRed:  "\x1b[41m",
  bgGreen:"\x1b[42m",
};

// ─── Log levels ───────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[config.LOG_LEVEL ?? "info"] ?? 1;

// ─── File streams ─────────────────────────────────────────────────────────────

const logsDir       = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const allLog  = fs.createWriteStream(path.join(logsDir, "all.log"),          { flags: "a" });
const arbLog  = fs.createWriteStream(path.join(logsDir, "opportunities.log"), { flags: "a" });

// ─── Logger ───────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function write(level, color, prefix, msg) {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const line = `${C.dim}${ts()}${C.reset} ${color}${prefix}${C.reset} ${msg}`;
  console.log(line);
  allLog.write(`[${ts()}] [${level.toUpperCase()}] ${stripAnsi(msg)}\n`);
}

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Public API ───────────────────────────────────────────────────────────────

const logger = {

  debug(msg) {
    write("debug", C.dim, "[DBG]", msg);
  },

  info(msg) {
    write("info", C.cyan, "[INF]", msg);
  },

  warn(msg) {
    write("warn", C.yellow, "[WRN]", msg);
  },

  error(msg) {
    write("error", C.red + C.bold, "[ERR]", msg);
  },

  // ── Opportunity found ───────────────────────────────────────────────────────

  opportunity({ pair, spread, buyDex, buyPrice, sellDex, sellPrice }) {
    if (LEVELS.info < CURRENT_LEVEL) return;

    const line = [
      `${C.bold}${C.magenta}[OPP]${C.reset}`,
      `${C.bold}${pair}${C.reset}`,
      `spread: ${C.yellow}${spread}%${C.reset}`,
      `buy: ${buyDex}@${buyPrice}`,
      `sell: ${sellDex}@${sellPrice}`,
    ].join("  ");

    console.log(`${C.dim}${ts()}${C.reset} ${line}`);
    arbLog.write(JSON.stringify({ ts: ts(), pair, spread, buyDex, buyPrice, sellDex, sellPrice }) + "\n");
  },

  // ── Simulation result ───────────────────────────────────────────────────────

  simulation(sim) {
    if (LEVELS.info < CURRENT_LEVEL) return;

    const ok    = sim.isExecutable;
    const color = ok ? C.green : C.yellow;
    const icon  = ok ? "✅" : "⚠️ ";

    const lines = [
      `${color}[SIM]${C.reset} ${icon}  ${ok ? "PASS" : "FAIL"}`,
      `  net profit : ${ok ? C.green : C.red}${sim.netProfitUsd?.toFixed(4) ?? "n/a"} USD${C.reset}`,
      `  gas cost   : ${sim.gasCostUsd?.toFixed(6) ?? "n/a"} USD`,
      `  flash fee  : ${sim.flashLoanFee?.toString() ?? "n/a"} wei`,
      `  slippage   : buy=${sim.slippage?.buy?.slippagePercent?.toFixed(2) ?? "?"}% | sell=${sim.slippage?.sell?.slippagePercent?.toFixed(2) ?? "?"}%`,
      `  reason     : ${sim.reason}`,
    ].join("\n");

    console.log(`${C.dim}${ts()}${C.reset}\n${lines}`);
  },

  // ── Decision ────────────────────────────────────────────────────────────────

  decision({ pair, spread, decision, reason, duration, txHash }) {
    const isExec = decision === "EXECUTE";
    const color  = isExec ? C.bgGreen + C.bold : C.dim;
    const icon   = isExec ? "💥" : "⏭ ";

    const line = [
      `${color}[${decision}]${C.reset}`,
      `${C.bold}${pair}${C.reset}`,
      `spread:${C.yellow}${spread}%${C.reset}`,
      `reason: ${reason}`,
      txHash ? `tx: ${C.cyan}${txHash}${C.reset}` : "",
      `(${duration}ms)`,
    ].filter(Boolean).join("  ");

    console.log(`${C.dim}${ts()}${C.reset} ${icon}  ${line}`);

    // Write to opportunity log
    arbLog.write(JSON.stringify({
      ts: ts(), pair, spread, decision, reason, duration, txHash
    }) + "\n");

    // Alert webhook if configured
    if (isExec && config.WEBHOOK_URL) {
      this._sendWebhook({
        text: `💥 ARBITRAGE EXECUTED\nPair: ${pair}\nSpread: ${spread}%\nTX: ${txHash}\nReason: ${reason}`,
      });
    }
  },

  // ── Webhook ─────────────────────────────────────────────────────────────────

  _sendWebhook(payload) {
    if (!config.WEBHOOK_URL) return;

    try {
      const url  = new URL(config.WEBHOOK_URL);
      const body = JSON.stringify(payload);

      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      });

      req.on("error", err => this.warn(`Webhook error: ${err.message}`));
      req.write(body);
      req.end();
    } catch (err) {
      this.warn(`Webhook send failed: ${err.message}`);
    }
  },
};

module.exports = logger;
