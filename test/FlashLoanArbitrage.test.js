/**
 * test/FlashLoanArbitrage.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests run on a local Hardhat fork of Base mainnet.
 * Set RPC_URL_BASE in .env before running.
 *
 * Usage:
 *   npx hardhat test --network hardhat
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─── Base mainnet addresses ───────────────────────────────────────────────────

const AAVE_ADDRESSES_PROVIDER = "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [owner, attacker] = await ethers.getSigners();

  const Factory = await ethers.getContractFactory("FlashLoanArbitrageV2");
  const contract = await Factory.deploy(AAVE_ADDRESSES_PROVIDER);
  await contract.waitForDeployment();

  return { contract, owner, attacker };
}

function buildStep() {
  return {
    dexType:      0,
    router:       ethers.ZeroAddress,
    tokenIn:      USDC,
    tokenOut:     WETH,
    fee:          3000,
    v3Path:       "0x",
    amountOutMin: 0n,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FlashLoanArbitrageV2", function () {
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
      const now = Math.floor(Date.now() / 1000);
      const fakeStep = buildStep();

      await expect(
        contract.connect(attacker).requestFlashLoan(
          USDC,
          1000n,
          [fakeStep, fakeStep],
          0n,
          BigInt(now + 30),
          ethers.ZeroHash
        )
      ).to.be.revertedWith("V2: not owner");
    });

    it("Non-owner cannot call rescue", async function () {
      const { contract, attacker } = await loadFixture(deployFixture);

      await expect(
        contract.connect(attacker).rescue(USDC, 1n)
      ).to.be.revertedWith("V2: not owner");
    });

    it("Prevents direct executeOperation calls (not from pool)", async function () {
      const { contract, attacker } = await loadFixture(deployFixture);

      await expect(
        contract.connect(attacker).executeOperation(
          USDC, 1000n, 1n, attacker.address, "0x"
        )
      ).to.be.revertedWith("V2: not pool");
    });
  });

  describe("Configuration", function () {
    it("Owner can update config", async function () {
      const { contract } = await loadFixture(deployFixture);
      await contract.setConfig(200n, 1_000_000n);
      expect(await contract.maxSlippageBps()).to.equal(200n);
      expect(await contract.minProfitWei()).to.equal(1_000_000n);
    });

    it("Reverts slippage > 1000 bps (10%)", async function () {
      const { contract } = await loadFixture(deployFixture);
      await expect(contract.setConfig(1001n, 0n))
        .to.be.revertedWith("V2: slippage cap exceeded");
    });
  });

  describe("requestFlashLoan validations", function () {
    it("Reverts with < 2 swap steps", async function () {
      const { contract } = await loadFixture(deployFixture);
      const now = Math.floor(Date.now() / 1000);
      const fakeStep = buildStep();

      await expect(
        contract.requestFlashLoan(USDC, 1000n, [fakeStep], 0n, BigInt(now + 30), ethers.ZeroHash)
      ).to.be.revertedWith("V2: need >= 2 steps");
    });

    it("Reverts with zero amount", async function () {
      const { contract } = await loadFixture(deployFixture);
      const now = Math.floor(Date.now() / 1000);
      const fakeStep = buildStep();

      await expect(
        contract.requestFlashLoan(USDC, 0n, [fakeStep, fakeStep], 0n, BigInt(now + 30), ethers.ZeroHash)
      ).to.be.revertedWith("V2: zero amount");
    });

    it("Reverts with expired deadline", async function () {
      const { contract } = await loadFixture(deployFixture);
      const fakeStep = buildStep();

      await expect(
        contract.requestFlashLoan(USDC, 1000n, [fakeStep, fakeStep], 0n, 1n, ethers.ZeroHash)
      ).to.be.revertedWith("V2: deadline passed");
    });
  });
});
