/**
 * mev/sender.js
 * ─────────────────────────────────────────────────────────────────────────────
 * MEV-AWARE TRANSACTION SENDER
 *
 * Supports three submission modes (in priority order):
 *
 *   1. PRIVATE RPC (e.g. Flashbots Protect, BloXroute on Base)
 *      → TX sent to private mempool, invisible to public searchers
 *      → Best MEV protection, slight latency overhead
 *
 *   2. RELAYER (e.g. OpenMEV, custom Base relayer)
 *      → Signed TX sent via HTTP to relayer endpoint
 *      → Relayer submits via private bundle
 *
 *   3. PUBLIC RPC (fallback)
 *      → Standard submission via configured RPC
 *      → Susceptible to frontrunning but always available
 *
 * Dynamic gas strategy:
 *   • Base priority fee = network suggested
 *   • Boost = f(netProfit) — higher profit → pay more gas → faster inclusion
 *   • Capped at MAX_GAS_PRICE_GWEI
 *
 * Transaction signing is done IMMEDIATELY in memory (wallet is preloaded).
 * No user prompts, no keystore decryption at execution time.
 */

"use strict";

const { ethers } = require("ethers");
const https       = require("https");
const config      = require("../config");
const logger      = require("../utils/logger");

// ─── Submission mode ──────────────────────────────────────────────────────────

const MODE = {
  PRIVATE_RPC: "private_rpc",
  RELAYER:     "relayer",
  PUBLIC:      "public",
};

// ─── ABI (request flash loan entry point only) ────────────────────────────────

const CONTRACT_ABI = [
  `function requestFlashLoan(
    address asset,
    uint256 amount,
    tuple(
      uint8   dexType,
      address router,
      address tokenIn,
      address tokenOut,
      uint24  fee,
      bytes   v3Path,
      uint256 amountOutMin
    )[] steps,
    uint256 expectedProfit,
    uint256 deadline,
    bytes32 opportunityId
  ) external`,
];

// ─────────────────────────────────────────────────────────────────────────────

class MevSender {
  /**
   * @param {ethers.Wallet}  wallet    - Pre-loaded signer
   * @param {ethers.Provider} provider - HTTP provider (fallback)
   */
  constructor(wallet, provider) {
    this.wallet   = wallet;
    this.provider = provider;

    // Determine submission mode
    if (config.PRIVATE_RPC_URL) {
      this.mode            = MODE.PRIVATE_RPC;
      this.privateProvider = new ethers.JsonRpcProvider(config.PRIVATE_RPC_URL);
      this.privateWallet   = wallet.connect(this.privateProvider);
      logger.info(`🛡  MEV mode: PRIVATE RPC (${config.PRIVATE_RPC_URL.slice(0, 30)}…)`);
    } else if (config.RELAYER_URL) {
      this.mode = MODE.RELAYER;
      logger.info(`🛡  MEV mode: RELAYER (${config.RELAYER_URL})`);
    } else {
      this.mode = MODE.PUBLIC;
      logger.warn("⚠️  MEV mode: PUBLIC RPC — susceptible to frontrunning");
    }

    // Pre-build contract interface (no re-instantiation at execution time)
    this.contractInterface = new ethers.Interface(CONTRACT_ABI);
    this.contract = new ethers.Contract(config.CONTRACT_ADDRESS, CONTRACT_ABI, this.wallet);
  }

  /**
   * Submit the flash loan transaction.
   *
   * @param {object} opts
   * @param {object} opts.steps          - Swap steps array
   * @param {bigint} opts.amount         - Flash loan borrow amount
   * @param {string} opts.asset          - Asset address
   * @param {bigint} opts.expectedProfit - Expected profit (informational)
   * @param {bigint} opts.netProfitWei   - Net profit (for gas boost calculation)
   * @param {bigint} opts.gasUnits       - Estimated gas units
   * @param {string} opts.opportunityId  - Unique opportunity hash (bytes32)
   * @returns {string} transaction hash
   */
  async send({ steps, amount, asset, expectedProfit, netProfitWei, gasUnits, opportunityId }) {
    // Build gas parameters with profit-based boost
    const gasParams = await this._buildGasParams(netProfitWei);

    // Deadline: current block + 2 blocks forward (~4 seconds on Base)
    // Short deadline reduces sandwich attack window significantly
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 8);

    const txArgs = [
      asset,
      amount,
      steps,
      expectedProfit,
      deadline,
      opportunityId,
    ];

    const txData = {
      ...gasParams,
      gasLimit: gasUnits ? gasUnits * 130n / 100n : 600_000n,
    };

    logger.info(`📤 Submitting via ${this.mode} | gas: ${ethers.formatUnits(gasParams.maxFeePerGas, "gwei")} gwei`);

    switch (this.mode) {
      case MODE.PRIVATE_RPC: return this._sendPrivateRpc(txArgs, txData);
      case MODE.RELAYER:     return this._sendRelayer(txArgs, txData);
      default:               return this._sendPublic(txArgs, txData);
    }
  }

  // ── Submission strategies ─────────────────────────────────────────────────────

  async _sendPublic(args, overrides) {
    const tx = await this.contract.requestFlashLoan(...args, overrides);
    logger.info(`  ⛓  Public TX: ${tx.hash}`);
    const receipt = await tx.wait(1);
    this._assertSuccess(receipt, tx.hash);
    return tx.hash;
  }

  async _sendPrivateRpc(args, overrides) {
    const privateContract = new ethers.Contract(
      config.CONTRACT_ADDRESS,
      CONTRACT_ABI,
      this.privateWallet
    );
    const tx = await privateContract.requestFlashLoan(...args, overrides);
    logger.info(`  🔒 Private TX: ${tx.hash}`);
    // Fall back to public provider for receipt (private RPC may not return it)
    const receipt = await this.provider.waitForTransaction(tx.hash, 1, 30_000);
    this._assertSuccess(receipt, tx.hash);
    return tx.hash;
  }

  async _sendRelayer(args, overrides) {
    // Sign the transaction locally
    const nonce    = await this.provider.getTransactionCount(this.wallet.address, "pending");
    const network  = await this.provider.getNetwork();
    const chainId  = network.chainId;

    const txRequest = {
      to:                  config.CONTRACT_ADDRESS,
      data:                this.contractInterface.encodeFunctionData("requestFlashLoan", args),
      chainId,
      nonce,
      type:                2,
      ...overrides,
    };

    const signedTx  = await this.wallet.signTransaction(txRequest);
    const txHash    = ethers.keccak256(signedTx);

    logger.info(`  📡 Relayer TX: ${txHash}`);

    // Submit to relayer
    await this._postToRelayer({ signedTx, txHash });

    // Wait for on-chain confirmation via public provider
    const receipt = await this.provider.waitForTransaction(txHash, 1, 30_000);
    this._assertSuccess(receipt, txHash);

    return txHash;
  }

  // ── Gas strategy ──────────────────────────────────────────────────────────────

  /**
   * Calculate gas parameters.
   * The priority fee (tip) is boosted proportionally to expected profit:
   *   tip = baseTip + min(profit * BOOST_FACTOR, MAX_BOOST)
   *
   * Higher tip → faster inclusion → less time for frontrunners to react.
   */
  async _buildGasParams(netProfitWei) {
    const feeData = await this.provider.getFeeData();

    const baseFee    = feeData.gasPrice ?? ethers.parseUnits("0.001", "gwei");
    const baseTip    = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.001", "gwei");

    // Profit-proportional tip boost (in wei)
    // Boost = 0.01% of profit converted to ETH-denominated tip
    const profitBoostWei = netProfitWei / 10000n; // 0.01% of profit as tip boost
    const maxBoost       = ethers.parseUnits("0.01", "gwei"); // cap boost at 0.01 gwei
    const tipBoost       = profitBoostWei < maxBoost ? profitBoostWei : maxBoost;
    const boostedTip     = baseTip + tipBoost;

    // Hard cap on max fee
    const maxAllowedFee  = ethers.parseUnits(
      (config.MAX_GAS_PRICE_GWEI ?? 0.05).toString(),
      "gwei"
    );

    const maxFeePerGas = baseFee + boostedTip < maxAllowedFee
      ? baseFee + boostedTip
      : maxAllowedFee;

    return {
      type:                  2,
      maxFeePerGas,
      maxPriorityFeePerGas:  boostedTip < maxAllowedFee ? boostedTip : maxAllowedFee,
    };
  }

  // ── Relayer HTTP ──────────────────────────────────────────────────────────────

  _postToRelayer({ signedTx, txHash }) {
    return new Promise((resolve, reject) => {
      const url  = new URL(config.RELAYER_URL);
      const body = JSON.stringify({ signedTx, txHash });

      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname,
        method:   "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(config.RELAYER_AUTH ? { Authorization: `Bearer ${config.RELAYER_AUTH}` } : {}),
        },
      }, res => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Relayer HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  _assertSuccess(receipt, txHash) {
    if (!receipt || receipt.status !== 1) {
      throw new Error(`TX reverted: ${txHash}`);
    }
    logger.info(`  ✅ Confirmed in block ${receipt.blockNumber}`);
  }
}

module.exports = MevSender;
