/**
 * test/FlashLoanArbitrage.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests run on a local Hardhat fork of Base mainnet.
 * Set RPC_URL_BASE in .env before running.
 *
 * Usage:
 *   npx hardhat test --network hardhat
 */

const { expect }        = require("chai");
const { ethers }        = require("hardhat");
const { loadFixture }   = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─── Base mainnet addresses ───────────────────────────────────────────────────

const AAVE_ADDRESSES_PROVIDER = "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D";
const USDC   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH   = "0x4200000000000000000000000000000000000006";

const USDC_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address, uint256) external returns (bool)",
  "function approve(address, uint256) external returns (bool)",
];

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [owner, attacker] = await ethers.getSigners();

  const Factory = await ethers.getContractFactory("FlashLoanArbitrage");
  const contract = await Factory.deploy(AAVE_ADDRESSES_PROVIDER);
  await contract.waitForDeployment();

  const usdc = new ethers.Contract(USDC, USDC_ABI, owner);

  return { contract, owner, attacker, usdc };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FlashLoanArbitrage", function () {

  describe("Deployment", function () {
    it("Sets the correct owner", async function () {
      const { contract, owner } = await loadFixture(deployFixture);
      expect(await contract.owner()).to.equal(owner.address);
    });

    it("Sets Aave addresses provider", async function () {
      const { contract } = await loadFixture(deployFixture);
      expect(await contract.addressesProvider()).to.equal(AAVE_ADDRESSES_PROVIDER);
    });

    it("Has default max slippage of 100 bps", async function () {
      const { contract } = await loadFixture(deployFixture);
      expect(await contract.maxSlippageBps()).to.equal(100n);
    });
  });

  describe("Access Control", function () {
    it("Non-owner cannot call requestFlashLoan", async function () {
      const { contract, attacker } = await loadFixture(deployFixture);

      await expect(
        contract.connect(attacker).requestFlashLoan(USDC, 1000n, [], 0n)
      ).to.be.revertedWith("FlashLoanArb: not owner");
    });

    it("Non-owner cannot call rescueTokens", async function () {
      const { contract, attacker } = await loadFixture(deployFixture);

      await expect(
        contract.connect(attacker).rescueTokens(USDC, 1n)
      ).to.be.revertedWith("FlashLoanArb: not owner");
    });

    it("Prevents direct executeOperation calls (not from pool)", async function () {
      const { contract, attacker } = await loadFixture(deployFixture);

      await expect(
        contract.connect(attacker).executeOperation(
          USDC, 1000n, 1n, attacker.address, "0x"
        )
      ).to.be.revertedWith("FlashLoanArb: caller not pool");
    });
  });

  describe("Configuration", function () {
    it("Owner can update max slippage", async function () {
      const { contract } = await loadFixture(deployFixture);
      await contract.setMaxSlippage(200n);
      expect(await contract.maxSlippageBps()).to.equal(200n);
    });

    it("Reverts slippage > 1000 bps (10%)", async function () {
      const { contract } = await loadFixture(deployFixture);
      await expect(contract.setMaxSlippage(1001n))
        .to.be.revertedWith("FlashLoanArb: slippage too high");
    });

    it("Owner can update min profit", async function () {
      const { contract } = await loadFixture(deployFixture);
      await contract.setMinProfit(1_000_000n); // 1 USDC
      expect(await contract.minProfitWei()).to.equal(1_000_000n);
    });
  });

  describe("requestFlashLoan validations", function () {
    it("Reverts with < 2 swap steps", async function () {
      const { contract } = await loadFixture(deployFixture);

      await expect(
        contract.requestFlashLoan(USDC, 1000n, [], 0n)
      ).to.be.revertedWith("FlashLoanArb: need at least 2 swaps");
    });

    it("Reverts with zero amount", async function () {
      const { contract } = await loadFixture(deployFixture);

      const fakeStep = {
        dexType:      0,
        router:       ethers.ZeroAddress,
        tokenIn:      USDC,
        tokenOut:     WETH,
        fee:          3000,
        amountOutMin: 0n,
      };

      await expect(
        contract.requestFlashLoan(USDC, 0n, [fakeStep, fakeStep], 0n)
      ).to.be.revertedWith("FlashLoanArb: invalid amount");
    });
  });
});
