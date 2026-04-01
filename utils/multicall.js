/**
 * utils/multicall.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Batch multiple on-chain read calls into a single RPC round-trip
 * using Multicall3 (deployed at the same address on all EVM chains).
 *
 * Multicall3 Base address: 0xcA11bde05977b3631167028862bE2a173976CA11
 */

"use strict";

const { ethers } = require("ethers");

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  `function aggregate3(
    tuple(address target, bool allowFailure, bytes callData)[] calls
  ) public view returns (tuple(bool success, bytes returnData)[] returnData)`,
];

class Multicall {
  constructor(provider) {
    this.contract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  }

  /**
   * Execute multiple view calls in a single request.
   *
   * @param {Array<{target, abi, method, args, ref}>} calls
   * @returns {Array<{result, error, ref}|null>}
   */
  async call(calls) {
    if (calls.length === 0) return [];

    // Encode each call
    const encoded = calls.map(c => {
      const iface = new ethers.Interface(c.abi);
      const callData = iface.encodeFunctionData(c.method, c.args ?? []);
      return {
        target:       c.target,
        allowFailure: true,
        callData,
        _iface:  iface,
        _method: c.method,
        _ref:    c.ref,
      };
    });

    // Submit batch
    let rawResults;
    try {
      rawResults = await this.contract.aggregate3(
        encoded.map(e => ({
          target:       e.target,
          allowFailure: e.allowFailure,
          callData:     e.callData,
        }))
      );
    } catch (err) {
      // If multicall itself fails, return nulls
      console.warn(`Multicall failed: ${err.message}`);
      return calls.map(() => null);
    }

    // Decode each result
    return rawResults.map((raw, i) => {
      const { success, returnData } = raw;
      const enc = encoded[i];

      if (!success || !returnData || returnData === "0x") {
        return { error: "call reverted or empty", ref: enc._ref };
      }

      try {
        const decoded = enc._iface.decodeFunctionResult(enc._method, returnData);
        return { result: decoded, ref: enc._ref };
      } catch (err) {
        return { error: `decode error: ${err.message}`, ref: enc._ref };
      }
    });
  }
}

module.exports = Multicall;
