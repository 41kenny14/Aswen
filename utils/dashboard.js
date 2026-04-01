/**
 * utils/dashboard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Simple real-time CLI dashboard.
 *
 * Displays:
 *   • Scanner status
 *   • Pool price table
 *   • Last 10 opportunities
 *   • Execution stats (total executed, total profit)
 *
 * Uses ANSI escape codes — works in any real terminal.
 * Launch: node utils/dashboard.js  (separate process)
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const readline = require("readline");

// ─── Config ───────────────────────────────────────────────────────────────────

const LOG_FILE = path.resolve(__dirname, "../logs/opportunities.log");
const REFRESH_MS = 2000;

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const C = {
  clear:  "\x1b[2J\x1b[H",
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  bgBlue: "\x1b[44m",
};

// ─── State ────────────────────────────────────────────────────────────────────

let entries        = [];
let totalExecuted  = 0;
let totalProfitUsd = 0;

// ─── Read log ─────────────────────────────────────────────────────────────────

function readLog() {
  if (!fs.existsSync(LOG_FILE)) return;

  const lines = fs.readFileSync(LOG_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  entries = lines.slice(-200); // keep last 200

  totalExecuted  = entries.filter(e => e.decision === "EXECUTE").length;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function pad(str, len, align = "left") {
  str = String(str ?? "").slice(0, len);
  return align === "right"
    ? str.padStart(len)
    : str.padEnd(len);
}

function render() {
  readLog();

  const lines = [];
  const width = process.stdout.columns || 100;
  const hr    = "─".repeat(width);

  lines.push(C.clear);
  lines.push(`${C.bgBlue}${C.bold}  ⚡ BASE ARBITRAGE SCANNER — LIVE DASHBOARD  ${C.reset}`);
  lines.push(`${C.dim}Refreshing every ${REFRESH_MS / 1000}s  |  ${new Date().toLocaleTimeString()}${C.reset}`);
  lines.push(hr);

  // ── Stats ─────────────────────────────────────────────────────────────────

  lines.push(`\n${C.bold}📊 SESSION STATS${C.reset}`);
  lines.push(
    `  Opportunities scanned : ${C.yellow}${entries.length}${C.reset}` +
    `   |   Executed : ${C.green}${totalExecuted}${C.reset}`
  );
  lines.push(hr);

  // ── Recent opportunities ──────────────────────────────────────────────────

  lines.push(`\n${C.bold}📋 LAST 15 DECISIONS${C.reset}`);

  const header = [
    pad("TIME",     10),
    pad("PAIR",     14),
    pad("SPREAD%",   9, "right"),
    pad("DECISION", 10),
    pad("REASON", width - 49),
  ].join("  ");

  lines.push(`${C.dim}${header}${C.reset}`);
  lines.push("─".repeat(width));

  const recent = entries.filter(e => e.decision).slice(-15).reverse();

  for (const e of recent) {
    const isExec = e.decision === "EXECUTE";
    const color  = isExec ? C.green : C.dim;
    const time   = e.ts ? new Date(e.ts).toLocaleTimeString() : "?";

    const row = [
      pad(time,             10),
      pad(e.pair ?? "?",   14),
      pad((e.spread ?? "?") + "%", 9, "right"),
      pad(e.decision ?? "?",10),
      pad(e.reason ?? "",  width - 49),
    ].join("  ");

    lines.push(`${color}${row}${C.reset}`);
  }

  lines.push(hr);
  lines.push(`\n${C.dim}Press Ctrl+C to exit${C.reset}`);

  process.stdout.write(lines.join("\n"));
}

// ─── Run ─────────────────────────────────────────────────────────────────────

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
  if (key.ctrl && key.name === "c") process.exit(0);
});

render();
setInterval(render, REFRESH_MS);
